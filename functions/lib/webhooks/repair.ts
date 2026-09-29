import { loadConnection, updateConnection, type Connection, type StockCatchup } from '../connection/store';
import type { AppContext } from '../swell-client';
import { createZohoClient } from '../zoho/client';
import { webhookEndpoint } from './endpoint';
import { ensureWebhookSecret } from './receive';
import { findRule, readZohoSetup, SetupPermissionError, updateZohoWebhook } from './zoho-setup';

// The key changes only with a new install; a daily look also catches webhooks edited in Zoho.
const RECHECK_MS = 24 * 60 * 60 * 1000;
// A Zoho webhook update takes about two seconds, and functions stop at 10.
const REPAIR_BUDGET_MS = 5000;

/** What recording webhooks as current writes; a new key starts the list again. */
export function currentWebhooksPatch(connection: Connection, key: string, ids: string[]): Record<string, unknown> {
  const kept = connection.webhook_public_key === key ? (connection.webhook_current_ids ?? []) : [];
  const next = [...new Set([...kept, ...ids])];
  connection.webhook_public_key = key;
  connection.webhook_current_ids = next;
  return { webhook_public_key: key, webhook_current_ids: { $set: next } };
}

/** A stock refresh of every linked item, for the changes Zoho could not deliver meanwhile. */
export function stockCatchupPatch(connection: Connection, now = Date.now()): Record<string, unknown> {
  const job: StockCatchup = { status: 'running', cursor: null, refreshed: 0, started_at: new Date(now).toISOString(), finished_at: null };
  connection.stock_catchup = job;
  return { stock_catchup: { $set: job } };
}

/**
 * Points the rules' webhooks at the current endpoint and key. They go stale
 * when the app is installed again (new install, new public key), or when an
 * install still has the first version's webhooks to the app page. Zoho is
 * read only when the key changed, or once a day. What the time budget does
 * not reach is left for the next run. Returns how many webhooks were
 * updated, or null when nothing was checked.
 */
export async function repairZohoWebhooks(ctx: AppContext, now = Date.now(), deadline = Date.now() + REPAIR_BUDGET_MS): Promise<number | null> {
  const endpoint = webhookEndpoint(ctx);
  if (!endpoint) return null;
  const connection = await loadConnection(ctx.swell, ctx.appId);
  if (connection?.status !== 'connected' || !connection.organization_id || !connection.has_inventory) return null;
  // Waits for a reconnect, which clears it.
  if (connection.webhook_repair_error) return null;
  const keyChanged = connection.webhook_public_key !== endpoint.publicKey;
  const checkedAt = connection.webhook_checked_at ? Date.parse(connection.webhook_checked_at) : 0;
  if (!keyChanged && now - checkedAt < RECHECK_MS) return null;

  const zoho = await createZohoClient(ctx);
  if (!zoho || zoho.itemsApi !== 'inventory') return null;
  const secret = await ensureWebhookSecret(ctx, connection);
  const states = await readZohoSetup(zoho, secret, endpoint, connection);

  const updated: string[] = [];
  let stockWasDown = false;
  let finished = true;
  let repairError: Connection['webhook_repair_error'] = null;
  let failure: unknown = null;
  try {
    all: for (const state of states) {
      for (const id of state.stale_webhook_ids) {
        // At least one per run, so a repair always moves on.
        if (updated.length && Date.now() >= deadline) {
          finished = false;
          break all;
        }
        await updateZohoWebhook(zoho, findRule(state.entity)!, id, endpoint, secret);
        updated.push(id);
        // A running stock rule that pointed elsewhere: its calls were lost.
        if (state.topic === 'stock' && state.status === 'outdated') stockWasDown = true;
      }
    }
  } catch (error) {
    if (error instanceof SetupPermissionError) {
      repairError = 'needs_reconnect';
    } else {
      // Keep what was done; the next run goes on.
      failure = error;
      finished = false;
    }
  }

  await updateConnection(ctx.swell, ctx.appId, connection.id, {
    ...(updated.length || (keyChanged && !repairError) ? currentWebhooksPatch(connection, endpoint.publicKey, updated) : {}),
    ...(stockWasDown && connection.stock_catchup?.status !== 'running' ? stockCatchupPatch(connection, now) : {}),
    webhook_repair_error: repairError,
    // Unfinished: the next run goes on with the rest.
    webhook_checked_at: finished ? new Date(now).toISOString() : null,
  });
  if (updated.length || repairError) {
    console.log(JSON.stringify({ zoho_webhooks_updated: updated.length, repair_error: repairError, stock_catchup: stockWasDown, finished }));
  }
  if (failure) throw failure;
  return updated.length;
}
