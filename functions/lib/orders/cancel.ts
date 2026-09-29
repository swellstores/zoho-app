import type { AppContext } from '../swell-client';
import type { ZohoClient } from '../zoho/client';
import { zohoWebUrl } from '../zoho/web';
import { zohoDate, type SwellOrder } from './document';
import { adoptPayment, zohoPaymentMode } from './payments';
import { saveState, type Checkpoint, type OrderZohoState } from './state';

// How an order is reversed in Zoho:
// - canceled before invoicing: void the sales order (releases the reservation);
// - canceled after invoicing but before anything shipped: take the payment
//   off the invoice (Zoho deletes a payment taken off its only invoice), void
//   the invoice and the sales order. Zoho ends up as if the order never
//   happened, with the voided documents kept for the record; the money in
//   and the refund in Swell net to zero, so no refund is recorded;
// - canceled after shipping, or fully refunded without a cancellation: a
//   money-only credit note (account lines, so no stock moves) and a refund of
//   it. Goods that physically come back are received in Zoho by the
//   warehouse; the app never moves stock in Zoho on its own.

type Order = SwellOrder & { refunded?: boolean; refund_total?: number };

/** Void a sales order so Zoho releases the stock it reserved. */
export async function voidSalesOrder(ctx: AppContext, zoho: ZohoClient, order: SwellOrder, state: OrderZohoState) {
  if (!state.zoho_salesorder_id || state.zoho_salesorder_voided) return;
  await zoho.request('inventory', 'POST', `/salesorders/${state.zoho_salesorder_id}/status/void`);
  state.zoho_salesorder_voided = true;
  await saveState(ctx, order.id, { zoho_salesorder_voided: true });
}

/** Has anything of this order been packed or shipped? */
async function hasShipped(zoho: ZohoClient, order: Order, state: OrderZohoState): Promise<boolean> {
  if (zoho.itemsApi === 'inventory' && state.zoho_salesorder_id) {
    const salesorder = (await zoho.request('inventory', 'GET', `/salesorders/${state.zoho_salesorder_id}`))?.salesorder ?? {};
    const moved = (salesorder.line_items ?? []).some(
      (line: Record<string, any>) => Number(line.quantity_packed) > 0 || Number(line.quantity_shipped) > 0,
    );
    return moved || Boolean(salesorder.shipped_status && salesorder.shipped_status !== 'pending');
  }
  // Books-only: Zoho knows nothing about shipping; ask Swell.
  return (order.items ?? []).some((item: Record<string, any>) => Number(item.quantity_delivered) > 0);
}

async function getPayment(zoho: ZohoClient, state: OrderZohoState) {
  return state.zoho_payment_id
    ? (await zoho.request(zoho.itemsApi, 'GET', `/customerpayments/${state.zoho_payment_id}`))?.payment ?? null
    : null;
}

/** Undo a paid order that never shipped: as if it had not happened. */
async function reverseBeforeShipment(
  ctx: AppContext,
  zoho: ZohoClient,
  order: Order,
  state: OrderZohoState,
  checkpoint: Checkpoint,
) {
  if (state.zoho_payment_id && !state.zoho_payment_unapplied) {
    // A paid invoice cannot be voided, and Zoho rejects or ignores updates
    // that change a payment's invoices. Taking the payment off the invoice is
    // a DELETE on the invoice's payment (hence the invoices.DELETE scope);
    // for a payment on this invoice only, Zoho deletes the payment.
    const payment = await getPayment(zoho, state);
    const applied = (payment?.invoices ?? []).find(
      (entry: Record<string, any>) => String(entry.invoice_id) === state.zoho_invoice_id,
    );
    if (applied?.invoice_payment_id) {
      await zoho.request(
        zoho.itemsApi,
        'DELETE',
        `/invoices/${state.zoho_invoice_id}/payments/${applied.invoice_payment_id}`,
      );
    }
    state.zoho_payment_unapplied = true;
    await saveState(ctx, order.id, { zoho_payment_unapplied: true });
  }
  if (state.zoho_invoice_id && !state.zoho_invoice_voided) {
    checkpoint();
    await zoho.request(zoho.itemsApi, 'POST', `/invoices/${state.zoho_invoice_id}/status/void`);
    state.zoho_invoice_voided = true;
    await saveState(ctx, order.id, { zoho_invoice_voided: true });
  }
  checkpoint();
  await voidSalesOrder(ctx, zoho, order, state);

  if (order.refunded && state.zoho_payment_id && !state.zoho_refund_id) {
    checkpoint();
    const payment = await getPayment(zoho, state).catch(() => null);
    // Deleted with its invoice (the usual case): nothing left to refund.
    const unused = payment ? Number(payment.unused_amount ?? 0) : 0;
    const refunded = Number(order.refund_total ?? 0);
    const amount = refunded > 0 ? Math.min(refunded, unused) : unused;
    if (amount > 0) {
      const body = await zoho.request(zoho.itemsApi, 'POST', `/customerpayments/${state.zoho_payment_id}/refunds`, {
        body: {
          date: zohoDate(undefined),
          refund_mode: zohoPaymentMode(order.billing?.method),
          amount,
          ...(payment?.account_id ? { from_account_id: payment.account_id } : {}),
          reference_number: order.number,
          description: `Refund for canceled Swell order #${order.number}`,
        },
      });
      await recordRefund(ctx, order, state, body);
    }
  }
}

