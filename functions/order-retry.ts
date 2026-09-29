import { retryFailedOrders } from './lib/orders/retry';

export const config: SwellConfig = {
  description: 'Retry orders whose Zoho sync failed',
  cron: {
    schedule: '*/10 * * * *',
  },
};

export default async function (req: SwellRequest) {
  await retryFailedOrders({ swell: req.swell, appId: req.appId, storeId: req.store.id });
}
