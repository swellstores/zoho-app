import type { AppContext } from '../swell-client';
import { ZohoRateLimitError } from '../zoho/client';
import { processWebhookEvent, type WebhookEvent } from './process';
import { ShipmentBusyError } from './shipments';

const EVENTS = '/webhook-events';
// An event still `received` this long after it arrived was never handled:
// its run was killed, or the platform stopped redelivering it.
const STUCK_AFTER_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 25;
// One event run takes at most its own budget (see RUN_BUDGET_MS in ./process).
const RETRY_BUDGET_MS = 2000;

/** Handles webhook calls that were stored but never processed. */
export async function retryStuckEvents(ctx: AppContext, now = Date.now()): Promise<number> {
  const list = await ctx.swell.get(EVENTS, {
    where: { status: 'received', date_created: { $lt: new Date(now - STUCK_AFTER_MS).toISOString() } },
    sort: 'date_created asc',
    limit: 5,
  });
  const deadline = now + RETRY_BUDGET_MS;
  let handled = 0;
  for (const event of (list?.results ?? []) as Array<WebhookEvent & { attempts?: number }>) {
    if (Date.now() > deadline) break;
    const attempts = (event.attempts ?? 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      await ctx.swell.put(`${EVENTS}/${event.id}`, {
        status: 'error',
        error: `Not processed after ${MAX_ATTEMPTS} attempts`,
        processed_at: new Date().toISOString(),
      });
      continue;
    }
    await ctx.swell.put(`${EVENTS}/${event.id}`, { attempts });
    try {
      await processWebhookEvent(ctx, event);
    } catch (error) {
      if (error instanceof ZohoRateLimitError) break;
      if (error instanceof ShipmentBusyError) continue;
      throw error;
    }
    handled += 1;
  }
  return handled;
}

/** Deletes handled webhook calls older than two weeks. */
export async function pruneEvents(ctx: AppContext, now = Date.now()): Promise<number> {
  const list = await ctx.swell.get(EVENTS, {
    where: { status: { $in: ['processed', 'ignored', 'error'] }, date_created: { $lt: new Date(now - KEEP_MS).toISOString() } },
    limit: PRUNE_BATCH,
  });
  const old: WebhookEvent[] = list?.results ?? [];
  for (const event of old) await ctx.swell.delete(`${EVENTS}/${event.id}`);
  return old.length;
}
