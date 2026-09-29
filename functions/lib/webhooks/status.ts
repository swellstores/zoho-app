import { loadConnection } from '../connection/store';
import { AppError, type AppContext } from '../swell-client';
import { createZohoClient } from '../zoho/client';
import { ensureWebhookSecret, webhookUrl } from './receive';
import { createZohoRule, findRule, readZohoSetup, SetupPermissionError, ZOHO_RULES, type RuleState } from './zoho-setup';

const EVENTS = '/webhook-events';
const FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Payload keys a Zoho module's record can arrive under, for failure labels.
const SOURCE_LABELS: Record<string, string> = {
  inventory_adjustment: 'Inventory adjustments',
  inventoryadjustment: 'Inventory adjustments',
  purchase_receive: 'Purchase receives',
  purchasereceive: 'Purchase receives',
  transfer_order: 'Transfer orders',
  transferorder: 'Transfer orders',
  salesreturn_receive: 'Sales return receives',
  sales_return_receive: 'Sales return receives',
  salesorder: 'Sales orders',
  invoice: 'Invoices',
  shipment_order: 'Shipments',
  shipmentorder: 'Shipments',
  package: 'Packages',
  item: 'Items',
};

export function sourceLabel(key: string): string {
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface WebhooksStatus {
  /** Stock and shipments exist only in Zoho Inventory */
  applies: boolean;
  urls: { shipments: string; stock: string } | null;
  shipments: { last_received_at: string | null };
  stock: { last_received_at: string | null };
  /** The workflow rules in Zoho, one per module; null when Zoho could not be read */
  rules: RuleState[] | null;
  rules_error: string | null;
  failures: Array<{ id: string; topic: string; source: string | null; error: string | null; date_created: string }>;
}

export async function getWebhooksStatus(ctx: AppContext, pageHost: string | null): Promise<WebhooksStatus> {
  const connection = await loadConnection(ctx.swell, ctx.appId);
  const applies = Boolean(connection?.has_inventory);
  const status: WebhooksStatus = {
    applies,
    urls: null,
    shipments: { last_received_at: connection?.webhook_shipments_at ?? null },
    stock: { last_received_at: connection?.webhook_stock_at ?? null },
    rules: null,
    rules_error: null,
    failures: [],
  };
  if (!connection || !applies) return status;

  const secret = await ensureWebhookSecret(ctx, connection);
  if (pageHost) {
    status.urls = { shipments: webhookUrl(pageHost, 'shipments', secret), stock: webhookUrl(pageHost, 'stock', secret) };
  }
  const since = new Date(Date.now() - FAILURE_WINDOW_MS).toISOString();
  const [failed, rules] = await Promise.all([
    ctx.swell.get(EVENTS, { where: { status: 'error', date_created: { $gte: since } }, sort: 'date_created desc', limit: 5 }),
    readRules(ctx, secret),
  ]);
  Object.assign(status, rules);
  status.failures = (failed?.results ?? []).map((e: Record<string, any>) => ({
    id: e.id,
    topic: e.topic,
    source: e.source ? sourceLabel(e.source) : null,
    error: e.error ?? null,
    date_created: e.date_created,
  }));
  return status;
}

async function readRules(ctx: AppContext, secret: string): Promise<Pick<WebhooksStatus, 'rules' | 'rules_error'>> {
  try {
    const zoho = await createZohoClient(ctx);
    if (!zoho) return { rules: null, rules_error: 'Zoho is not connected' };
    return { rules: await readZohoSetup(zoho, secret), rules_error: null };
  } catch (error) {
    return { rules: null, rules_error: `Could not read the workflow rules from Zoho: ${(error as Error).message}` };
  }
}

/**
 * Creates the webhook and workflow rule for one module in Zoho, unless it is
 * there already. The page calls it module by module to show progress.
 */
export async function setUpZohoRule(ctx: AppContext, pageHost: string | null, entity: unknown): Promise<RuleState> {
  const rule = findRule(entity);
  if (!rule) throw new AppError('unknown_module', `Unknown Zoho module. Use one of: ${ZOHO_RULES.map((r) => r.entity).join(', ')}`);
  if (!pageHost) throw new AppError('no_page_host', 'Open this page from the Swell dashboard.');
  const connection = await loadConnection(ctx.swell, ctx.appId);
  const zoho = await createZohoClient(ctx);
  if (!connection || !zoho) throw new AppError('not_connected', 'Connect to Zoho first', 409);
  if (zoho.itemsApi !== 'inventory') throw new AppError('no_inventory', 'Webhooks are only needed with Zoho Inventory', 409);

  const secret = await ensureWebhookSecret(ctx, connection);
  const current = (await readZohoSetup(zoho, secret)).find((state) => state.entity === rule.entity)!;
  if (current.status !== 'missing') return current;
  try {
    await createZohoRule(zoho, rule, webhookUrl(pageHost, rule.topic, secret), current.webhook_id);
  } catch (error) {
    if (error instanceof SetupPermissionError) throw new AppError('needs_reconnect', error.message, 409);
    throw error;
  }
  return { ...current, status: 'ready' };
}
