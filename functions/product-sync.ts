import { removeLinks } from './lib/products/links';
import { syncProduct } from './lib/products/sync';
import { isSyncable, type SwellProduct } from './lib/products/units';
import type { AppContext } from './lib/swell-client';
import { createZohoClient } from './lib/zoho/client';

export const config: SwellConfig = {
  description: 'Create, link or update the Zoho item when a product or variant changes',
  model: {
    events: [
      'product.created',
      'product.updated',
      'product.deleted',
      'product.variant.created',
      'product.variant.updated',
      'product.variant.deleted',
    ],
  },
};

// Only these changes matter to Zoho items. Stock changes (including the ones
// this app writes from Zoho) also fire `updated` and must be ignored. Prices
// live in purchase_options; `price` is its legacy mirror.
const PRODUCT_FIELDS = new Set(['name', 'sku', 'price', 'purchase_options', 'active', 'stock_tracking']);
const VARIANT_FIELDS = new Set(['name', 'sku', 'price', 'purchase_options', 'active', 'archived']);

export default async function (req: SwellRequest) {
  const event = req.data.$event;
  const type = event?.type ?? '';
  const isVariant = type.startsWith('product.variant.');

  // A deleted product or variant only drops its links; its Zoho item stays.
  if (type.endsWith('.deleted')) {
    const productId = isVariant ? req.data.parent_id : req.data.id;
    if (productId) await removeLinks(req.swell, productId, isVariant ? req.data.id : null);
    return;
  }

  let changedFields: string[] | undefined;
  if (type.endsWith('.updated')) {
    changedFields = Object.keys(event?.data ?? {});
    const relevant = isVariant ? VARIANT_FIELDS : PRODUCT_FIELDS;
    if (!changedFields.some((field) => relevant.has(field))) return;
  }

  const settings = await req.swell.settings();
  if (settings?.sync?.products === false) return;

  const ctx: AppContext = { swell: req.swell, appId: req.appId, storeId: req.store.id };
  const zoho = await createZohoClient(ctx);
  if (!zoho) return;

  const productId = isVariant ? req.data.parent_id : req.data.id;
  const product: SwellProduct | null = await req.swell.get(`/products/${productId}`, {
    expand: ['variants:1000'],
  });
  if (!product || !isSyncable(product)) return;

  // A Zoho rate limit throws, so the platform retries this event later.
  await syncProduct(ctx, zoho, product, {
    variantId: isVariant ? req.data.id : undefined,
    changedFields,
  });
}
