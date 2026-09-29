import { toZohoAddress } from '../contacts/address';
import { ensureContact, shippingAddressId, type SwellAccount } from '../contacts/contacts';
import { AppError, type AppContext } from '../swell-client';
import { ZohoRateLimitError, type ZohoClient } from '../zoho/client';
import { listTaxes } from '../zoho/taxes';
import { zohoWebUrl } from '../zoho/web';
import { reverseOrder } from './cancel';
import { adoptPayment, zohoPaymentMode } from './payments';
import { buildOrderDocument, zohoDate, type SwellOrder } from './document';
import { saveState, stateOf, type Checkpoint, type OrderZohoState } from './state';

// Failed orders are retried after 10 min, 20 min, 40 min … capped at a day.
const RETRY_BASE_MS = 10 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;

export function nextRetryAt(attempts: number, now = Date.now()): string {
  return new Date(now + Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS)).toISOString();
}

async function findByReference(zoho: ZohoClient, path: string, key: string, reference: string) {
  const body = await zoho.request(zoho.itemsApi, 'GET', path, { query: { reference_number: reference } });
  return (body?.[key] ?? []).find((doc: Record<string, any>) => doc.reference_number === reference) ?? null;
}

/** What one run knows beyond the saved state. */
interface Run {
  /** An earlier run stopped or died: documents may exist in Zoho without their ids saved. */
  recovering: boolean;
  checkpoint: Checkpoint;
  doc: () => Promise<Record<string, unknown>>;
  /** Sales order created in this run, with its lines */
  salesorder?: Record<string, any>;
}

async function ensureSalesOrder(ctx: AppContext, zoho: ZohoClient, order: SwellOrder, state: OrderZohoState, run: Run) {
  if (state.zoho_salesorder_id) return;
  let salesorder = run.recovering ? await findByReference(zoho, '/salesorders', 'salesorders', order.number) : null;
  if (!salesorder) {
    const body = await run.doc();
    run.checkpoint();
    salesorder = (await zoho.request('inventory', 'POST', '/salesorders', { body }))?.salesorder;
    run.salesorder = salesorder;
  }
  Object.assign(state, {
    zoho_salesorder_id: String(salesorder.salesorder_id),
    zoho_salesorder_number: salesorder.salesorder_number ?? null,
    zoho_salesorder_url: zohoWebUrl(zoho.connection, 'inventory', 'salesorders', String(salesorder.salesorder_id)),
  });
  await saveState(ctx, order.id, {
    zoho_salesorder_id: state.zoho_salesorder_id,
    zoho_salesorder_number: state.zoho_salesorder_number,
    zoho_salesorder_url: state.zoho_salesorder_url,
  });
}

/**
 * Zoho creates sales orders as drafts, and a draft reserves no stock: confirm
 * it. Invoicing confirms it too, so a sales order with an invoice is left alone.
 */
async function confirmSalesOrder(ctx: AppContext, zoho: ZohoClient, order: SwellOrder, state: OrderZohoState, run: Run) {
  if (!state.zoho_salesorder_id || state.zoho_salesorder_confirmed || state.zoho_invoice_id) return;
  const salesorder =
    run.salesorder ?? (await zoho.request('inventory', 'GET', `/salesorders/${state.zoho_salesorder_id}`))?.salesorder;
  if (salesorder?.status === 'draft') {
    run.checkpoint();
    await zoho.request('inventory', 'POST', `/salesorders/${state.zoho_salesorder_id}/status/confirmed`);
  }
  state.zoho_salesorder_confirmed = true;
  await saveState(ctx, order.id, { zoho_salesorder_confirmed: true });
}

async function invoiceBody(zoho: ZohoClient, state: OrderZohoState, run: Run) {
  const doc = await run.doc();
  if (zoho.itemsApi !== 'inventory' || !state.zoho_salesorder_id) return doc;
  // Invoice the sales order's own lines, so Zoho marks it invoiced.
  const salesorder =
    run.salesorder ?? (await zoho.request('inventory', 'GET', `/salesorders/${state.zoho_salesorder_id}`))?.salesorder;
  return {
    ...doc,
    line_items: (salesorder?.line_items ?? []).map((line: Record<string, any>) => ({
      salesorder_item_id: line.line_item_id,
      ...(line.item_id ? { item_id: line.item_id } : { name: line.name }),
      rate: line.rate,
      quantity: line.quantity,
      ...(line.discount ? { discount: line.discount } : {}),
      ...(line.tax_id ? { tax_id: line.tax_id } : {}),
    })),
  };
}

