import { readConnectionSettings } from '../connection/settings';
import { loadConnection, updateConnection, type Connection } from '../connection/store';
import { AppError, type AppContext } from '../swell-client';
import { refreshAccessToken, ZohoOAuthError } from './oauth';

export type ZohoApi = 'books' | 'inventory';

const API_BASE: Record<ZohoApi, string> = {
  books: '/books/v3',
  inventory: '/inventory/v1',
};

// Refresh a little early so a token never expires mid-batch.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class ZohoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | undefined,
    message: string,
    /** e.g. "POST /creditnotes", to say which step failed */
    public readonly request?: string,
  ) {
    super(request ? `Zoho ${request}: ${message}${code !== undefined ? ` (code ${code})` : ''}` : message);
    this.name = 'ZohoApiError';
  }
}

/** HTTP 429. `day` means the organization's daily quota is spent. */
export class ZohoRateLimitError extends ZohoApiError {
  constructor(
    status: number,
    code: number | undefined,
    message: string,
    public readonly scope: 'minute' | 'day',
  ) {
    super(status, code, message);
    this.name = 'ZohoRateLimitError';
  }
}

export interface ZohoRequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface ZohoClient {
  connection: Connection;
  /** Items and contacts live in Inventory when the org has it, otherwise in Books. */
  itemsApi: ZohoApi;
  request(api: ZohoApi, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options?: ZohoRequestOptions): Promise<any>;
}

async function refresh(ctx: AppContext, connection: Connection): Promise<string> {
  const settings = await readConnectionSettings(ctx.swell);
  if (!settings || !connection.refresh_token || !connection.accounts_server) {
    throw new AppError('not_connected', 'Zoho is not connected', 409);
  }
  try {
    const tokens = await refreshAccessToken(connection.accounts_server, settings, connection.refresh_token);
    const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();
    await updateConnection(ctx.swell, ctx.appId, connection.id, {
      access_token: tokens.accessToken,
      token_expires_at: expiresAt,
    });
    connection.access_token = tokens.accessToken;
    connection.token_expires_at = expiresAt;
    return tokens.accessToken;
  } catch (error) {
    if (error instanceof ZohoOAuthError) {
      const message = `Zoho no longer accepts this connection (${error.code}). Reconnect on the Zoho page.`;
      await updateConnection(ctx.swell, ctx.appId, connection.id, { status: 'error', last_error: message });
      connection.status = 'error';
      throw new AppError('zoho_auth', message, 401);
    }
    throw error;
  }
}

function accessToken(ctx: AppContext, connection: Connection): Promise<string> | string {
  const expiresAt = Date.parse(connection.token_expires_at ?? '');
  if (connection.access_token && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return connection.access_token;
  }
  return refresh(ctx, connection);
}

function rateLimitScope(message: string): 'minute' | 'day' {
  return /maximum call rate limit|per day|daily/i.test(message) ? 'day' : 'minute';
}

/**
 * A client for the connected organization, or null when the store is not
 * connected or has not chosen an organization yet.
 */
export async function createZohoClient(ctx: AppContext): Promise<ZohoClient | null> {
  const connection = await loadConnection(ctx.swell, ctx.appId);
  if (connection?.status !== 'connected' || !connection.organization_id || !connection.api_domain) {
    return null;
  }

  const send = (url: URL, method: string, token: string, body: unknown) =>
    fetch(url, {
      method,
      headers: {
        authorization: `Zoho-oauthtoken ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  return {
    connection,
    itemsApi: connection.has_inventory ? 'inventory' : 'books',
    async request(api, method, path, options = {}) {
      const url = new URL(`${connection.api_domain}${API_BASE[api]}${path}`);
      url.searchParams.set('organization_id', connection.organization_id!);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }

      let response = await send(url, method, await accessToken(ctx, connection), options.body);
      if (response.status === 401) {
        // Revoked or expired early: refresh once and retry.
        response = await send(url, method, await refresh(ctx, connection), options.body);
      }

      const text = await response.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // reported below
      }
      const message = String(body?.message ?? (text.slice(0, 200) || `HTTP ${response.status}`));
      if (response.status === 429) {
        throw new ZohoRateLimitError(429, body?.code, message, rateLimitScope(message));
      }
      if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
        // Record ids in the path are noise in an error message.
        throw new ZohoApiError(response.status, body?.code, message, `${method} ${path.replace(/\/\d{6,}/g, '/…')}`);
      }
      return body;
    },
  };
}
