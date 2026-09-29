import { ZohoApiError, type ZohoClient } from '../zoho/client';
import type { WebhookTopic } from './payload';

/**
 * The Zoho workflow rules the app needs: one per module, each with a webhook
 * to this store's URL for its topic. `entity` is Zoho's module name.
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
export type RuleStatus = 'ready' | 'inactive' | 'missing';

export interface RuleState {
  entity: string;
  topic: WebhookTopic;
  label: string;
  status: RuleStatus;
  /** This store's webhook on the module, when one exists, even without a rule */
  webhook_id: string | null;
}

// Zoho's answer when the token lacks a scope (settings.CREATE for webhooks).
const NOT_AUTHORIZED = 57;

export class SetupPermissionError extends Error {
  constructor() {
    super('Reconnect to Zoho once to let the app create workflow rules');
    this.name = 'SetupPermissionError';
  }
}

/** A webhook URL is this store's when it has the topic's path and this store's token. */
function isOurUrl(url: string, topic: WebhookTopic, secret: string): boolean {
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
 * Which rules exist in Zoho: a webhook to this store's URL on the module,
 * used by a workflow rule. Read with the settings.READ scope.
 */
export async function readZohoSetup(zoho: ZohoClient, secret: string): Promise<RuleState[]> {
  const [webhooks, workflows] = await Promise.all([
    list(zoho, '/settings/webhooks', 'webhooks'),
    list(zoho, '/settings/workflows', 'workflows'),
  ]);
  const byId = new Map(workflows.map((w) => [String(w.workflow_id), w]));
  return ZOHO_RULES.map((rule) => {
    const ours = webhooks.filter((h) => h.entity === rule.entity && isOurUrl(String(h.url ?? ''), rule.topic, secret));
    // Zoho sends an empty string, not an empty list, for a webhook no rule uses.
    const related = (h: Record<string, any>) => (Array.isArray(h.related_rules) ? h.related_rules : []);
    const rules = ours
      .flatMap((h) => related(h).map((r: Record<string, any>) => byId.get(String(r.workflow_id))))
      .filter((w): w is Record<string, any> => Boolean(w));
    const status: RuleStatus = rules.some((w) => w.is_active) ? 'ready' : rules.length ? 'inactive' : 'missing';
    const webhookId = ours[0]?.webhook_id;
    return { entity: rule.entity, topic: rule.topic, label: rule.label, status, webhook_id: webhookId ? String(webhookId) : null };
  });
}

async function create(zoho: ZohoClient, path: string, body: Record<string, unknown>): Promise<any> {
  try {
    return await zoho.request('inventory', 'POST', path, { body });
  } catch (error) {
    if (error instanceof ZohoApiError && error.code === NOT_AUTHORIZED) throw new SetupPermissionError();
    throw error;
  }
}

/**
 * Creates the webhook and the workflow rule for one module, the way the
 * setup steps describe: POST with Zoho's default JSON payload, run whenever
 * a record is created or edited.
 */
export async function createZohoRule(zoho: ZohoClient, rule: ZohoRule, url: string, existingWebhookId?: string | null): Promise<void> {
  // A webhook left behind by a deleted rule is reused rather than duplicated.
  const webhookId =
    existingWebhookId ??
    (
      await create(zoho, '/settings/webhooks', {
        webhook_name: rule.name,
        entity: rule.entity,
        url,
        method: 'POST',
        body_type: 'application/json',
        raw_data: '${JSONString}',
      })
    )?.webhook?.webhook_id;
  if (!webhookId) throw new Error(`Zoho did not return the new webhook for ${rule.label}`);
  const action = { action_type: 'webhook', action_id: String(webhookId) };
  await create(zoho, '/settings/workflows', {
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
}

export function findRule(entity: unknown): ZohoRule | undefined {
  return ZOHO_RULES.find((rule) => rule.entity === entity);
}
