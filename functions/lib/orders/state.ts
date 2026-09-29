import type { AppContext } from '../swell-client';

/** Zoho sync state kept on the order under $app.<app_id>. */
export interface OrderZohoState {
  zoho_status?: 'synced' | 'pending' | 'error' | null;
  zoho_contact_id?: string | null;
  zoho_salesorder_id?: string | null;
  zoho_salesorder_number?: string | null;
  zoho_salesorder_url?: string | null;
  zoho_invoice_id?: string | null;
  zoho_invoice_number?: string | null;
  zoho_invoice_url?: string | null;
  zoho_payment_id?: string | null;
  zoho_salesorder_confirmed?: boolean;
  zoho_salesorder_voided?: boolean;
  zoho_payment_unapplied?: boolean;
  zoho_invoice_voided?: boolean;
  zoho_creditnote_id?: string | null;
  zoho_creditnote_number?: string | null;
  zoho_creditnote_url?: string | null;
  zoho_refund_id?: string | null;
  zoho_error?: string | null;
  zoho_synced_at?: string | null;
  zoho_attempts?: number;
  zoho_retry_at?: string | null;
  zoho_continuations?: number;
  zoho_claimed_at?: string | null;
  zoho_shipping_claimed_at?: string | null;
}

export function stateOf(order: Record<string, any>, appId: string): OrderZohoState {
  return order?.$app?.[appId] ?? {};
}

/**
 * Writes Zoho state onto the order. `$app` writes deep-merge, so only the
 * given fields change. Orders do not subscribe to `order.updated`, so this
 * does not re-trigger the sync.
 */
export async function saveState(ctx: AppContext, orderId: string, patch: OrderZohoState): Promise<void> {
  await ctx.swell.put(`/orders/${orderId}`, { $app: { [ctx.appId]: patch } });
}

/** Throws when the run has used its time budget (see RUN_BUDGET_MS in ./sync). */
export type Checkpoint = () => void;
