import { loadConnection, updateConnection, type Connection, type ProductSyncJob } from '../connection/store';
import { AppError, type AppContext } from '../swell-client';
import { createZohoClient, ZohoRateLimitError } from '../zoho/client';
import { syncProduct } from './sync';
import { isSyncable, type SwellProduct } from './units';

export type { ProductSyncJob };

// Functions time out at 10s; leave room to save progress.
const TIME_BUDGET_MS = 7000;
const PAGE_SIZE = 5;
// Enough for any realistic product; Swell expands 5 child records by default.
const VARIANTS_EXPAND = 'variants:1000';

function jobOf(connection: Connection | null): ProductSyncJob {
  return connection?.product_sync ?? { status: 'idle' };
}

async function saveJob(ctx: AppContext, connection: Connection, job: ProductSyncJob) {
  // $set replaces the whole object, so fields cleared here really clear.
  await updateConnection(ctx.swell, ctx.appId, connection.id, { product_sync: { $set: job } });
}

/** Starts (or restarts) a full catalog sync; the cron job does the work. */
export async function startProductSync(ctx: AppContext): Promise<ProductSyncJob> {
  const connection = await loadConnection(ctx.swell, ctx.appId);
  if (connection?.status !== 'connected' || !connection.organization_id) {
    throw new AppError('not_connected', 'Connect to Zoho and choose an organization first', 409);
  }
  const settings = await ctx.swell.settings();
  if (settings?.sync?.products === false) {
    throw new AppError('sync_disabled', 'Product sync is turned off in the app settings', 409);
  }
  const count = await ctx.swell.get('/products', { limit: 1, fields: 'id' });
  const job: ProductSyncJob = {
    status: 'running',
    cursor: null,
    total: count?.count ?? 0,
    processed: 0,
    created: 0,
    linked: 0,
    failed: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    resume_at: null,
    note: null,
  };
  await saveJob(ctx, connection, job);
  return job;
}

/** One cron tick: syncs products in id order until the time budget runs out. */
export async function runProductSyncBatch(ctx: AppContext, now = Date.now()): Promise<ProductSyncJob | null> {
  const connection = await loadConnection(ctx.swell, ctx.appId);
  const job = jobOf(connection);
  if (!connection || job.status !== 'running') return null;
  if (job.resume_at && Date.parse(job.resume_at) > now) return job;

  const zoho = await createZohoClient(ctx);
  if (!zoho) {
    const stopped = { ...job, status: 'done' as const, finished_at: new Date().toISOString(), note: 'Stopped: Zoho is not connected.' };
    await saveJob(ctx, connection, stopped);
    return stopped;
  }

  const deadline = now + TIME_BUDGET_MS;
  const next: ProductSyncJob = { ...job, resume_at: null, note: null };

  while (Date.now() < deadline) {
    const page = await ctx.swell.get('/products', {
      ...(next.cursor ? { where: { id: { $gt: next.cursor } } } : {}),
      sort: 'id asc',
      limit: PAGE_SIZE,
      expand: [VARIANTS_EXPAND],
    });
    const products: SwellProduct[] = page?.results ?? [];
    if (!products.length) {
      next.status = 'done';
      next.finished_at = new Date().toISOString();
      break;
    }

    for (const product of products) {
      if (Date.now() >= deadline) break;
      if (isSyncable(product)) {
        try {
          const result = await syncProduct(ctx, zoho, product, { deadline });
          next.created = (next.created ?? 0) + result.counts.created;
          next.linked = (next.linked ?? 0) + result.counts.linked;
          next.failed = (next.failed ?? 0) + result.counts.failed;
          // Finish this product next tick; its done units are skipped then.
          if (result.incomplete) break;
        } catch (error) {
          if (!(error instanceof ZohoRateLimitError)) throw error;
          const wait = error.scope === 'day' ? 60 * 60 * 1000 : 60 * 1000;
          next.resume_at = new Date(Date.now() + wait).toISOString();
          next.note =
            error.scope === 'day'
              ? 'Zoho daily API limit reached. Sync continues automatically when Zoho allows it again.'
              : 'Zoho per-minute API limit reached. Sync continues in a minute.';
          await saveJob(ctx, connection, next);
          return next;
        }
      }
      next.cursor = product.id;
      next.processed = (next.processed ?? 0) + 1;
    }
    await saveJob(ctx, connection, next);
  }

  await saveJob(ctx, connection, next);
  return next;
}
