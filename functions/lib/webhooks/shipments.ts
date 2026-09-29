import { saveState, stateOf } from '../orders/state';
import { AppError, type AppContext } from '../swell-client';
import type { ZohoClient } from '../zoho/client';
import { recordOf } from './payload';

// How long another run's mark on the order holds off this one.
const CLAIM_TTL_MS = 2 * 60 * 1000;

export class ShipmentBusyError extends Error {
  constructor() {
    super('Another shipment update for this order is running; retrying shortly');
    this.name = 'ShipmentBusyError';
  }
}

export interface ShipmentOutcome {
  status: 'processed' | 'ignored';
  note: string;
  shipment_id?: string;
}

interface Tracking {
  shipment_id: string | null;
  shipment_number: string | null;
  tracking_number: string | null;
  carrier: string | null;
  service: string | null;
}

const text = (value: unknown): string | null => (value === undefined || value === null || value === '' ? null : String(value));

function trackingOf(source: Record<string, any> | null | undefined): Tracking | null {
  if (!source) return null;
  const tracking = {
    // `shipment_order_id` in webhook payloads, `shipment_id` in API responses.
    shipment_id: text(source.shipment_id ?? source.shipment_order_id ?? source.shipmentorder_id),
    shipment_number: text(source.shipment_number),
    tracking_number: text(source.tracking_number),
    carrier: text(source.carrier ?? source.delivery_method),
    service: text(source.service),
  };
  return Object.values(tracking).some(Boolean) ? tracking : null;
}

/**
 * Shipment details for the Swell shipment: the shipment the call was about,
 * else the latest shipped package on the sales order.
 */
async function findTracking(zoho: ZohoClient, record: Record<string, any>, salesorder: Record<string, any>): Promise<Tracking | null> {
  // A Shipment Order call is the shipment itself; a Package call may carry it nested.
  const fromCall = trackingOf(record.shipment_order ?? record.shipmentorder ?? record);
  if (fromCall?.shipment_id && !fromCall.tracking_number) {
    const body = await zoho.request('inventory', 'GET', `/shipmentorders/${fromCall.shipment_id}`);
    return trackingOf(body?.shipment_order ?? body?.shipmentorder) ?? fromCall;
  }
  // A carrier alone (a sales order's delivery method) is not a shipment.
  if (fromCall?.tracking_number) return fromCall;
  const packages: Record<string, any>[] = salesorder.packages ?? [];
  const shipped = packages.filter((p) => p.shipment_id || p.tracking_number || p.shipment_order);
  const latest = shipped[shipped.length - 1];
  return latest ? trackingOf(latest.shipment_order ?? latest) : null;
}

const shippedQuantity = (line: Record<string, any>) =>
  (Number(line.quantity_shipped) || 0) + (Number(line.quantity_manuallyfulfilled) || 0);

/**
 * Order items Zoho has shipped that Swell has not: per line, Zoho's shipped
 * quantity minus Swell's delivered quantity. The sales order has one line
 * per order item, in the same order (see orders/document.ts).
 */
export function unshippedItems(
  lines: Record<string, any>[],
  items: Record<string, any>[],
): Array<{ order_item_id: string; product_id: string; variant_id?: string; quantity: number }> {
  const sorted = [...lines].sort((a, b) => (Number(a.item_order) || 0) - (Number(b.item_order) || 0));
  if (sorted.length !== items.length) {
    throw new AppError('lines_changed', 'The sales order lines in Zoho no longer match the Swell order');
  }
  return items.flatMap((item, index) => {
    const shipped = Math.min(shippedQuantity(sorted[index]), Number(item.quantity) || 0);
    const quantity = shipped - (Number(item.quantity_delivered) || 0);
    if (quantity <= 0) return [];
    return [{ order_item_id: item.id, product_id: item.product_id, ...(item.variant_id ? { variant_id: item.variant_id } : {}), quantity }];
  });
}

function trackingFields(tracking: Tracking | null) {
  return {
    ...(tracking?.tracking_number ? { tracking_code: tracking.tracking_number } : {}),
    ...(tracking?.carrier ? { carrier_name: tracking.carrier } : {}),
    ...(tracking?.service ? { service_name: tracking.service } : {}),
  };
}

/**
 * A shipment edited in Zoho after it reached Swell (tracking number added
 * or changed): copies the new tracking to the Swell shipment made from it.
 */
