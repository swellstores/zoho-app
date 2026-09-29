import { loadConnection, updateConnection, type Connection, type StockCatchup } from '../connection/store';
import { AppError, type AppContext } from '../swell-client';
import { createZohoClient } from '../zoho/client';
import { TOKEN_HEADER, TOPIC_HEADER, webhookEndpoint, type WebhookEndpoint } from './endpoint';
import { ensureWebhookSecret } from './receive';
import { currentWebhooksPatch, stockCatchupPatch } from './repair';
import { createZohoRule, findRule, readZohoSetup, SetupPermissionError, updateZohoWebhook, ZOHO_RULES, type RuleState } from './zoho-setup';

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

/** What a webhook set up by hand in Zoho needs: this URL, these headers, and the topic header. */
export interface ManualWebhook {
  url: string;
  headers: Array<{ name: string; value: string }>;
  /** Its value is `shipments` for shipment orders and `stock` for every other module */
  topic_header: string;
}

export interface WebhooksStatus {
  /** Stock and shipments exist only in Zoho Inventory */
  applies: boolean;
  manual: ManualWebhook | null;
  shipments: { last_received_at: string | null };
  stock: { last_received_at: string | null };
  /** The workflow rules in Zoho, one per module; null when Zoho could not be read */
  rules: RuleState[] | null;
  rules_error: string | null;
  /** Why the app could not update the webhooks by itself */
  repair_error: Connection['webhook_repair_error'];
  stock_catchup: StockCatchup | null;
  failures: Array<{ id: string; topic: string; source: string | null; error: string | null; date_created: string }>;
}

export async function getWebhooksStatus(ctx: AppContext): Promise<WebhooksStatus> {
  const connection = await loadConnection(ctx.swell, ctx.appId);
  const applies = Boolean(connection?.has_inventory);
  const status: WebhooksStatus = {
    applies,
    manual: null,
    shipments: { last_received_at: connection?.webhook_shipments_at ?? null },
    stock: { last_received_at: connection?.webhook_stock_at ?? null },
    rules: null,
    rules_error: null,
    repair_error: connection?.webhook_repair_error ?? null,
    stock_catchup: connection?.stock_catchup ?? null,
    failures: [],
  };
  if (!connection || !applies) return status;

  const secret = await ensureWebhookSecret(ctx, connection);
  const endpoint = webhookEndpoint(ctx);
  if (endpoint) {
    status.manual = {
      url: endpoint.url,
      headers: [
        { name: 'Authorization', value: endpoint.publicKey },
        { name: TOKEN_HEADER, value: secret },
      ],
      topic_header: TOPIC_HEADER,
    };
  }
  const since = new Date(Date.now() - FAILURE_WINDOW_MS).toISOString();
  const [failed, rules] = await Promise.all([
    ctx.swell.get(EVENTS, { where: { status: 'error', date_created: { $gte: since } }, sort: 'date_created desc', limit: 5 }),
    readRules(ctx, connection, secret, endpoint),
  ]);
  Object.assign(status, rules);
  // The maintenance job checks again on its next minute instead of next day.
  if (rules.rules?.some((r) => r.stale_webhook_ids.length) && connection.webhook_checked_at) {
    await updateConnection(ctx.swell, ctx.appId, connection.id, { webhook_checked_at: null });
  }
  status.failures = (failed?.results ?? []).map((e: Record<string, any>) => ({
    id: e.id,
    topic: e.topic,
    source: e.source ? sourceLabel(e.source) : null,
    error: e.error ?? null,
    date_created: e.date_created,
  }));
  return status;
}

async function readRules(
  ctx: AppContext,
  connection: Connection,
  secret: string,
  endpoint: WebhookEndpoint | null,
): Promise<Pick<WebhooksStatus, 'rules' | 'rules_error'>> {
  if (!endpoint) return { rules: null, rules_error: 'Open this page from the Swell dashboard to see the workflow rules.' };
  try {
    const zoho = await createZohoClient(ctx);
    if (!zoho) return { rules: null, rules_error: 'Zoho is not connected' };
    return { rules: await readZohoSetup(zoho, secret, endpoint, connection), rules_error: null };
  } catch (error) {
    return { rules: null, rules_error: `Could not read the workflow rules from Zoho: ${(error as Error).message}` };
  }
}

/**
 * Sets up one module in Zoho: creates the webhook and workflow rule when
 * missing, and points webhooks that have an old address or key at the
 * current one. The page calls it module by module to show progress.
 */
export async function setUpZohoRule(ctx: AppContext, entity: unknown): Promise<RuleState> {
  const rule = findRule(entity);
  if (!rule) throw new AppError('unknown_module', `Unknown Zoho module. Use one of: ${ZOHO_RULES.map((r) => r.entity).join(', ')}`);
  const endpoint = webhookEndpoint(ctx);
  if (!endpoint) throw new AppError('no_public_key', 'Open this page from the Swell dashboard.');
  const connection = await loadConnection(ctx.swell, ctx.appId);
  const zoho = await createZohoClient(ctx);
  if (!connection || !zoho) throw new AppError('not_connected', 'Connect to Zoho first', 409);
  if (zoho.itemsApi !== 'inventory') throw new AppError('no_inventory', 'Webhooks are only needed with Zoho Inventory', 409);

  const secret = await ensureWebhookSecret(ctx, connection);
  const current = (await readZohoSetup(zoho, secret, endpoint, connection)).find((state) => state.entity === rule.entity)!;
  if (current.status !== 'missing' && !current.stale_webhook_ids.length) return current;

  const done: string[] = [];
  try {
    if (current.status === 'missing') done.push(await createZohoRule(zoho, rule, endpoint, secret, current.webhook_id));
    for (const id of current.stale_webhook_ids.filter((stale) => !done.includes(stale))) {
      await updateZohoWebhook(zoho, rule, id, endpoint, secret);
      done.push(id);
    }
  } catch (error) {
    if (error instanceof SetupPermissionError) throw new AppError('needs_reconnect', error.message, 409);
    throw error;
  } finally {
    if (done.length) {
      await updateConnection(ctx.swell, ctx.appId, connection.id, {
        ...currentWebhooksPatch(connection, endpoint.publicKey, done),
        // A running stock rule pointed elsewhere: catch up on what it missed.
        ...(current.topic === 'stock' && current.status === 'outdated' && connection.stock_catchup?.status !== 'running'
          ? stockCatchupPatch(connection)
          : {}),
      });
    }
  }
  return { ...current, status: current.status === 'inactive' ? 'inactive' : 'ready', stale_webhook_ids: [] };
}
