import type { AppContext } from './lib/swell-client';
import { pruneEvents, retryStuckEvents } from './lib/webhooks/maintenance';

export const config: SwellConfig = {
  description: 'Retry unprocessed Zoho webhook calls and delete old ones',
  cron: {
    schedule: '*/10 * * * *',
  },
};

export default async function (req: SwellRequest) {
  const ctx: AppContext = { swell: req.swell, appId: req.appId, storeId: req.store.id };
  await retryStuckEvents(ctx);
  await pruneEvents(ctx);
}
