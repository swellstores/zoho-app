import type { AppContext } from '../swell-client';
import { ZohoRateLimitError, type ZohoClient } from '../zoho/client';
import { findLink, loadLinks, saveLink, type ItemLink } from './links';
import { isZohoTracked, setSwellStock, zohoAvailableStock } from './stock';
import { sellableUnits, type SellableUnit, type SwellProduct } from './units';

export type UnitOutcome = 'created' | 'linked' | 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface ProductSyncResult {
  counts: Record<UnitOutcome, number>;
  /** Stopped at the deadline before every unit was handled */
  incomplete: boolean;
}

export interface ProductSyncOptions {
  /** Only this variant (variant events) */
  variantId?: string | null;
  /**
   * Fields changed in Swell, from an `updated` event. Absent for backfill
   * and `created` events: those link or create, and never overwrite items
   * that already exist in Zoho.
   */
  changedFields?: string[];
  /** Epoch ms; units left when it passes are handled by the next run */
  deadline?: number;
}

function emptyCounts(): Record<UnitOutcome, number> {
  return { created: 0, linked: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
}

async function findZohoItem(zoho: ZohoClient, unit: SellableUnit): Promise<Record<string, any> | null> {
  // SKU is the identifier shared by every sales channel. Without one, only
  // an exact, unambiguous name match is safe to link.
  const query = unit.sku ? { sku: unit.sku } : { name: unit.name };
  const body = await zoho.request(zoho.itemsApi, 'GET', '/items', { query });
  const matches = (body?.items ?? []).filter((item: Record<string, any>) =>
    unit.sku ? item.sku === unit.sku : item.name === unit.name,
  );
  return matches.length === 1 ? matches[0] : null;
}

function itemFields(unit: SellableUnit): Record<string, unknown> {
  return {
    name: unit.name,
    rate: unit.price,
    ...(unit.sku ? { sku: unit.sku } : {}),
  };
}

function newItemPayload(zoho: ZohoClient, unit: SellableUnit): Record<string, unknown> {
  const base = { ...itemFields(unit), product_type: 'goods' };
  if (zoho.itemsApi !== 'inventory' || !unit.tracked) {
    // Books-only orgs, and products Swell does not track: no stock in Zoho.
    return { ...base, item_type: 'sales' };
  }
  // Zoho values opening stock and rejects a zero rate. Swell keeps no cost
  // price (the legacy `cost` field is unused), so stock is valued at the
  // regular price; a free product starts with no opening stock.
  const opening = Math.max(0, Math.floor(unit.stockLevel));
  return {
    ...base,
    item_type: 'inventory',
    ...(opening > 0 && unit.price > 0 ? { initial_stock: opening, initial_stock_rate: unit.price } : {}),
  };
}

async function linkExisting(
  ctx: AppContext,
  zoho: ZohoClient,
  unit: SellableUnit,
  link: ItemLink | undefined,
  item: Record<string, any>,
) {
  const tracked = zoho.itemsApi === 'inventory' && isZohoTracked(item);
  if (tracked) {
    // Zoho owns stock: the Swell level is replaced with Zoho's.
    const detail = await zoho.request('inventory', 'GET', `/items/${item.item_id}`);
    const available = zohoAvailableStock(detail?.item ?? {});
    if (available !== null) await setSwellStock(ctx.swell, unit, available);
  }
  await saveLink(ctx.swell, link, {
    product_id: unit.productId,
    variant_id: unit.variantId,
    name: unit.name,
    sku: unit.sku,
    zoho_item_id: String(item.item_id),
    zoho_tracked: tracked,
    swell_tracked: unit.tracked,
    status: 'synced',
    error: null,
  });
}

async function syncUnit(
  ctx: AppContext,
  zoho: ZohoClient,
  unit: SellableUnit,
  link: ItemLink | undefined,
  changedFields: string[] | undefined,
): Promise<UnitOutcome> {
  if (link?.zoho_item_id) {
    if (!changedFields) return 'unchanged';
    await zoho.request(zoho.itemsApi, 'PUT', `/items/${link.zoho_item_id}`, { body: itemFields(unit) });
    await saveLink(ctx.swell, link, {
      name: unit.name,
      sku: unit.sku,
      swell_tracked: unit.tracked,
      status: 'synced',
      error: null,
    });
    return 'updated';
  }

  const existing = await findZohoItem(zoho, unit);
  if (existing) {
    await linkExisting(ctx, zoho, unit, link, existing);
    return 'linked';
  }
  if (!unit.active) return 'skipped';

  const created = await zoho.request(zoho.itemsApi, 'POST', '/items', { body: newItemPayload(zoho, unit) });
  const item = created?.item ?? {};
  await saveLink(ctx.swell, link, {
    product_id: unit.productId,
    variant_id: unit.variantId,
    name: unit.name,
    sku: unit.sku,
    zoho_item_id: String(item.item_id),
    zoho_tracked: zoho.itemsApi === 'inventory' && isZohoTracked(item),
    swell_tracked: unit.tracked,
    status: 'synced',
    error: null,
  });
  return 'created';
}

/**
 * Links, creates or updates the Zoho items of one product. A failing unit is
 * recorded on its link and does not stop the others; hitting a Zoho rate
 * limit stops everything so the caller can pause.
 */
export async function syncProduct(
  ctx: AppContext,
  zoho: ZohoClient,
  product: SwellProduct,
  options: ProductSyncOptions = {},
): Promise<ProductSyncResult> {
  const counts = emptyCounts();
  const links = await loadLinks(ctx.swell, product.id);
  const units = sellableUnits(product).filter(
    (unit) => options.variantId === undefined || unit.variantId === options.variantId,
  );

  for (const unit of units) {
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      return { counts, incomplete: true };
    }
    const link = findLink(links, unit.variantId);
    try {
      counts[await syncUnit(ctx, zoho, unit, link, options.changedFields)] += 1;
    } catch (error) {
      if (error instanceof ZohoRateLimitError) throw error;
      counts.failed += 1;
      await saveLink(ctx.swell, link, {
        product_id: unit.productId,
        variant_id: unit.variantId,
        name: unit.name,
        sku: unit.sku,
        status: 'error',
        error: (error as Error).message.slice(0, 500),
      });
    }
  }
  return { counts, incomplete: false };
}