async function recordRefund(ctx: AppContext, order: SwellOrder, state: OrderZohoState, body: Record<string, any> | null) {
  const refund = body?.payment_refund ?? body?.creditnote_refund ?? body?.refund ?? {};
  state.zoho_refund_id = String(
    refund.payment_refund_id ?? refund.creditnote_refund_id ?? refund.refund_id ?? 'recorded',
  );
  await saveState(ctx, order.id, { zoho_refund_id: state.zoho_refund_id });
}

async function findCreditNote(zoho: ZohoClient, reference: string) {
  const body = await zoho.request(zoho.itemsApi, 'GET', '/creditnotes', { query: { reference_number: reference } });
  return (body?.creditnotes ?? []).find((note: Record<string, any>) => note.reference_number === reference) ?? null;
}

/**
 * A money-only credit note for the whole invoice: the invoice's lines as
 * account lines (no item, so Zoho does not put anything back in stock),
 * plus shipping. The invoice and its payment stay as they are.
 */
async function ensureCreditNote(ctx: AppContext, zoho: ZohoClient, order: Order, state: OrderZohoState) {
  if (state.zoho_creditnote_id) return;
  let note = await findCreditNote(zoho, order.number);
  if (!note) {
    const invoice = (await zoho.request(zoho.itemsApi, 'GET', `/invoices/${state.zoho_invoice_id}`))?.invoice ?? {};
    // Lines pointing at the invoice's lines (invoice_item_id) are rejected for
    // a paid invoice, and item lines would restock: plain account lines.
    const lines = (invoice.line_items ?? []).map((line: Record<string, any>) => ({
      name: line.name || line.description || 'Item',
      ...(line.description ? { description: line.description } : {}),
      ...(line.account_id ? { account_id: line.account_id } : {}),
      rate: line.rate,
      quantity: line.quantity,
      ...(line.discount ? { discount: line.discount } : {}),
      ...(line.tax_id ? { tax_id: line.tax_id } : {}),
    }));
    const shipping = Number(invoice.shipping_charge) || 0;
    note = (
      await zoho.request(zoho.itemsApi, 'POST', '/creditnotes', {
        body: {
          customer_id: state.zoho_contact_id ?? invoice.customer_id,
          date: zohoDate(undefined),
          reference_number: order.number,
          is_inclusive_tax: Boolean(invoice.is_inclusive_tax),
          line_items: lines,
          ...(shipping > 0 ? { shipping_charge: shipping } : {}),
          ...(shipping > 0 && invoice.shipping_charge_tax_id ? { shipping_charge_tax_id: invoice.shipping_charge_tax_id } : {}),
          notes: `Reverses invoice ${invoice.invoice_number ?? state.zoho_invoice_number ?? ''}: Swell order #${order.number} was ${order.canceled ? 'canceled' : 'refunded'}. No stock was moved.`,
        },
      })
    )?.creditnote;
  }
  Object.assign(state, {
    zoho_creditnote_id: String(note.creditnote_id),
    zoho_creditnote_number: note.creditnote_number ?? null,
    zoho_creditnote_url: zohoWebUrl(zoho.connection, zoho.itemsApi, 'creditnotes', String(note.creditnote_id)),
  });
  await saveState(ctx, order.id, {
    zoho_creditnote_id: state.zoho_creditnote_id,
    zoho_creditnote_number: state.zoho_creditnote_number,
    zoho_creditnote_url: state.zoho_creditnote_url,
  });
}

/** Money went back in Swell: refund the credit note, from the account the payment went to. */
async function refundCreditNote(ctx: AppContext, zoho: ZohoClient, order: Order, state: OrderZohoState) {
  if (state.zoho_refund_id || !state.zoho_creditnote_id || !order.refunded) return;
  const note = (await zoho.request(zoho.itemsApi, 'GET', `/creditnotes/${state.zoho_creditnote_id}`))?.creditnote ?? {};
  const open = Number(note.balance ?? note.total ?? 0);
  const refunded = Number(order.refund_total ?? 0);
  const amount = refunded > 0 ? Math.min(refunded, open) : open;
  if (!(amount > 0)) return;
  const payment = await getPayment(zoho, state);
  const body = await zoho.request(zoho.itemsApi, 'POST', `/creditnotes/${state.zoho_creditnote_id}/refunds`, {
    body: {
      date: zohoDate(undefined),
      refund_mode: zohoPaymentMode(order.billing?.method),
      amount,
      ...(payment?.account_id ? { from_account_id: payment.account_id } : {}),
      reference_number: order.number,
      description: `Refund for Swell order #${order.number}`,
    },
  });
  await recordRefund(ctx, order, state, body);
}

/** Reverses a canceled or fully refunded order in Zoho; see the notes at the top. */
export async function reverseOrder(
  ctx: AppContext,
  zoho: ZohoClient,
  order: Order,
  state: OrderZohoState,
  checkpoint: Checkpoint = () => undefined,
) {
  if (!state.zoho_invoice_id) {
    if (order.canceled) await voidSalesOrder(ctx, zoho, order, state);
    return;
  }
  if (!order.canceled && !order.refunded) return;
  // A payment recorded by a run that died before saving its id.
  await adoptPayment(ctx, zoho, order, state);

  // Keep going the way an earlier run started.
  const started = state.zoho_creditnote_id
    ? 'credit'
    : state.zoho_payment_unapplied || state.zoho_invoice_voided
      ? 'undo'
      : null;
  const path = started ?? (order.canceled && !(await hasShipped(zoho, order, state)) ? 'undo' : 'credit');

  if (path === 'undo') {
    await reverseBeforeShipment(ctx, zoho, order, state, checkpoint);
  } else {
    await ensureCreditNote(ctx, zoho, order, state);
    checkpoint();
    await refundCreditNote(ctx, zoho, order, state);
  }
}
