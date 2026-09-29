import type { Connection } from '../connection/store';
import { ZohoApiError, type ZohoClient } from '../zoho/client';
import { isEndpointUrl, webhookHeaders, type WebhookEndpoint } from './endpoint';
import type { WebhookTopic } from './payload';

/**
 * The Zoho workflow rules the app needs: one per module, each with a webhook
 * to this store's webhook function for its topic. `entity` is Zoho's module name.
 */
export const ZOHO_RULES = [
  { entity: 'shipment_order', topic: 'shipments', label: 'Shipment orders', name: 'Swell shipments' },
  { entity: 'inventory_adjustment', topic: 'stock', label: 'Inventory adjustments', name: 'Swell stock: adjustments' },
  { entity: 'purchase_receive', topic: 'stock', label: 'Purchase receives', name: 'Swell stock: purchase receives' },
  { entity: 'transfer_order', topic: 'stock', label: 'Transfer orders', name: 'Swell stock: transfer orders' },
  // A sales return moves stock only when it is received.
  { entity: 'salesreturn_receive', topic: 'stock', label: 'Sales return receives', name: 'Swell stock: sales return receives' },
  { entity: 'salesorder', topic: 'stock', label: 'Sales orders', name: 'Swell stock: sales orders' },
  { entity: 'invoice', topic: 'stock', label: 'Invoices', name: 'Swell stock: invoices' },
] as const satisfies ReadonlyArray<{ entity: string; topic: WebhookTopic; label: string; name: string }>;

export type ZohoRule = (typeof ZOHO_RULES)[number];
/** `outdated`: the rule runs, but its webhook still has an old address or an old key */
export type RuleStatus = 'ready' | 'outdated' | 'inactive' | 'missing';

export interface RuleState {
  entity: string;
  topic: WebhookTopic;
  label: string;
  status: RuleStatus;
  /** This store's webhook on the module, when one exists, even without a rule */
  webhook_id: string | null;
  /** This store's webhooks on the module that need the current address and key */
  stale_webhook_ids: string[];
}

/** Which webhooks already carry the current key (see Connection). */
export type KeyState = Pick<Connection, 'webhook_public_key' | 'webhook_current_ids'>;

// Zoho's answer when the token lacks a scope (settings.CREATE or UPDATE).
const NOT_AUTHORIZED = 57;

export class SetupPermissionError extends Error {
  constructor() {
    super('Reconnect to Zoho once to let the app set up workflow rules');
    this.name = 'SetupPermissionError';
  }
}

/**
 * The first versions posted to the app page, with the token in the URL. That
 * host changes when the app is installed again, so these webhooks are updated.
 */
function isPageUrl(url: string, topic: WebhookTopic, secret: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === `/webhooks/zoho/${topic}` && parsed.searchParams.get('token') === secret;
  } catch {
    return false;
  }
}

async function list(zoho: ZohoClient, path: string, key: string): Promise<Record<string, any>[]> {
  const body = await zoho.request('inventory', 'GET', path, { query: { per_page: 200 } });
  return body?.[key] ?? [];
}

/**
 * Which rules exist in Zoho: a webhook of this store on the module, used by
 * a workflow rule. Read with the settings.READ scope. Zoho does not return
 * header values in this list, so which webhooks carry the current key comes
 * from the connection.
 */
