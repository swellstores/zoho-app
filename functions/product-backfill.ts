import { runProductSyncBatch } from './lib/products/backfill';

export const config: SwellConfig = {
  description: 'Sync the whole catalog to Zoho in batches after the merchant presses Sync products',
  cron: {
    schedule: '* * * * *',
  },
};

export default async function (req: SwellRequest) {
  // Does nothing unless a sync was started from the Zoho page.
  await runProductSyncBatch({ swell: req.swell, appId: req.appId, storeId: req.store.id });
}