async function updateTracking(ctx: AppContext, tracking: Tracking | null): Promise<string | null> {
  if (!tracking?.shipment_id) return null;
  const found = await ctx.swell.get('/shipments', { where: { [`$app.${ctx.appId}.zoho_shipment_id`]: tracking.shipment_id }, limit: 1 });
  const shipment = found?.results?.[0];
  if (!shipment) return null;
  const fields: Record<string, string> = trackingFields(tracking);
  const changed = Object.entries(fields).some(([key, value]) => shipment[key] !== value);
  if (!changed) return null;
  await ctx.swell.put(`/shipments/${shipment.id}`, fields);
  return shipment.id;
}

function destinationOf(shipping: Record<string, any> | undefined) {
  if (!shipping?.address1 || !shipping.country) return undefined;
  const name = shipping.name || [shipping.first_name, shipping.last_name].filter(Boolean).join(' ');
  return {
    name: name || shipping.address1,
    address1: shipping.address1,
    address2: shipping.address2 ?? undefined,
    city: shipping.city ?? undefined,
    state: shipping.state ?? undefined,
    zip: shipping.zip ?? undefined,
    country: shipping.country,
    phone: shipping.phone ?? undefined,
  };
}

/**
 * Brings a Swell order's fulfilment up to its Zoho sales order: whatever Zoho
 * has shipped (or marked fulfilled) and Swell has not becomes one Swell
 * shipment, with the Zoho shipment's tracking number and carrier.
 */
export async function syncShipments(ctx: AppContext, zoho: ZohoClient, payload: Record<string, any>): Promise<ShipmentOutcome> {
  if (zoho.itemsApi !== 'inventory') return { status: 'ignored', note: 'Zoho Books has no shipments' };
  const record = recordOf(payload);
  const salesorderId = text(record.salesorder_id);
  if (!salesorderId) return { status: 'ignored', note: 'The call names no sales order' };

  const found = await ctx.swell.get('/orders', { where: { [`$app.${ctx.appId}.zoho_salesorder_id`]: salesorderId }, limit: 1 });
  const order = found?.results?.[0];
  if (!order) return { status: 'ignored', note: `Sales order ${salesorderId} did not come from Swell` };
  if (order.canceled) return { status: 'ignored', note: `Order #${order.number} is canceled in Swell` };

  // Zoho sends one call per rule, and a shipment can match several rules
  // at once (package shipped, shipment created): one run per order at a time.
  const claimed = Date.parse(stateOf(order, ctx.appId).zoho_shipping_claimed_at ?? '');
  if (claimed && Date.now() - claimed < CLAIM_TTL_MS) throw new ShipmentBusyError();
  await saveState(ctx, order.id, { zoho_shipping_claimed_at: new Date().toISOString() });

  try {
    const body = await zoho.request('inventory', 'GET', `/salesorders/${salesorderId}`);
    const salesorder = body?.salesorder ?? {};
    // Re-read: another run may have added a shipment since the order was listed.
    const fresh = await ctx.swell.get(`/orders/${order.id}`);
    const items = unshippedItems(salesorder.line_items ?? [], fresh?.items ?? []);
    const tracking = await findTracking(zoho, record, salesorder);
    if (!items.length) {
      const updated = await updateTracking(ctx, tracking);
      return updated
        ? { status: 'processed', note: `Updated tracking on order #${order.number}`, shipment_id: updated }
        : { status: 'ignored', note: `Nothing new to ship on order #${order.number}` };
    }

    const destination = destinationOf(fresh.shipping);
    const shipment = await ctx.swell.post('/shipments', {
      order_id: order.id,
      items,
      ...(destination ? { destination } : {}),
      ...trackingFields(tracking),
      notes: tracking?.shipment_number ? `Zoho shipment ${tracking.shipment_number}` : `Shipped in Zoho (${salesorder.salesorder_number ?? salesorderId})`,
      $app: { [ctx.appId]: { zoho_shipment_id: tracking?.shipment_id ?? null } },
    });
    const count = items.reduce((sum, item) => sum + item.quantity, 0);
    return { status: 'processed', note: `Shipped ${count} item(s) of order #${order.number}`, shipment_id: shipment?.id };
  } finally {
    await saveState(ctx, order.id, { zoho_shipping_claimed_at: null });
  }
}
