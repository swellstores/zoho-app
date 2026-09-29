import { OrderContinueError, syncOrder, type OrderEvent } from './lib/orders/sync';
import type { AppContext } from './lib/swell-client';
import { createZohoClient } from './lib/zoho/client';

export const config: SwellConfig = {
  description: 'Send the order to Zoho: sales order when placed, invoice and payment when paid, void or credit note when canceled or refunded',
  model: {
    events: ['order.submitted', 'order.paid', 'order.canceled', 'order.refunded'],
  },
};

export default async function (req: SwellRequest) {
  const settings = await req.swell.settings();
  if (settings?.sync?.orders === false) return;

  const ctx: AppContext = { swell: req.swell, appId: req.appId, storeId: req.store.id };
  const zoho = await createZohoClient(ctx);
  if (!zoho) return;

  // Failures are recorded on the order and retried by order-retry. A run
  // that stops at its time budget is continued by order-continue. A Zoho
  // rate limit, or another run still busy with this order, throws so the
  // platform redelivers the event.
  const event = String(req.data.$event?.type ?? '').replace(/^order\./, '') as OrderEvent;
  try {
    await syncOrder(ctx, zoho, req.data.id, { event });
  } catch (error) {
    if (error instanceof OrderContinueError) return;
    throw error;
  }
}
