import { reconcileSwellAdjustment } from './lib/products/swell-adjustments';
import type { AppContext } from './lib/swell-client';
import { createZohoClient } from './lib/zoho/client';

export const config: SwellConfig = {
  description: "Put Zoho's stock back when Swell stock changes outside orders",
  model: {
    events: ['product.stock_adjusted'],
  },
};

export default async function (req: SwellRequest) {
  const settings = await req.swell.settings();
  if (settings?.sync?.products === false) return;

  const ctx: AppContext = { swell: req.swell, appId: req.appId, storeId: req.store.id };
  const zoho = await createZohoClient(ctx);
  if (zoho?.itemsApi !== 'inventory') return;
  // req.data is the product; the adjusted variant is in the event's own data.
  const variantId = req.data.$event?.data?.variant_id ?? null;
  const outcome = await reconcileSwellAdjustment(ctx, zoho, req.data.id, variantId);
  console.log(JSON.stringify({ stock_adjusted: req.data.id, variant: variantId, outcome }));
}
