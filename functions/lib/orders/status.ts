import { AppError, type AppContext } from '../swell-client';
import { createZohoClient, ZohoRateLimitError } from '../zoho/client';
import { stateOf, type OrderZohoState } from './state';
import { OrderBusyError, OrderContinueError, syncOrder } from './sync';

export interface OrdersView {
  sync_enabled: boolean;
  synced: number;
  failed: number;
  failures: Array<{ order_id: string; number: string; error: string | null; retry_at: string | null }>;
}

/** What the Zoho page shows about orders. */
export async function getOrdersStatus(ctx: AppContext): Promise<OrdersView> {
  const status = `$app.${ctx.appId}.zoho_status`;
  const [settings, synced, failed] = await Promise.all([
    ctx.swell.settings(),
    ctx.swell.get('/orders', { where: { [status]: 'synced' }, limit: 1, fields: 'id' }),
    // No `fields` here: a projection naming `$app` fails on the platform, and
    // extension fields come back without one.
    ctx.swell.get('/orders', { where: { [status]: 'error' }, sort: 'date_created desc', limit: 10 }),
  ]);
  return {
    sync_enabled: settings?.sync?.orders !== false,
    synced: synced?.count ?? 0,
    failed: failed?.count ?? 0,
    failures: (failed?.results ?? []).map((order: Record<string, any>) => {
      const state = stateOf(order, ctx.appId);
      return {
        order_id: order.id,
        number: order.number,
        error: state.zoho_error ?? null,
        retry_at: state.zoho_retry_at ?? null,
      };
    }),
  };
}

/** "Retry now" from the Zoho page. */
export async function retryOrder(ctx: AppContext, orderId: unknown): Promise<OrderZohoState> {
  if (typeof orderId !== 'string' || !orderId) throw new AppError('invalid_order', 'Missing order id');
  const zoho = await createZohoClient(ctx);
  if (!zoho) throw new AppError('not_connected', 'Connect to Zoho and choose an organization first', 409);
  try {
    const state = await syncOrder(ctx, zoho, orderId);
    if (!state) throw new AppError('not_syncable', 'This order is a draft or canceled, so it is not sent to Zoho');
    return state;
  } catch (error) {
    if (error instanceof ZohoRateLimitError) {
      throw new AppError('rate_limited', 'Zoho API limit reached. The order is retried automatically later.', 429);
    }
    if (error instanceof OrderBusyError) {
      throw new AppError('order_busy', 'This order is being synced right now. Try again in a minute.', 409);
    }
    if (error instanceof OrderContinueError) {
      return { zoho_status: 'pending' };
    }
    throw error;
  }
}
