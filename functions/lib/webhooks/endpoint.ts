import type { AppContext } from '../swell-client';
import type { WebhookTopic } from './payload';

/** The route function Zoho workflow rules post to. */
export const WEBHOOK_FUNCTION = 'zoho-webhook';
export const TOPIC_HEADER = 'X-Swell-Topic';
export const TOKEN_HEADER = 'X-Swell-Token';

export interface WebhookEndpoint {
  url: string;
  /** Sent as `Authorization`: the store gateway finds the app, and test or live, by it */
  publicKey: string;
}

/**
 * Where Zoho sends webhooks: the store gateway address of the webhook
 * function. It stays the same for the life of the store, unlike the app
 * page's host, which carries the install id. The public key does change with
 * a new install; the maintenance cron then updates the webhooks in Zoho.
 */
export function webhookEndpoint(ctx: Pick<AppContext, 'storeId' | 'appId' | 'publicKey'>): WebhookEndpoint | null {
  if (!ctx.publicKey) return null;
  return { url: `https://${ctx.storeId}.swell.store/functions/${ctx.appId}/${WEBHOOK_FUNCTION}`, publicKey: ctx.publicKey };
}

/** A header in Zoho's webhook settings. */
export interface ZohoHeader {
  param_name: string;
  param_value: string;
}

export function webhookHeaders(endpoint: WebhookEndpoint, topic: WebhookTopic, secret: string): ZohoHeader[] {
  return [
    { param_name: 'Authorization', param_value: endpoint.publicKey },
    { param_name: TOPIC_HEADER, param_value: topic },
    { param_name: TOKEN_HEADER, param_value: secret },
  ];
}

/** True when a Zoho webhook URL is this store's webhook function, whatever query or trailing `&` Zoho kept. */
export function isEndpointUrl(url: string, endpoint: WebhookEndpoint): boolean {
  try {
    const parsed = new URL(url.replace(/[?&]+$/, ''));
    const expected = new URL(endpoint.url);
    return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
  } catch {
    return false;
  }
}
