import type { AppContext } from '../swell-client';
import type { ZohoClient } from '../zoho/client';
import type { SwellOrder } from './document';
import { saveState, type OrderZohoState } from './state';

/** Zoho payment/refund mode for a Swell payment method. */
export function zohoPaymentMode(method: unknown): string {
  const modes: Record<string, string> = {
    card: 'creditcard',
    credit_card: 'creditcard',
    bank_deposit: 'banktransfer',
    bank_transfer: 'banktransfer',
    cash: 'cash',
    cod: 'cash',
  };
  return modes[String(method ?? '').toLowerCase()] ?? 'others';
}

/**
 * The payment recorded for the order's invoice by a run that died before it
 * could save the id: found by the order number among the invoice's payments.
 */
export async function adoptPayment(ctx: AppContext, zoho: ZohoClient, order: SwellOrder, state: OrderZohoState) {
  if (state.zoho_payment_id || !state.zoho_invoice_id) return;
  const body = await zoho.request(zoho.itemsApi, 'GET', `/invoices/${state.zoho_invoice_id}/payments`);
  const payment = (body?.payments ?? []).find((p: Record<string, any>) => p.reference_number === order.number);
  if (!payment) return;
  state.zoho_payment_id = String(payment.payment_id);
  await saveState(ctx, order.id, { zoho_payment_id: state.zoho_payment_id });
}
