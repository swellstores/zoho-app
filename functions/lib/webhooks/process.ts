import type { AppContext } from '../swell-client';
import { createZohoClient, ZohoRateLimitError } from '../zoho/client';
import { itemIdsIn, parseWebhookBody, recordOf } from './payload';
import { ShipmentBusyError, syncShipments } from './shipments';
import { refreshStock } from './stock';

// Bare name: this app's collection (see the note in connection/store.ts).
const EVENTS = '/webhook-events';
// Functions are killed at 10s; leave room to save the outcome.
const RUN_BUDGET_MS = 6500;

export interface WebhookEvent {
  id: string;
  topic: 'shipments' | 'stock';
  source?: string | null;
  body?: string | null;
  status?: 'received' | 'processed' | 'ignored' | 'error';
  note?: string | null;
  error?: string | null;
  pending_item_ids?: string[];
  processed_at?: string | null;
}

async function finish(ctx: AppContext, event: WebhookEvent, patch: Partial<WebhookEvent>) {
  await ctx.swell.put(`${EVENTS}/${event.id}`, { processed_at: new Date().toISOString(), ...patch });
}

/**
 * Acts on one stored webhook call: shipments become Swell shipments, stock
 * calls refresh the Swell stock of the items they mention. Outcomes are
 * saved on the event. A Zoho rate limit, or another run busy with the same
 * order, throws so the platform redelivers the event.
 */
export async function processWebhookEvent(
  ctx: AppContext,
  event: WebhookEvent,
  options: { budgetMs?: number } = {},
): Promise<WebhookEvent['status']> {
  if (event.status && event.status !== 'received') return event.status;
  const deadline = Date.now() + (options.budgetMs ?? RUN_BUDGET_MS);
  const zoho = await createZohoClient(ctx);
  if (!zoho) {
    await finish(ctx, event, { status: 'ignored', note: 'Zoho is not connected' });
    return 'ignored';
  }

  try {
    if (event.topic === 'shipments') {
      const outcome = await syncShipments(ctx, zoho, parseWebhookBody(event.body ?? ''));
      await finish(ctx, event, { status: outcome.status, note: outcome.note, error: null });
      return outcome.status;
    }

    const itemIds = event.pending_item_ids?.length ? event.pending_item_ids : itemIdsIn(recordOf(parseWebhookBody(event.body ?? '')));
    if (!itemIds.length) {
      await finish(ctx, event, { status: 'ignored', note: 'The call mentions no items' });
      return 'ignored';
    }
    const result = await refreshStock(ctx, zoho, itemIds, deadline);
    if (result.remaining.length) {
      // Out of time: the rest goes to a new event, which runs on its own.
      await ctx.swell.post(EVENTS, { topic: 'stock', source: event.source ?? null, status: 'received', pending_item_ids: result.remaining });
    }
    const note = [...result.notes, ...(result.remaining.length ? [`${result.remaining.length} item(s) continue in a new event`] : [])].join('; ');
    await finish(ctx, event, { status: 'processed', note: note.slice(0, 1000) || null, error: null, pending_item_ids: [] });
    return 'processed';
  } catch (error) {
    if (error instanceof ZohoRateLimitError || error instanceof ShipmentBusyError) throw error;
    await finish(ctx, event, { status: 'error', error: (error as Error).message.slice(0, 500) });
    return 'error';
  }
}
