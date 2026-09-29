import { runProductSyncBatch } from './lib/products/backfill';
import type { AppContext } from './lib/swell-client';
import { runStockCatchup } from './lib/webhooks/catchup';
import { repairZohoWebhooks } from './lib/webhooks/repair';

export const config: SwellConfig = {
  description:
    'Background work each minute: the catalog sync started from the Zoho page, updating the Zoho webhooks after a new install, and the stock refresh that follows',
  cron: {
    schedule: '* * * * *',
  },
};

// Functions time out at 10s; leave room to save progress.
const BUDGET_MS = 7000;

export default async function (req: SwellRequest) {
  const start = Date.now();
  const ctx: AppContext = { swell: req.swell, appId: req.appId, storeId: req.store.id, publicKey: req.publicKey };
  // One read of the connection, unless the install key changed or a day passed.
  const repaired = await repairZohoWebhooks(ctx, start);
  // Updating webhooks takes most of a run; the rest waits for the next minute.
  if (repaired) return;
  // Does nothing unless a sync was started from the Zoho page.
  const job = await runProductSyncBatch(ctx, start);
  if (job?.status !== 'running') await runStockCatchup(ctx, start + BUDGET_MS);
}
