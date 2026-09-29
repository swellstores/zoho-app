import { loadConnection, updateConnection, type Connection } from '../connection/store';
import { AppError, type AppContext } from '../swell-client';
import { createNonce, timingSafeEqual } from '../zoho/state';
import { parseWebhookBody, sourceModule, type WebhookTopic } from './payload';

// Bare name: this app's collection, no permission needed.
const EVENTS = '/webhook-events';
// Enough for any single Zoho record; keeps a runaway body out of the store.
const MAX_BODY = 200_000;

/** The token Zoho sends with every webhook call, created on first use. */
export async function ensureWebhookSecret(ctx: AppContext, connection: Connection): Promise<string> {
  if (connection.webhook_secret) return connection.webhook_secret;
  const secret = createNonce();
  await updateConnection(ctx.swell, ctx.appId, connection.id, { webhook_secret: secret });
  connection.webhook_secret = secret;
  return secret;
}

/**
 * Zoho checks a webhook when it is saved: an empty `payload=` form call, or
 * `{"payload": ""}` with a JSON body. It proves the address and token work;
 * there is nothing to process.
 */
function isCheckCall(body: string, payload: Record<string, any>): boolean {
  if (/^((payload|JSONString)=)?$/.test(body.trim())) return true;
  const keys = Object.keys(payload);
  return keys.length > 0 && keys.every((key) => (key === 'payload' || key === 'JSONString') && !payload[key]);
}

/**
 * Stores a webhook call from Zoho for the webhook-event function and records
 * that the topic is live. Only calls carrying this store's token are kept.
 */
export async function receiveWebhook(
  ctx: AppContext,
  topic: WebhookTopic,
  token: string | undefined,
  body: string,
  contentType: string | undefined,
): Promise<{ ok: true; source: string | null; check: boolean }> {
  const connection = await loadConnection(ctx.swell, ctx.appId);
  if (!connection?.webhook_secret || !token || !timingSafeEqual(token, connection.webhook_secret)) {
    throw new AppError('unauthorized', 'Unknown webhook token', 401);
  }

  const payload = parseWebhookBody(body);
  const source = sourceModule(payload);
  const check = isCheckCall(body, payload);
  if (!check) {
    await ctx.swell.post(EVENTS, {
      topic,
      source,
      body: body.slice(0, MAX_BODY),
      content_type: contentType ?? null,
      status: 'received',
    });
  }

  const now = new Date().toISOString();
  const sources = connection.webhook_stock_sources ?? [];
  await updateConnection(
    ctx.swell,
    ctx.appId,
    connection.id,
    topic === 'shipments'
      ? { webhook_shipments_at: now }
      : {
          webhook_stock_at: now,
          ...(source && !sources.includes(source) ? { webhook_stock_sources: { $set: [...sources, source] } } : {}),
        },
  );
  return { ok: true, source, check };
}
