import { loadConnection, updateConnection, type StockCatchup } from '../connection/store';
import type { ItemLink } from '../products/links';
import type { AppContext } from '../swell-client';
import { createZohoClient, ZohoRateLimitError, type ZohoClient } from '../zoho/client';
import { refreshStock } from './stock';

// Bare name: this app's collection (see the note in connection/store.ts).
const LINKS = '/item-links';
const BATCH = 10;

/**
 * Refreshes one page of links and moves the cursor past what was reached.
 * Returns false when the deadline stopped it.
 */
async function refreshPage(ctx: AppContext, zoho: ZohoClient, links: ItemLink[], job: StockCatchup, deadline: number): Promise<boolean> {
  try {
    const result = await refreshStock(ctx, zoho, links.map((link) => String(link.zoho_item_id)), deadline);
    job.refreshed = (job.refreshed ?? 0) + result.refreshed;
    // Links are refreshed in id order, and always at least the first one:
    // the cursor stops before the first link not reached, and always moves.
    const left = new Set(result.remaining);
    const stop = links.findIndex((link) => left.has(String(link.zoho_item_id)));
    job.cursor = String(links[stop === -1 ? links.length - 1 : Math.max(stop - 1, 0)].id);
    return stop === -1;
  } catch (error) {
    if (error instanceof ZohoRateLimitError) throw error;
  }
  // One item failed, e.g. deleted in Zoho: go one by one and skip what fails.
  for (const link of links) {
    if (Date.now() >= deadline) return false;
    try {
      job.refreshed = (job.refreshed ?? 0) + (await refreshStock(ctx, zoho, [String(link.zoho_item_id)], deadline)).refreshed;
    } catch (error) {
      if (error instanceof ZohoRateLimitError) throw error;
      console.log(JSON.stringify({ stock_catchup_skipped: link.zoho_item_id, error: (error as Error).message }));
    }
    job.cursor = String(link.id);
  }
  return true;
}

/**
 * One cron tick of the stock refresh that follows a webhook outage: every
 * linked item Zoho tracks, in id order, until the deadline. Returns the job,
 * or null when none is running.
 */
export async function runStockCatchup(ctx: AppContext, deadline: number): Promise<StockCatchup | null> {
  const connection = await loadConnection(ctx.swell, ctx.appId);
  const job = connection?.stock_catchup;
  if (!connection || job?.status !== 'running') return null;

  const next: StockCatchup = { ...job };
  const finish = () => Object.assign(next, { status: 'done', finished_at: new Date().toISOString() });
  const zoho = await createZohoClient(ctx);
  if (!zoho || zoho.itemsApi !== 'inventory') {
    finish();
  } else {
    try {
      // At least one page per tick, so the refresh always moves on.
      do {
        const page = await ctx.swell.get(LINKS, {
          where: { zoho_tracked: true, ...(next.cursor ? { id: { $gt: next.cursor } } : {}) },
          sort: 'id asc',
          limit: BATCH,
        });
        const links: ItemLink[] = page?.results ?? [];
        if (!links.length) {
          finish();
          break;
        }
        if (!(await refreshPage(ctx, zoho, links, next, deadline))) break;
      } while (Date.now() < deadline);
    } catch (error) {
      // Picked up again on the next tick.
      if (!(error instanceof ZohoRateLimitError)) throw error;
    }
  }
  await updateConnection(ctx.swell, ctx.appId, connection.id, { stock_catchup: { $set: next } });
  return next;
}