async function ensureInvoice(
  ctx: AppContext,
  zoho: ZohoClient,
  order: SwellOrder,
  state: OrderZohoState,
  run: Run,
): Promise<Record<string, any> | null> {
  if (state.zoho_invoice_id) return null;
  let invoice = run.recovering ? await findByReference(zoho, '/invoices', 'invoices', order.number) : null;
  if (!invoice) {
    const body = await invoiceBody(zoho, state, run);
    run.checkpoint();
    invoice = (await zoho.request(zoho.itemsApi, 'POST', '/invoices', { body }))?.invoice;
  }
  // Saved before anything else, so a run that dies next does not lose it.
  Object.assign(state, {
    zoho_invoice_id: String(invoice.invoice_id),
    zoho_invoice_number: invoice.invoice_number ?? null,
    zoho_invoice_url: zohoWebUrl(zoho.connection, zoho.itemsApi, 'invoices', String(invoice.invoice_id)),
  });
  await saveState(ctx, order.id, {
    zoho_invoice_id: state.zoho_invoice_id,
    zoho_invoice_number: state.zoho_invoice_number,
    zoho_invoice_url: state.zoho_invoice_url,
  });
  return invoice;
}

async function ensurePayment(
  ctx: AppContext,
  zoho: ZohoClient,
  order: SwellOrder,
  state: OrderZohoState,
  run: Run,
  invoice: Record<string, any> | null,
) {
  if (state.zoho_payment_id || !state.zoho_invoice_id) return;
  const detail =
    invoice ?? (await zoho.request(zoho.itemsApi, 'GET', `/invoices/${state.zoho_invoice_id}`))?.invoice;
  const balance = Number(detail?.balance ?? detail?.total ?? 0);
  if (!(balance > 0)) {
    // Already paid: by an earlier run of ours that did not get to save it?
    await adoptPayment(ctx, zoho, order, state);
    return;
  }
  // A draft invoice cannot take a payment; "sent" does not email anyone.
  if (!detail?.status || detail.status === 'draft') {
    run.checkpoint();
    await zoho.request(zoho.itemsApi, 'POST', `/invoices/${state.zoho_invoice_id}/status/sent`);
  }
  const paid = Number(order.payment_total ?? 0);
  // Orders marked paid by hand have no payment total: settle the invoice.
  const amount = paid > 0 ? Math.min(paid, balance) : balance;
  run.checkpoint();
  const payment = (
    await zoho.request(zoho.itemsApi, 'POST', '/customerpayments', {
      body: {
        customer_id: state.zoho_contact_id,
        payment_mode: zohoPaymentMode(order.billing?.method),
        amount,
        date: zohoDate(order.date_created),
        reference_number: order.number,
        description: `Swell order #${order.number}`,
        invoices: [{ invoice_id: state.zoho_invoice_id, amount_applied: amount }],
      },
    })
  )?.payment;
  state.zoho_payment_id = String(payment?.payment_id);
  await saveState(ctx, order.id, { zoho_payment_id: state.zoho_payment_id });
}

/**
 * The run used its time budget before finishing. Progress is saved, and the
 * order continues in the next run: order-continue starts it right away, and
 * the retry job is the fallback.
 */
export class OrderContinueError extends Error {
  constructor() {
    super('Partly synced; continuing in the next run');
    this.name = 'OrderContinueError';
  }
}

// Functions are killed at 10s, and a killed run cannot save anything. No new
// Zoho write starts after this (a Zoho call can take a couple of seconds);
// the run saves and continues in the next one.
const RUN_BUDGET_MS = 5000;

/** Thrown when another handler is still creating this order's sales order. */
export class OrderBusyError extends Error {
  constructor() {
    super('The sales order for this order is still being created; retrying shortly');
    this.name = 'OrderBusyError';
  }
}

// How long order.paid waits for order.submitted to finish before taking over.
const CLAIM_TTL_MS = 2 * 60 * 1000;

export type OrderEvent = 'submitted' | 'paid' | 'canceled' | 'refunded';

/**
 * Model events for one order run concurrently (`paid` seconds after
 * `submitted`, `refunded` right after `canceled`) and the platform offers no
 * lock. So every run marks the order before it starts and clears the mark
 * when it ends, and a run that finds a fresh mark backs off: event handlers
 * throw so the platform redelivers the event about a minute later. A mark
 * older than CLAIM_TTL_MS belongs to a run that died, and is ignored.
 */
function assertNotBusy(state: OrderZohoState) {
  const claimed = Date.parse(state.zoho_claimed_at ?? '');
  if (claimed && Date.now() - claimed < CLAIM_TTL_MS) throw new OrderBusyError();
}

function hasZohoDocuments(state: OrderZohoState): boolean {
  return Boolean(state.zoho_salesorder_id || state.zoho_invoice_id);
}

