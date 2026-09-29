import { findLink, loadLinks } from '../products/links';
import { syncProduct } from '../products/sync';
import { isSyncable } from '../products/units';
import { AppError, type AppContext } from '../swell-client';
import type { ZohoClient } from '../zoho/client';
import { taxForRate, type ZohoTax } from '../zoho/taxes';

export interface SwellOrderItem {
  id: string;
  product_id: string;
  variant_id?: string | null;
  product_name?: string;
  variant_name?: string;
  quantity: number;
  price: number;
  discount_total?: number;
  taxes?: Array<{ id: string; amount?: number }>;
}

export interface SwellOrder {
  id: string;
  number: string;
  account_id: string;
  date_created: string;
  currency?: string;
  draft?: boolean;
  canceled?: boolean;
  paid?: boolean;
  refunded?: boolean;
  refund_total?: number;
  items?: SwellOrderItem[];
  taxes?: Array<{ id: string; name?: string; rate?: number; shipping?: boolean }>;
  item_tax_included?: boolean;
  shipment_total?: number;
  shipment_tax?: number;
  payment_total?: number;
  grand_total?: number;
  billing?: Record<string, any>;
  shipping?: Record<string, any>;
}

/** Order date in Zoho's yyyy-mm-dd format. */
export function zohoDate(value: string | undefined): string {
  return (value ? new Date(value) : new Date()).toISOString().slice(0, 10);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function taxRateOf(order: SwellOrder, taxId: string): number {
  const tax = order.taxes?.find((t) => t.id === taxId);
  if (typeof tax?.rate !== 'number') {
    throw new AppError('unknown_tax', `The order uses a tax (${taxId}) without a rate`);
  }
  return tax.rate;
}

function lineTax(order: SwellOrder, item: SwellOrderItem, taxes: ZohoTax[]): string | undefined {
  const applied = (item.taxes ?? []).filter((t) => (t.amount ?? 0) !== 0);
  if (!applied.length) return undefined;
  if (applied.length > 1) {
    throw new AppError(
      'multiple_taxes',
      `“${item.product_name}” has ${applied.length} taxes. Lines with more than one tax are not supported yet.`,
    );
  }
  return taxForRate(taxes, taxRateOf(order, applied[0].id)).tax_id;
}

/** Zoho item id for an order line, linking or creating the item on the way. */
async function zohoItemId(ctx: AppContext, zoho: ZohoClient, item: SwellOrderItem): Promise<string | null> {
  const variantId = item.variant_id ?? null;
  let link = findLink(await loadLinks(ctx.swell, item.product_id), variantId);
  if (link?.zoho_item_id) return link.zoho_item_id;

  const product = await ctx.swell.get(`/products/${item.product_id}`, { expand: ['variants:1000'] });
  if (!product || !isSyncable(product)) return null;
  await syncProduct(ctx, zoho, product, { variantId });
  link = findLink(await loadLinks(ctx.swell, item.product_id), variantId);
  return link?.zoho_item_id ?? null;
}

export interface ZohoOrderDocument {
  reference_number: string;
  date: string;
  line_items: Array<Record<string, unknown>>;
  discount_type: 'item_level';
  is_discount_before_tax: true;
  is_inclusive_tax: boolean;
  shipping_charge?: number;
  shipping_charge_tax_id?: string;
  notes: string;
}

/**
 * The fields a Zoho sales order or invoice needs for this order: one line
 * per order line (items linked or created as needed; bundles and gift cards
 * become plain text lines), line discounts, taxes matched by rate, shipping.
 */
export async function buildOrderDocument(
  ctx: AppContext,
  zoho: ZohoClient,
  order: SwellOrder,
  taxes: ZohoTax[],
): Promise<ZohoOrderDocument> {
  const lineItems: Array<Record<string, unknown>> = [];
  for (const item of order.items ?? []) {
    const itemId = await zohoItemId(ctx, zoho, item);
    const taxId = lineTax(order, item, taxes);
    const name = [item.product_name, item.variant_name].filter(Boolean).join(' — ');
    lineItems.push({
      ...(itemId ? { item_id: itemId } : { name: name || 'Item' }),
      rate: item.price,
      quantity: item.quantity,
      ...(item.discount_total ? { discount: round(item.discount_total) } : {}),
      ...(taxId ? { tax_id: taxId } : {}),
    });
  }

  let shippingTaxId: string | undefined;
  if ((order.shipment_tax ?? 0) !== 0) {
    const shippingTax = order.taxes?.find((t) => t.shipping && typeof t.rate === 'number');
    if (!shippingTax) throw new AppError('unknown_tax', 'The order has shipping tax without a rate');
    shippingTaxId = taxForRate(taxes, shippingTax.rate!).tax_id;
  }

  return {
    reference_number: order.number,
    date: zohoDate(order.date_created),
    line_items: lineItems,
    discount_type: 'item_level',
    is_discount_before_tax: true,
    is_inclusive_tax: Boolean(order.item_tax_included),
    ...(order.shipment_total ? { shipping_charge: round(order.shipment_total) } : {}),
    ...(shippingTaxId ? { shipping_charge_tax_id: shippingTaxId } : {}),
    notes: `Swell order #${order.number}`,
  };
}