export async function readZohoSetup(zoho: ZohoClient, secret: string, endpoint: WebhookEndpoint, keys: KeyState): Promise<RuleState[]> {
  const [webhooks, workflows] = await Promise.all([
    list(zoho, '/settings/webhooks', 'webhooks'),
    list(zoho, '/settings/workflows', 'workflows'),
  ]);
  const byId = new Map(workflows.map((w) => [String(w.workflow_id), w]));
  const current = new Set(keys.webhook_public_key === endpoint.publicKey ? (keys.webhook_current_ids ?? []) : []);
  // Zoho sends an empty string, not an empty list, for a webhook no rule uses.
  const related = (h: Record<string, any>) => (Array.isArray(h.related_rules) ? h.related_rules : []);
  const rulesOf = (h: Record<string, any>) =>
    related(h)
      .map((r: Record<string, any>) => byId.get(String(r.workflow_id)))
      .filter((w: Record<string, any> | undefined): w is Record<string, any> => Boolean(w));

  return ZOHO_RULES.map((rule) => {
    const ours = webhooks.filter((h) => {
      const url = String(h.url ?? '');
      return h.entity === rule.entity && (isEndpointUrl(url, endpoint) || isPageUrl(url, rule.topic, secret));
    });
    const rules = ours.flatMap(rulesOf);
    const stale = ours
      .filter((h) => !isEndpointUrl(String(h.url ?? ''), endpoint) || !current.has(String(h.webhook_id)))
      .map((h) => String(h.webhook_id));
    const status: RuleStatus = rules.some((w) => w.is_active)
      ? stale.length
        ? 'outdated'
        : 'ready'
      : rules.length
        ? 'inactive'
        : 'missing';
    // Prefer the webhook a rule uses, so setup reuses the right one.
    const main = ours.find((h) => rulesOf(h).length) ?? ours[0];
    return {
      entity: rule.entity,
      topic: rule.topic,
      label: rule.label,
      status,
      webhook_id: main ? String(main.webhook_id) : null,
      stale_webhook_ids: stale,
    };
  });
}

async function send(zoho: ZohoClient, method: 'POST' | 'PUT', path: string, body: Record<string, unknown>): Promise<any> {
  try {
    return await zoho.request('inventory', method, path, { body });
  } catch (error) {
    if (error instanceof ZohoApiError && error.code === NOT_AUTHORIZED) throw new SetupPermissionError();
    throw error;
  }
}

/** POST with Zoho's default JSON payload, and the key, topic and token as headers. */
function webhookBody(rule: ZohoRule, endpoint: WebhookEndpoint, secret: string): Record<string, unknown> {
  return {
    webhook_name: rule.name,
    entity: rule.entity,
    url: endpoint.url,
    method: 'POST',
    body_type: 'application/json',
    raw_data: '${JSONString}',
    headers: webhookHeaders(endpoint, rule.topic, secret),
  };
}

/** Points an existing webhook at the current endpoint and key (settings.UPDATE scope). */
export async function updateZohoWebhook(zoho: ZohoClient, rule: ZohoRule, webhookId: string, endpoint: WebhookEndpoint, secret: string): Promise<void> {
  await send(zoho, 'PUT', `/settings/webhooks/${webhookId}`, webhookBody(rule, endpoint, secret));
}

/**
 * Creates the webhook and the workflow rule for one module, the way the
 * setup steps describe: run whenever a record is created or edited.
 * Returns the id of the webhook, which now has the current key.
 */
export async function createZohoRule(
  zoho: ZohoClient,
  rule: ZohoRule,
  endpoint: WebhookEndpoint,
  secret: string,
  existingWebhookId?: string | null,
): Promise<string> {
  // A webhook left behind by a deleted rule is reused rather than duplicated.
  let webhookId = existingWebhookId ?? null;
  if (webhookId) {
    await updateZohoWebhook(zoho, rule, webhookId, endpoint, secret);
  } else {
    const created = await send(zoho, 'POST', '/settings/webhooks', webhookBody(rule, endpoint, secret));
    webhookId = created?.webhook?.webhook_id ? String(created.webhook.webhook_id) : null;
  }
  if (!webhookId) throw new Error(`Zoho did not return the new webhook for ${rule.label}`);
  const action = { action_type: 'webhook', action_id: webhookId };
  await send(zoho, 'POST', '/settings/workflows', {
    workflow_name: rule.name,
    entity: rule.entity,
    rule_type: 'add_edit',
    apply_rule_always: true,
    field_update_comparator: 'any',
    field_update: [],
    instant_actions: [action],
    time_based_actions: [],
    rule: {},
    sub_rules: [{ index: 1, rule: {}, instant_actions: [action], time_based_actions: [] }],
  });
  return webhookId;
}

export function findRule(entity: unknown): ZohoRule | undefined {
  return ZOHO_RULES.find((rule) => rule.entity === entity);
}
