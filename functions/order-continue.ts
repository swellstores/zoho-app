import { awaitsContinuation, continueOrder } from './lib/orders/continue';
import type { AppContext } from './lib/swell-client';
import { createZohoClient } from './lib/zoho/client';

export const config: SwellConfig = {
  description: "Continue an order's Zoho sync right after a run stops at its time budget",
  model: {
    events: ['order.updated'],
    conditions: { '$app.zoho.zoho_status': 'pending' },
  },
};

export default async function (req: SwellRequest) {
  // The condition narrows most updates; this check decides, using the
  // record in the event, so no API call is made for other updates.
  if (!awaitsContinuation(req.data, req.appId)) return;
  const settings = await req.swell.settings();
  if (settings?.sync?.orders === false) return;

  const ctx: AppContext = { swell: req.swell, appId: req.appId, storeId: req.store.id };
  const zoho = await createZohoClient(ctx);
  if (!zoho) return;
  await continueOrder(ctx, zoho, req.data.id);
}
