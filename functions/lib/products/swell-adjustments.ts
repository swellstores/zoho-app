import type { AppContext } from '../swell-client';
import { refreshStock } from '../webhooks/stock';
import type { ZohoClient } from '../zoho/client';
import { ZOHO_STOCK_MESSAGE } from './stock';

// Ledger reasons that Zoho already reflects: a Swell sale becomes a sales
// order, and a canceled order voids it.
const FOLLOWS_ZOHO = ['sold', 'canceled'];
// Functions are killed at 10s.
const RUN_BUDGET_MS = 5000;

const LINKS = '/item-links';

/**
 * Zoho owns stock, so a Swell stock change made outside orders (a return put
 * back to stock, a manual adjustment in the dashboard) is replaced with
 * Zoho's level. Returned goods count again once Zoho receives them.
 * Returns what was done, for logs and tests.
 */
export async function reconcileSwellAdjustment(
  ctx: AppContext,
  zoho: ZohoClient,
  productId: string,
  variantId: string | null,
): Promise<string> {
  const ledger = await ctx.swell.get('/products:stock', {
    where: { parent_id: productId, variant_id: variantId },
    sort: 'date_created desc',
    limit: 1,
  });
  const entry = ledger?.results?.[0];
  if (!entry) return 'no ledger entry';
  if (FOLLOWS_ZOHO.includes(entry.reason)) return `follows Zoho (${entry.reason})`;
  if (entry.reason_message === ZOHO_STOCK_MESSAGE) return 'made by this app';

  const links = await ctx.swell.get(LINKS, { where: { product_id: productId, variant_id: variantId, zoho_tracked: true }, limit: 1 });
  const itemId = links?.results?.[0]?.zoho_item_id;
  if (!itemId) return 'not tracked in Zoho';
  const result = await refreshStock(ctx, zoho, [String(itemId)], Date.now() + RUN_BUDGET_MS);
  return `reset from Zoho after "${entry.reason}": ${result.notes.join('; ')}`;
}
