import type { SwellClient } from '../swell-client';

export interface ItemLink {
  id: string;
  product_id: string;
  variant_id?: string | null;
  name?: string;
  sku?: string | null;
  zoho_item_id?: string | null;
  zoho_tracked?: boolean;
  swell_tracked?: boolean;
  status?: 'synced' | 'error' | 'skipped';
  error?: string | null;
  date_synced?: string;
}

// The bare collection name resolves to this app's collection and needs no
// permission (see the note in connection/store.ts).
const COLLECTION = '/item-links';

export async function loadLinks(swell: SwellClient, productId: string): Promise<ItemLink[]> {
  const list = await swell.get(COLLECTION, { where: { product_id: productId }, limit: 1000 });
  return list?.results ?? [];
}

export function findLink(links: ItemLink[], variantId: string | null): ItemLink | undefined {
  return links.find((link) => (link.variant_id ?? null) === variantId);
}

export async function saveLink(
  swell: SwellClient,
  existing: ItemLink | undefined,
  data: Omit<Partial<ItemLink>, 'id'>,
): Promise<ItemLink> {
  const record = { ...data, date_synced: new Date().toISOString() };
  return existing ? swell.put(`${COLLECTION}/${existing.id}`, record) : swell.post(COLLECTION, record);
}

/**
 * Forgets the links of a deleted product, or of one deleted variant. The Zoho
 * items stay as they are: they may carry history, and Zoho owns them now.
 */
export async function removeLinks(swell: SwellClient, productId: string, variantId?: string | null): Promise<number> {
  const links = await loadLinks(swell, productId);
  const gone = variantId ? links.filter((link) => link.variant_id === variantId) : links;
  for (const link of gone) await swell.delete(`${COLLECTION}/${link.id}`);
  return gone.length;
}

/** Links that failed, newest first; links of products deleted meanwhile are left out. */
export async function recentFailures(swell: SwellClient, limit = 10): Promise<ItemLink[]> {
  const list = await swell.get(COLLECTION, { where: { status: 'error' }, sort: 'date_synced desc', limit });
  const failed: ItemLink[] = list?.results ?? [];
  if (!failed.length) return failed;
  const ids = [...new Set(failed.map((link) => link.product_id))];
  const products = await swell.get('/products', { where: { id: { $in: ids } }, limit: ids.length });
  const existing = new Set((products?.results ?? []).map((p: { id: string }) => p.id));
  return failed.filter((link) => existing.has(link.product_id));
}

/** Linked items Zoho tracks stock for while Swell does not: they can oversell. */
export async function countUntrackedInSwell(swell: SwellClient): Promise<number> {
  const list = await swell.get(COLLECTION, { where: { zoho_tracked: true, swell_tracked: false }, limit: 1, fields: 'id' });
  return list?.count ?? 0;
}
