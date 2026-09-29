import type { SwellClient } from '../swell-client';
import type { ZohoOrganization } from '../zoho/organizations';

export type ConnectionStatus = 'disconnected' | 'connected' | 'error';

/** Progress of the catalog sync started from the Zoho page. */
export interface ProductSyncJob {
  status: 'idle' | 'running' | 'done';
  cursor?: string | null;
  total?: number;
  processed?: number;
  created?: number;
  linked?: number;
  failed?: number;
  started_at?: string | null;
  finished_at?: string | null;
  resume_at?: string | null;
  note?: string | null;
}

export interface Connection {
  id: string;
  status: ConnectionStatus;
  data_center?: string | null;
  accounts_server?: string | null;
  api_domain?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  redirect_uri?: string | null;
  oauth_nonce?: string | null;
  oauth_nonce_expires_at?: string | null;
  organizations?: ZohoOrganization[];
  organization_id?: string | null;
  organization_name?: string | null;
  organization_currency?: string | null;
  has_books?: boolean;
  has_inventory?: boolean;
  last_error?: string | null;
  date_connected?: string | null;
  location_id?: string | null;
  product_sync?: ProductSyncJob;
  webhook_secret?: string | null;
  webhook_shipments_at?: string | null;
  webhook_stock_at?: string | null;
  webhook_stock_sources?: string[];
  /** The install key the webhooks in `webhook_current_ids` send; a new install has another */
  webhook_public_key?: string | null;
  webhook_current_ids?: string[];
  webhook_repair_error?: 'needs_reconnect' | null;
  webhook_checked_at?: string | null;
  stock_catchup?: StockCatchup | null;
}

/** Stock refresh from Zoho for every linked item after the webhooks were down. */
export interface StockCatchup {
  status: 'running' | 'done';
  cursor?: string | null;
  refreshed?: number;
  started_at?: string | null;
  finished_at?: string | null;
}

// The bare name resolves to this app's collection for app credentials (both
// `req.swell` in functions and the frontend's app token), and counts as the
// app's own model, so it needs no permission. `/apps/<slug>/…` would be
// checked as the `apps` resource and require `write_apps` for writes.
const collection = (_appId: string) => '/connections';

export async function loadConnection(swell: SwellClient, appId: string): Promise<Connection | null> {
  const list: { results?: Connection[] } | null = await swell.get(collection(appId), {
    limit: 1,
    sort: 'date_created asc',
  });
  return list?.results?.[0] ?? null;
}

export async function loadOrCreateConnection(swell: SwellClient, appId: string): Promise<Connection> {
  const existing = await loadConnection(swell, appId);
  if (existing) return existing;
  return swell.post(collection(appId), { status: 'disconnected' });
}

export async function updateConnection(
  swell: SwellClient,
  appId: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<Connection> {
  return swell.put(`${collection(appId)}/${id}`, patch);
}

/** Webhook calls seen so far, and the webhooks set up, belong to one Zoho organization. */
export const WEBHOOKS_UNSEEN = {
  webhook_shipments_at: null,
  webhook_stock_at: null,
  webhook_stock_sources: { $set: [] },
  webhook_public_key: null,
  webhook_current_ids: { $set: [] },
  webhook_checked_at: null,
  stock_catchup: null,
};

/** Every field a working connection holds, reset to empty. */
export const CLEARED_CONNECTION = {
  data_center: null,
  accounts_server: null,
  api_domain: null,
  access_token: null,
  refresh_token: null,
  token_expires_at: null,
  oauth_nonce: null,
  oauth_nonce_expires_at: null,
  organizations: { $set: [] },
  organization_id: null,
  organization_name: null,
  organization_currency: null,
  has_books: false,
  has_inventory: false,
  date_connected: null,
  ...WEBHOOKS_UNSEEN,
};

export interface ConnectionView {
  status: ConnectionStatus;
  data_center: string | null;
  organization: { id: string; name: string | null; currency: string | null } | null;
  organizations: ZohoOrganization[];
  products: { books: boolean; inventory: boolean };
  last_error: string | null;
  date_connected: string | null;
  /** The callback URL of the last connect; Zoho accepts only the one registered in its API Console */
  redirect_uri: string | null;
}

/** What the app page may see: never tokens or nonces. */
export function toView(connection: Connection | null): ConnectionView {
  return {
    status: connection?.status ?? 'disconnected',
    data_center: connection?.data_center ?? null,
    organization: connection?.organization_id
      ? {
          id: connection.organization_id,
          name: connection.organization_name ?? null,
          currency: connection.organization_currency ?? null,
        }
      : null,
    organizations: connection?.organizations ?? [],
    products: {
      books: Boolean(connection?.has_books),
      inventory: Boolean(connection?.has_inventory),
    },
    last_error: connection?.last_error ?? null,
    date_connected: connection?.date_connected ?? null,
    redirect_uri: connection?.redirect_uri ?? null,
  };
}
