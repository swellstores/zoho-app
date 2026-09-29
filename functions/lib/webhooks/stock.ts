import { stateOf } from '../orders/state';
import type { ItemLink } from '../products/links';
import { setSwellStock, zohoAvailableStock } from '../products/stock';
import { sellableUnits, type SwellProduct } from '../products/units';
import type { AppContext } from '../swell-client';
import type { ZohoClient } from '../zoho/client';

// Bare name: this app's collection (see the note in connection/store.ts).
const LINKS = '/item-links';
const VARIANTS_EXPAND = 'variants:1000';
// Orders older than this are assumed to have reached Zoho or never will.
const IN_FLIGHT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const IN_FLIGHT_ORDERS = 100;

const unitKey = (productId: string, variantId?: string | null) => `${productId}:${variantId ?? ''}`;

export interface StockRefreshResult {
  refreshed: number;
  /** Zoho items not reached before the deadline */
  remaining: string[];
  /** One line per unit, e.g. "ZT-TEE-RED: Zoho 6, held 1, Swell 3 → 5" */
  notes: string[];
}

/**
 * Units Swell has sold that Zoho does not count yet: orders whose sales
 * order is not confirmed or invoiced in Zoho. Swell already took them off
 * its stock, so they are held back from Zoho's number; otherwise a stock
 * change arriving between checkout and the sales order would put them back.
 */
export async function inFlightQuantities(ctx: AppContext, connectedAt: string | null | undefined): Promise<Map<string, number>> {
  const held = new Map<string, number>();
  const settings = await ctx.swell.settings();
  if (settings?.sync?.orders === false) return held;

  const windowStart = new Date(Date.now() - IN_FLIGHT_WINDOW_MS).toISOString();
  const since = connectedAt && connectedAt > windowStart ? connectedAt : windowStart;
  const list = await ctx.swell.get('/orders', {
    where: { date_created: { $gte: since }, canceled: { $ne: true } },
    sort: 'date_created desc',
    limit: IN_FLIGHT_ORDERS,
  });
  for (const order of list?.results ?? []) {
    if (order.draft) continue;
    const state = stateOf(order, ctx.appId);
    if (state.zoho_salesorder_confirmed || state.zoho_invoice_id) continue;
    for (const item of order.items ?? []) {
      const key = unitKey(item.product_id, item.variant_id);
      held.set(key, (held.get(key) ?? 0) + (Number(item.quantity) || 0));
    }
  }
  return held;
}

/**
 * Sets Swell stock to Zoho's available-for-sale stock for the given Zoho
 * items, minus what Swell sold that Zoho does not count yet. Items that are
 * not linked, or whose stock Zoho does not track, are skipped.
 */
export async function refreshStock(
  ctx: AppContext,
  zoho: ZohoClient,
  itemIds: string[],
  deadline: number,
): Promise<StockRefreshResult> {
  if (zoho.itemsApi !== 'inventory' || !itemIds.length) return { refreshed: 0, remaining: [], notes: [] };
  const list = await ctx.swell.get(LINKS, { where: { zoho_item_id: { $in: itemIds }, zoho_tracked: true }, sort: 'id asc', limit: 1000 });
  const links: ItemLink[] = list?.results ?? [];
  if (!links.length) return { refreshed: 0, remaining: [], notes: ['No linked item that Zoho tracks'] };

  const held = await inFlightQuantities(ctx, zoho.connection.date_connected);
  const products = new Map<string, SwellProduct | null>();
  const done = new Set<string>();
  const notes: string[] = [];
  let refreshed = 0;
  for (const [index, link] of links.entries()) {
    // At least one unit per run, so a continuation always makes progress.
    if (index > 0 && Date.now() >= deadline) {
      return { refreshed, remaining: [...new Set(links.slice(index).map((l) => String(l.zoho_item_id)))], notes };
    }
    // The ledger adjusts by difference: a unit must be set once per run.
    const key = unitKey(link.product_id, link.variant_id);
    if (done.has(key)) continue;
    done.add(key);

    const detail = await zoho.request('inventory', 'GET', `/items/${link.zoho_item_id}`);
    const available = zohoAvailableStock(detail?.item ?? {});
    if (available === null) continue;

    if (!products.has(link.product_id)) {
      products.set(link.product_id, await ctx.swell.get(`/products/${link.product_id}`, { expand: [VARIANTS_EXPAND] }));
    }
    const product = products.get(link.product_id);
    const unit = product ? sellableUnits(product).find((u) => u.variantId === (link.variant_id ?? null)) : undefined;
    if (!unit) continue;

    const hold = held.get(key) ?? 0;
    const target = available - hold;
    await setSwellStock(ctx.swell, unit, target);
    notes.push(`${unit.sku ?? unit.name}: Zoho ${available}${hold ? `, held ${hold}` : ''}, Swell ${unit.stockLevel} → ${Math.round(target)}`);
    refreshed += 1;
  }
  return { refreshed, remaining: [], notes };
}
