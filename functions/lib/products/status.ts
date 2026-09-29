import { loadConnection, type ProductSyncJob } from '../connection/store';
import type { AppContext } from '../swell-client';
import { countUntrackedInSwell, recentFailures } from './links';

export interface ProductsView {
  sync_enabled: boolean;
  job: ProductSyncJob;
  failures: Array<{ name: string | null; sku: string | null; error: string | null; product_id: string }>;
  untracked_in_swell: number;
}

/** What the Zoho page shows about products. */
export async function getProductsStatus(ctx: AppContext): Promise<ProductsView> {
  const [connection, settings, failures, untracked] = await Promise.all([
    loadConnection(ctx.swell, ctx.appId),
    ctx.swell.settings(),
    recentFailures(ctx.swell),
    countUntrackedInSwell(ctx.swell),
  ]);
  const job = connection?.product_sync ?? { status: 'idle' as const };
  return {
    sync_enabled: settings?.sync?.products !== false,
    // The cursor is internal.
    job: { ...job, cursor: undefined },
    failures: failures.map((link) => ({
      name: link.name ?? null,
      sku: link.sku ?? null,
      error: link.error ?? null,
      product_id: link.product_id,
    })),
    untracked_in_swell: untracked,
  };
}
