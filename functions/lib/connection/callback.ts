import { AppError, type AppContext } from '../swell-client';
import { dataCenterByAccountsServer, isKnownApiDomain } from '../zoho/data-centers';
import { exchangeCode, revokeToken, ZohoOAuthError } from '../zoho/oauth';
import { describeProblems, listOrganizations } from '../zoho/organizations';
import { parseState, timingSafeEqual } from '../zoho/state';
import { readConnectionSettings } from './settings';
import { loadConnection, toView, updateConnection, WEBHOOKS_UNSEEN, type Connection, type ConnectionView } from './store';

export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  /** Zoho's `accounts-server` redirect parameter */
  accounts_server?: string;
}

function verifyState(connection: Connection | null, storeId: string, state: string | undefined): Connection {
  const parsed = parseState(state);
  if (!parsed || parsed.storeId !== storeId) {
    throw new AppError('invalid_state', 'This sign-in link does not belong to this store. Start again from the Zoho page.');
  }
  if (!connection?.oauth_nonce || !timingSafeEqual(connection.oauth_nonce, parsed.nonce)) {
    throw new AppError('invalid_state', 'This sign-in link was already used or replaced. Start again from the Zoho page.');
  }
  const expiresAt = Date.parse(connection.oauth_nonce_expires_at ?? '');
  if (!(expiresAt > Date.now())) {
    throw new AppError('expired_state', 'This sign-in link expired. Start again from the Zoho page.');
  }
  return connection;
}

async function fail(ctx: AppContext, connection: Connection, error: AppError): Promise<never> {
  // A failed reconnect must not break a connection that still works.
  await updateConnection(ctx.swell, ctx.appId, connection.id, {
    last_error: error.message,
    ...(connection.status === 'connected' ? {} : { status: 'error' }),
  });
  throw error;
}

/**
 * Completes the OAuth redirect: verifies the single-use state, exchanges the
 * code at the merchant's data center and stores tokens and organizations.
 */
export async function completeConnect(ctx: AppContext, params: CallbackParams): Promise<ConnectionView> {
  const connection = verifyState(await loadConnection(ctx.swell, ctx.appId), ctx.storeId, params.state);

  // Burn the nonce before anything else can fail, so the link is single-use.
  await updateConnection(ctx.swell, ctx.appId, connection.id, { oauth_nonce: null, oauth_nonce_expires_at: null });

  if (params.error) {
    return fail(ctx, connection, new AppError('zoho_denied', `Zoho did not grant access: ${params.error}`));
  }
  if (!params.code) {
    return fail(ctx, connection, new AppError('missing_code', 'Zoho returned no authorization code'));
  }

  const settings = await readConnectionSettings(ctx.swell);
  if (!settings) {
    return fail(ctx, connection, new AppError('missing_credentials', 'The Zoho client ID or secret is missing from the app settings'));
  }

  // Zoho names the data center that holds the account. Only known Zoho hosts
  // are accepted, so the client secret is never sent anywhere else.
  const dataCenter = params.accounts_server
    ? dataCenterByAccountsServer(params.accounts_server)
    : settings.dataCenter;
  if (!dataCenter) {
    return fail(ctx, connection, new AppError('unknown_data_center', 'Zoho redirected from an unknown accounts server'));
  }

  let tokens;
  try {
    tokens = await exchangeCode(dataCenter, settings, {
      code: params.code,
      redirectUri: connection.redirect_uri ?? '',
    });
  } catch (error) {
    if (error instanceof ZohoOAuthError) {
      return fail(ctx, connection, new AppError('token_exchange_failed', error.message, 502));
    }
    throw error;
  }
  if (!tokens.refreshToken) {
    return fail(ctx, connection, new AppError('no_refresh_token', 'Zoho issued no refresh token. Connect again and approve access.', 502));
  }

  const apiDomain = isKnownApiDomain(tokens.apiDomain) ? tokens.apiDomain! : dataCenter.apiDomain;
  const { organizations, problems } = await listOrganizations(apiDomain, tokens.accessToken);
  if (problems.length) console.log(JSON.stringify({ zoho_organization_lookup: problems }));
  const only = organizations.length === 1 ? organizations[0] : undefined;

  if (connection.refresh_token && connection.accounts_server) {
    // Zoho caps refresh tokens per user and client; drop the one being replaced.
    await revokeToken(connection.accounts_server, connection.refresh_token).catch(() => undefined);
  }

  const updated = await updateConnection(ctx.swell, ctx.appId, connection.id, {
    status: organizations.length ? 'connected' : 'error',
    data_center: dataCenter.location,
    accounts_server: dataCenter.accountsServer,
    api_domain: apiDomain,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
    organizations: { $set: organizations },
    organization_id: only?.organization_id ?? null,
    organization_name: only?.name ?? null,
    organization_currency: only?.currency_code ?? null,
    has_books: only?.books ?? false,
    has_inventory: only?.inventory ?? false,
    ...((only?.organization_id ?? null) !== (connection.organization_id ?? null) ? WEBHOOKS_UNSEEN : {}),
    // New permissions may have been granted: the maintenance job checks the webhooks again.
    webhook_repair_error: null,
    webhook_checked_at: null,
    last_error: organizations.length
      ? null
      : `No Zoho Books or Zoho Inventory organization is available to this Zoho user. ${describeProblems(problems)}`.trim(),
    date_connected: new Date().toISOString(),
  });
  return toView(updated);
}
