import type { DataCenter } from './data-centers';

// Requested on every connect. The merchant never picks scopes; changing this
// list means existing merchants must connect again to grant the new ones.
export const ZOHO_SCOPES = [
  'ZohoBooks.settings.CREATE',
  'ZohoBooks.settings.UPDATE',
  'ZohoBooks.settings.READ',
  'ZohoBooks.contacts.CREATE',
  'ZohoBooks.contacts.UPDATE',
  'ZohoBooks.contacts.READ',
  'ZohoBooks.invoices.CREATE',
  'ZohoBooks.invoices.UPDATE',
  'ZohoBooks.invoices.READ',
  // Only to take a payment off an invoice so a canceled order's invoice can be voided.
  'ZohoBooks.invoices.DELETE',
  'ZohoBooks.customerpayments.CREATE',
  'ZohoBooks.customerpayments.UPDATE',
  'ZohoBooks.customerpayments.READ',
  'ZohoBooks.creditnotes.CREATE',
  'ZohoBooks.creditnotes.UPDATE',
  'ZohoBooks.creditnotes.READ',
  'ZohoInventory.settings.READ',
  // Only to create this store's webhooks and workflow rules (Set up in Zoho),
  // and to point the webhooks at the new install key after a reinstall.
  'ZohoInventory.settings.CREATE',
  'ZohoInventory.settings.UPDATE',
  'ZohoInventory.contacts.CREATE',
  'ZohoInventory.contacts.UPDATE',
  'ZohoInventory.contacts.READ',
  'ZohoInventory.items.CREATE',
  'ZohoInventory.items.UPDATE',
  'ZohoInventory.items.READ',
  'ZohoInventory.salesorders.CREATE',
  'ZohoInventory.salesorders.UPDATE',
  'ZohoInventory.salesorders.READ',
  'ZohoInventory.invoices.CREATE',
  'ZohoInventory.invoices.UPDATE',
  'ZohoInventory.invoices.READ',
  'ZohoInventory.invoices.DELETE',
  'ZohoInventory.customerpayments.CREATE',
  'ZohoInventory.customerpayments.UPDATE',
  'ZohoInventory.customerpayments.READ',
  'ZohoInventory.creditnotes.CREATE',
  'ZohoInventory.creditnotes.UPDATE',
  'ZohoInventory.creditnotes.READ',
  'ZohoInventory.packages.READ',
  'ZohoInventory.shipmentorders.READ',
] as const;

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  apiDomain?: string;
}

export class ZohoOAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ZohoOAuthError';
  }
}

export function buildAuthorizeUrl(
  dc: DataCenter,
  params: { clientId: string; redirectUri: string; state: string },
): string {
  const url = new URL('/oauth/v2/auth', dc.accountsServer);
  url.search = new URLSearchParams({
    scope: ZOHO_SCOPES.join(','),
    client_id: params.clientId,
    response_type: 'code',
    access_type: 'offline',
    // Forces a fresh consent so Zoho always issues a refresh token.
    prompt: 'consent',
    redirect_uri: params.redirectUri,
    state: params.state,
  }).toString();
  return url.toString();
}

async function postToken(accountsServer: string, path: string, params: Record<string, string>) {
  const response = await fetch(new URL(path, accountsServer), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let body: Record<string, any> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ZohoOAuthError('invalid_response', `Zoho accounts returned HTTP ${response.status} with a non-JSON body`);
  }
  // Zoho reports OAuth failures as HTTP 200 with an `error` field.
  if (!response.ok || body.error) {
    const code = String(body.error || `http_${response.status}`);
    throw new ZohoOAuthError(code, `Zoho rejected the token request: ${code}`);
  }
  return body;
}

function toTokenSet(body: Record<string, any>): TokenSet {
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new ZohoOAuthError('invalid_response', 'Zoho token response has no access_token');
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresInSeconds: Number(body.expires_in) || 3600,
    apiDomain: typeof body.api_domain === 'string' ? body.api_domain : undefined,
  };
}

export async function exchangeCode(
  dc: DataCenter,
  credentials: ClientCredentials,
  params: { code: string; redirectUri: string },
): Promise<TokenSet> {
  const body = await postToken(dc.accountsServer, '/oauth/v2/token', {
    grant_type: 'authorization_code',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
  });
  return toTokenSet(body);
}

export async function refreshAccessToken(
  accountsServer: string,
  credentials: ClientCredentials,
  refreshToken: string,
): Promise<TokenSet> {
  const body = await postToken(accountsServer, '/oauth/v2/token', {
    grant_type: 'refresh_token',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: refreshToken,
  });
  return toTokenSet(body);
}

export async function revokeToken(accountsServer: string, token: string): Promise<void> {
  await postToken(accountsServer, '/oauth/v2/token/revoke', { token });
}
