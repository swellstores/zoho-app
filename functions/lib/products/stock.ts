import type { SwellClient } from '../swell-client';
import type { SellableUnit } from './units';

/** Marks the stock ledger entries this app writes. */
export const ZOHO_STOCK_MESSAGE = 'Stock level from Zoho Inventory';

// A run corrects itself at most this many times.
const MAX_CORRECTIONS = 2;

/**
 * Brings a Swell product or variant to `target` units. `stock_level` is
 * read-only in Swell; stock only moves through the adjustment ledger, by
 * difference. Two runs for the same item (Zoho sends one call per rule, and
 * they arrive together) can start from the same level and both apply their
 * difference. The ledger answers with the level after each entry, so a run
 * that ends away from its target adjusts again.
 */
export async function setSwellStock(swell: SwellClient, unit: SellableUnit, target: number): Promise<void> {
  const goal = Math.round(target);
  let level = Math.round(unit.stockLevel);
  for (let attempt = 0; attempt <= MAX_CORRECTIONS && level !== goal; attempt++) {
    const delta = goal - level;
    const entry = await swell.post('/products:stock', {
      parent_id: unit.productId,
      ...(unit.variantId ? { variant_id: unit.variantId } : {}),
      quantity: delta,
      reason: delta > 0 ? 'received' : 'missing',
      reason_message: ZOHO_STOCK_MESSAGE,
    });
    const after = Number(entry?.level);
    if (entry?.level === undefined || entry?.level === null || !Number.isFinite(after)) return;
    level = Math.round(after);
  }
}

/** Stock Zoho considers sellable. Field names differ between Zoho responses. */
export function zohoAvailableStock(item: Record<string, any>): number | null {
  for (const key of [
    'actual_available_for_sale_stock',
    'available_for_sale_stock',
    'actual_available_stock',
    'available_stock',
    'stock_on_hand',
  ]) {
    const value = Number(item[key]);
    if (item[key] !== undefined && item[key] !== '' && Number.isFinite(value)) return value;
  }
  return null;
}

export function isZohoTracked(item: Record<string, any>): boolean {
  return item.item_type === 'inventory' || item.track_inventory === true;
}
