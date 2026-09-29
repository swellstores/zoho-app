import type { AppContext } from './lib/swell-client';
import { processWebhookEvent, type WebhookEvent } from './lib/webhooks/process';

export const config: SwellConfig = {
  description: 'Process a webhook call from Zoho: shipments and stock changes',
  model: {
    events: ['webhook-event.created'],
  },
};

export default async function (req: SwellRequest) {
  const ctx: AppContext = { swell: req.swell, appId: req.appId, storeId: req.store.id };
  // The event carries the record as created; the stored body is re-read
  // only if the event data leaves it out.
  const event: WebhookEvent = req.data?.topic ? req.data : await req.swell.get(`/webhook-events/${req.data.id}`);
  if (!event) return;
  await processWebhookEvent(ctx, event);
}