/**
 * Brings one order up to date in Zoho:
 * - placed: contact and sales order (Inventory orgs);
 * - paid: invoice from the sales order, marked sent, and the payment;
 * - canceled or fully refunded: reversed as described in ./cancel.ts.
 * Every document's id is saved on the order as soon as it exists, so a retry
 * continues where the last run stopped.
 */
export async function syncOrder(
  ctx: AppContext,
  zoho: ZohoClient,
  orderId: string,
  options: { event?: OrderEvent; budgetMs?: number } = {},
): Promise<OrderZohoState | null> {
  const deadline = Date.now() + (options.budgetMs ?? RUN_BUDGET_MS);
  const checkpoint: Checkpoint = () => {
    if (Date.now() >= deadline) throw new OrderContinueError();
  };
  const order: (SwellOrder & { refunded?: boolean; refund_total?: number }) | null = await ctx.swell.get(`/orders/${orderId}`);
  if (!order || order.draft) return null;
  const state: OrderZohoState = { ...stateOf(order, ctx.appId) };
  // Paid at checkout: the `paid` run does everything.
  if (options.event === 'submitted' && order.paid) return null;
  // Canceled before anything reached Zoho: nothing to undo.
  if (order.canceled && !hasZohoDocuments(state)) return null;

  assertNotBusy(state);
  // A leftover mark (from a run that died) or a pending/failed status means
  // Zoho may hold documents whose ids were never saved: look them up first.
  const recovering = Boolean(state.zoho_claimed_at || state.zoho_status);
  state.zoho_claimed_at = new Date().toISOString();
  await saveState(ctx, order.id, { zoho_claimed_at: state.zoho_claimed_at });

  try {
    if (!order.canceled) {
      const account: SwellAccount | null = await ctx.swell.get(`/accounts/${order.account_id}`);
      if (!account?.email) throw new AppError('no_customer', 'The order has no customer with an email address');
      const contact = await ensureContact(ctx, zoho, account, { billing: order.billing, shipping: order.shipping });
      if (state.zoho_contact_id !== contact.zoho_contact_id) {
        state.zoho_contact_id = contact.zoho_contact_id ?? null;
        await saveState(ctx, order.id, { zoho_contact_id: state.zoho_contact_id });
      }
      const shippingId = await shippingAddressId(ctx, zoho, contact, toZohoAddress(order.shipping));

      // Built at most once per run, and only if a document is created.
      let built: Record<string, unknown> | null = null;
      const run: Run = {
        recovering,
        checkpoint,
        doc: async () => {
          built ??= { ...(await buildOrderDocument(ctx, zoho, order, await listTaxes(zoho))) };
          return { ...built, customer_id: state.zoho_contact_id, ...(shippingId ? { shipping_address_id: shippingId } : {}) };
        },
      };

      if (zoho.itemsApi === 'inventory') {
        await ensureSalesOrder(ctx, zoho, order, state, run);
        // A paid order is invoiced next, which confirms the sales order anyway.
        if (!order.paid) await confirmSalesOrder(ctx, zoho, order, state, run);
      }
      if (order.paid) {
        const invoice = await ensureInvoice(ctx, zoho, order, state, run);
        await ensurePayment(ctx, zoho, order, state, run, invoice);
      }
    }

    if (order.canceled || order.refunded) {
      checkpoint();
      await reverseOrder(ctx, zoho, order, state, checkpoint);
    }

    const done: OrderZohoState = {
      zoho_status: 'synced',
      zoho_error: null,
      zoho_synced_at: new Date().toISOString(),
      zoho_attempts: 0,
      zoho_retry_at: null,
      zoho_claimed_at: null,
      zoho_continuations: 0,
    };
    await saveState(ctx, order.id, done);
    return { ...state, ...done };
  } catch (error) {
    if (error instanceof ZohoRateLimitError) {
      await saveState(ctx, order.id, { zoho_claimed_at: null });
      throw error;
    }
    if (error instanceof OrderContinueError) {
      await saveState(ctx, order.id, {
        zoho_status: 'pending',
        zoho_retry_at: new Date(Date.now() + 60 * 1000).toISOString(),
        zoho_claimed_at: null,
        zoho_continuations: (state.zoho_continuations ?? 0) + 1,
      });
      throw error;
    }
    const attempts = (state.zoho_attempts ?? 0) + 1;
    const failed: OrderZohoState = {
      zoho_status: 'error',
      zoho_error: (error as Error).message.slice(0, 500),
      zoho_attempts: attempts,
      zoho_retry_at: nextRetryAt(attempts),
      zoho_claimed_at: null,
      zoho_continuations: 0,
    };
    await saveState(ctx, order.id, failed);
    return { ...state, ...failed };
  }
}
