import { AppError, type AppContext } from '../swell-client';
import { createZohoClient } from '../zoho/client';
import { buildAuthorizeUrl, revokeToken } from '../zoho/oauth';
import { buildState, createNonce, STATE_TTL_MS } from '../zoho/state';
import { connectionSettingsFrom, readConnectionSettings, selectedDataCenter } from './settings';
import {
  CLEARED_CONNECTION,
  WEBHOOKS_UNSEEN,
  loadConnection,
  loadOrCreateConnection,
  toView,
  updateConnection,
  type Connection,
  type ConnectionView,
} from './store';

// Swell defaults a store without an explicit currency to USD.
const DEFAULT_STORE_CURRENCY = 'USD';

export async function storeCurrency(ctx: AppContext): Promise<string> {
  const store = await ctx.swell.get('/settings/store');
  return String(store?.currency || DEFAULT_STORE_CURRENCY).toUpperCase();
}

/**
 * Fills in the organization's currency for connections made before it was
 * recorded. One Zoho call, once.
 */
async function ensureOrganizationCurrency(ctx: AppContext, connection: Connection | null): Promise<Connection | null> {
  if (connection?.status !== 'connected' || !connection.organization_id || connection.organization_currency) {
    return connection;
  }
  const zoho = await createZohoClient(ctx);
  if (!zoho) return connection;
  try {
    const body = await zoho.request(zoho.itemsApi, 'GET', `/organizations/${connection.organization_id}`);
    const currency = body?.organization?.currency_code;
    if (!currency) return connection;
    return await updateConnection(ctx.swell, ctx.appId, connection.id, { organization_currency: currency });
  } catch {
    // Not worth failing the page over; the next load tries again.
    return connection;
  }
}

export async function getStatus(
  ctx: AppContext,
): Promise<ConnectionView & { credentials_configured: boolean; store_currency: string; api_console: string }> {
  const [loaded, settings, currency] = await Promise.all([
    loadConnection(ctx.swell, ctx.appId),
    ctx.swell.settings(),
    storeCurrency(ctx),
  ]);
  const connection = await ensureOrganizationCurrency(ctx, loaded);
  return {
    ...toView(connection),
    credentials_configured: Boolean(connectionSettingsFrom(settings)),
    store_currency: currency,
    // Where the merchant registers the client: the console of the chosen data center.
    api_console: selectedDataCenter(settings).apiConsole,
  };
}

function assertCallbackUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' && url.pathname === '/oauth/callback') return url.toString();
  } catch {
    // fall through
  }
  throw new AppError('invalid_redirect_uri', 'redirect_uri must be the https /oauth/callback URL of the app page');
}

/** Starts a connect: stores a fresh single-use nonce and returns the Zoho consent URL. */
export async function startConnect(ctx: AppContext, redirectUri: unknown): Promise<{ authorize_url: string }> {
  const settings = await readConnectionSettings(ctx.swell);
  if (!settings) {
    throw new AppError('missing_credentials', 'Enter the Zoho data center, client ID and client secret in the app settings first');
  }
  const callbackUrl = assertCallbackUrl(redirectUri);
  const connection = await loadOrCreateConnection(ctx.swell, ctx.appId);
  const nonce = createNonce();

  await updateConnection(ctx.swell, ctx.appId, connection.id, {
    oauth_nonce: nonce,
    oauth_nonce_expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
    redirect_uri: callbackUrl,
  });

  return {
    authorize_url: buildAuthorizeUrl(settings.dataCenter, {
      clientId: settings.clientId,
      redirectUri: callbackUrl,
      state: buildState(ctx.storeId, nonce),
    }),
  };
}

export async function selectOrganization(ctx: AppContext, organizationId: unknown): Promise<ConnectionView> {
  const connection = await loadConnection(ctx.swell, ctx.appId);
  if (connection?.status !== 'connected') {
    throw new AppError('not_connected', 'Connect to Zoho before choosing an organization', 409);
  }
  const org = connection.organizations?.find((o) => o.organization_id === String(organizationId));
  if (!org) {
    throw new AppError('unknown_organization', 'That organization is not available to the connected Zoho user');
  }
  const updated = await updateConnection(ctx.swell, ctx.appId, connection.id, {
    organization_id: org.organization_id,
    organization_name: org.name,
    organization_currency: org.currency_code ?? null,
    has_books: org.books,
    has_inventory: org.inventory,
    ...(org.organization_id !== connection.organization_id ? WEBHOOKS_UNSEEN : {}),
  });
  return toView(updated);
}

/** Revokes the refresh token at Zoho (best effort) and forgets the connection. */
export async function disconnect(ctx: AppContext): Promise<ConnectionView> {
  const connection = await loadConnection(ctx.swell, ctx.appId);
  if (!connection) return toView(null);

  let lastError: string | null = null;
  if (connection.refresh_token && connection.accounts_server) {
    try {
      await revokeToken(connection.accounts_server, connection.refresh_token);
    } catch (error) {
      // The local tokens are dropped either way; the merchant can still
      // remove the grant from their Zoho account.
      lastError = `Zoho did not confirm the token revoke: ${(error as Error).message}`;
    }
  }

  const updated = await updateConnection(ctx.swell, ctx.appId, connection.id, {
    ...CLEARED_CONNECTION,
    status: 'disconnected',
    last_error: lastError,
  });
  return toView(updated);
}
