import type { AppContext } from '../swell-client';
import { createZohoClient, ZohoRateLimitError } from '../zoho/client';
import { stateOf } from './state';
import { OrderBusyError, OrderContinueError, syncOrder } from './sync';

// Counted from the start of the cron run, which is killed at 10s like any
// function; each order run gets what is left.
const TIME_BUDGET_MS = 5500;
const MIN_RUN_MS = 1500;
const BATCH = 5;
const CANDIDATES = 50;
// A claim this old belongs to a run that died (see CLAIM_TTL_MS in ./sync).
const STALE_CLAIM_MS = 2 * 60 * 1000;

/** Retries failed orders whose back-off has passed, oldest first. */
export async function retryFailedOrders(ctx: AppContext, now = Date.now()): Promise<number> {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const settings = await ctx.swell.settings();
  if (settings?.sync?.orders === false) return 0;
  const zoho = await createZohoClient(ctx);
  if (!zoho) return 0;

  const field = (name: string) => `$app.${ctx.appId}.${name}`;
  // Date comparisons on $app fields silently match nothing (the platform
  // does not convert the ISO string), so select candidates by status or a
  // leftover mark, and compare the dates here. There are only ever a few.
  const candidates = await ctx.swell.get('/orders', {
    where: {
      $or: [
        { [field('zoho_status')]: { $in: ['error', 'pending'] } },
        { [field('zoho_claimed_at')]: { $ne: null } },
      ],
    },
    sort: 'date_created asc',
    limit: CANDIDATES,
  });
  const due = (candidates?.results ?? []).filter((order: Record<string, any>) => {
    const state = stateOf(order, ctx.appId);
    const claimed = Date.parse(state.zoho_claimed_at ?? '');
    // A run that was killed while holding the order.
    if (claimed) return now - claimed >= STALE_CLAIM_MS;
    // Failed, or stopped at its time budget, and due again.
    return (state.zoho_status === 'error' || state.zoho_status === 'pending') && Date.parse(state.zoho_retry_at ?? '') <= now;
  });

  let retried = 0;
  for (const order of due.slice(0, BATCH)) {
    const left = deadline - Date.now();
    if (left < MIN_RUN_MS) break;
    try {
      await syncOrder(ctx, zoho, order.id, { budgetMs: left });
    } catch (error) {
      // Out of Zoho API calls: the next run tries again.
      if (error instanceof ZohoRateLimitError) break;
      // Another run is on it right now, or this run used its time budget.
      if (error instanceof OrderBusyError || error instanceof OrderContinueError) continue;
      throw error;
    }
    retried += 1;
  }
  return retried;
}
