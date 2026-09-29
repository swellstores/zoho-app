import { afterEach, describe, expect, it, vi } from "vitest";
import webhookEventFunction from "../../../functions/webhook-event";
import webhookMaintenanceFunction from "../../../functions/webhook-maintenance";
import { pruneEvents, retryStuckEvents } from "../../../functions/lib/webhooks/maintenance";
import { processWebhookEvent } from "../../../functions/lib/webhooks/process";
import { ShipmentBusyError, syncShipments, unshippedItems } from "../../../functions/lib/webhooks/shipments";
import { inFlightQuantities, refreshStock } from "../../../functions/lib/webhooks/stock";
import { createZohoClient } from "../../../functions/lib/zoho/client";
import { jsonResponse } from "../../helpers/fake-connection-store";
import { CONNECTED_INVENTORY, createFakeStore, fakeZoho } from "../../helpers/fake-store";
import { createMockRequest } from "../../helpers/mock-request";

const CONNECTED = { ...CONNECTED_INVENTORY, date_connected: "2026-01-01T00:00:00.000Z" };
const SHIRT = {
  id: "p1",
  name: "T-Shirt",
  stock_tracking: true,
  active: true,
  variants: {
    results: [
      { id: "v1", name: "Red", sku: "TS-RED", stock_level: 5, active: true },
      { id: "v2", name: "Blue", sku: "TS-BLUE", stock_level: 1, active: true },
    ],
  },
};
const MUG = { id: "p2", name: "Mug", sku: "MUG", stock_tracking: true, active: true, stock_level: 7 };
const ZOHO_ITEMS = [
  { item_id: "z1", item_type: "inventory", actual_available_for_sale_stock: 3 },
  { item_id: "z2", item_type: "inventory", actual_available_for_sale_stock: 4 },
  { item_id: "z3", item_type: "inventory", actual_available_for_sale_stock: 9 },
];
const now = () => new Date().toISOString();

afterEach(() => {
  vi.unstubAllGlobals();
});

function withLinks(store: ReturnType<typeof createFakeStore>) {
  store.links().push(
    { id: "l1", product_id: "p1", variant_id: "v1", zoho_item_id: "z1", zoho_tracked: true },
    { id: "l2", product_id: "p1", variant_id: "v2", zoho_item_id: "z2", zoho_tracked: true },
    { id: "l3", product_id: "p2", variant_id: null, zoho_item_id: "z3", zoho_tracked: false },
  );
  return store;
}

function stockOf(store: ReturnType<typeof createFakeStore>, productId: string, variantId?: string) {
  const product = store.products().find((p) => p.id === productId)!;
  return variantId ? product.variants.results.find((v: any) => v.id === variantId).stock_level : product.stock_level;
}

async function zohoFor(store: ReturnType<typeof createFakeStore>) {
  return (await createZohoClient(store.ctx))!;
}

describe("refreshStock", () => {
  it("sets Swell stock to Zoho's available stock for linked, tracked items only", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = withLinks(createFakeStore({ connection: CONNECTED, products: [structuredClone(SHIRT), { ...MUG }] }));

    const result = await refreshStock(store.ctx, await zohoFor(store), ["z1", "z2", "z3", "unknown"], Date.now() + 5000);

    expect(result).toEqual({ refreshed: 2, remaining: [], notes: ["TS-RED: Zoho 3, Swell 5 → 3", "TS-BLUE: Zoho 4, Swell 1 → 4"] });
    expect(stockOf(store, "p1", "v1")).toBe(3);
    expect(stockOf(store, "p1", "v2")).toBe(4);
    expect(stockOf(store, "p2")).toBe(7);
    expect(store.stock).toEqual([
      expect.objectContaining({ parent_id: "p1", variant_id: "v1", quantity: -2, reason: "missing" }),
      expect.objectContaining({ parent_id: "p1", variant_id: "v2", quantity: 3, reason: "received" }),
    ]);
  });

  it("holds back units Swell sold that Zoho has not recorded yet", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = withLinks(
      createFakeStore({
        connection: CONNECTED,
        products: [structuredClone(SHIRT)],
        orders: [
          { id: "o1", date_created: now(), items: [{ product_id: "p1", variant_id: "v1", quantity: 1 }] },
          { id: "o2", date_created: now(), items: [{ product_id: "p1", variant_id: "v1", quantity: 5 }], $app: { zoho: { zoho_salesorder_confirmed: true } } },
          { id: "o3", date_created: now(), items: [{ product_id: "p1", variant_id: "v1", quantity: 5 }], $app: { zoho: { zoho_invoice_id: "inv" } } },
          { id: "o4", date_created: now(), canceled: true, items: [{ product_id: "p1", variant_id: "v1", quantity: 5 }] },
        ],
      }),
    );

    const result = await refreshStock(store.ctx, await zohoFor(store), ["z1"], Date.now() + 5000);

    expect(stockOf(store, "p1", "v1")).toBe(2);
    expect(result.notes).toEqual(["TS-RED: Zoho 3, held 1, Swell 5 → 2"]);
  });

  it("ends at Zoho's level when another run adjusted the same item at the same time", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = withLinks(createFakeStore({ connection: CONNECTED, products: [structuredClone(SHIRT)] }));
    // A second run for the same Zoho call read the same level (5) and
    // applies its own -2 just before this run's entry lands.
    const post = store.swell.post.getMockImplementation()!;
    let raced = false;
    store.swell.post.mockImplementation(async (url: string, data: any) => {
      if (url === "/products:stock" && !raced) {
        raced = true;
        await post(url, { ...data });
      }
      return post(url, data);
    });

    await refreshStock(store.ctx, await zohoFor(store), ["z1"], Date.now() + 5000);

    expect(stockOf(store, "p1", "v1")).toBe(3);
    expect(store.stock.map((e) => e.quantity)).toEqual([-2, -2, 2]);
  });

  it("stops at the deadline after at least one unit and returns the rest", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = withLinks(createFakeStore({ connection: CONNECTED, products: [structuredClone(SHIRT)] }));

    const result = await refreshStock(store.ctx, await zohoFor(store), ["z1", "z2"], Date.now() - 1);

    expect(result).toMatchObject({ refreshed: 1, remaining: ["z2"] });
    expect(stockOf(store, "p1", "v1")).toBe(3);
    expect(stockOf(store, "p1", "v2")).toBe(1);
  });

  it("does nothing for a Zoho Books organization", async () => {
    const zohoApi = fakeZoho({ items: ZOHO_ITEMS });
    const store = withLinks(createFakeStore({ connection: { ...CONNECTED, has_inventory: false }, products: [structuredClone(SHIRT)] }));
    expect(await refreshStock(store.ctx, await zohoFor(store), ["z1"], Date.now() + 5000)).toEqual({ refreshed: 0, remaining: [], notes: [] });
    expect(zohoApi.calls("GET", "/items/")).toHaveLength(0);
  });
});

describe("inFlightQuantities", () => {
  it("counts nothing when order sync is off, or for orders from before the connection", async () => {
    const order = { id: "o1", date_created: now(), items: [{ product_id: "p1", variant_id: "v1", quantity: 2 }] };
    const off = createFakeStore({ connection: CONNECTED, orders: [order], settings: { sync: { orders: false } } });
    expect((await inFlightQuantities(off.ctx, CONNECTED.date_connected)).size).toBe(0);

    const on = createFakeStore({ connection: CONNECTED, orders: [order, { ...order, id: "o0", date_created: "2025-12-31T00:00:00.000Z" }] });
    expect(await inFlightQuantities(on.ctx, new Date(Date.now() - 60_000).toISOString())).toEqual(new Map([["p1:v1", 2]]));
  });
});

const ORDER = {
  id: "o1",
  number: "1001",
  items: [
    { id: "i1", product_id: "p1", variant_id: "v1", quantity: 2, quantity_delivered: 0 },
    { id: "i2", product_id: "p2", quantity: 1, quantity_delivered: 0 },
  ],
  shipping: { first_name: "Ann", last_name: "Lee", address1: "1 Main St", city: "Springfield", country: "US", zip: "12345" },
  $app: { zoho: { zoho_salesorder_id: "so1" } },
};
const SALES_ORDER = {
  salesorder_id: "so1",
  salesorder_number: "SO-00001",
  line_items: [
    { line_item_id: "sl2", item_id: "z3", quantity: 1, quantity_shipped: 0, item_order: 1 },
    { line_item_id: "sl1", item_id: "z1", quantity: 2, quantity_shipped: 1, item_order: 0 },
  ],
  packages: [],
};
const SHIPMENT = { shipment_id: "sh1", shipment_number: "SH-00001", salesorder_id: "so1", tracking_number: "TRK1", carrier: "DHL", service: "Express" };

describe("unshippedItems", () => {
  it("pairs sales order lines with order items and returns what Swell has not delivered", () => {
    expect(unshippedItems(SALES_ORDER.line_items, ORDER.items)).toEqual([{ order_item_id: "i1", product_id: "p1", variant_id: "v1", quantity: 1 }]);
  });

  it("counts manually fulfilled units and never ships more than was ordered", () => {
    const lines = [
      { quantity_shipped: 0, quantity_manuallyfulfilled: 5, item_order: 0 },
      { quantity_shipped: 1, item_order: 1 },
    ];
    expect(unshippedItems(lines, [ORDER.items[0], { ...ORDER.items[1], quantity_delivered: 1 }])).toEqual([
      { order_item_id: "i1", product_id: "p1", variant_id: "v1", quantity: 2 },
    ]);
  });

  it("refuses to guess when the lines no longer match", () => {
    expect(() => unshippedItems(SALES_ORDER.line_items.slice(0, 1), ORDER.items)).toThrow(/no longer match/);
  });
});

describe("syncShipments", () => {
  it("creates a Swell shipment with the Zoho shipment's tracking", async () => {
    fakeZoho({ salesorders: [structuredClone(SALES_ORDER)], shipmentorders: [SHIPMENT] });
    const store = createFakeStore({ connection: CONNECTED, orders: [structuredClone(ORDER)] });

    const outcome = await syncShipments(store.ctx, await zohoFor(store), { shipment_order: { shipment_id: "sh1", salesorder_id: "so1" } });

    expect(outcome).toMatchObject({ status: "processed", note: "Shipped 1 item(s) of order #1001" });
    expect(store.shipments()).toEqual([
      expect.objectContaining({
        order_id: "o1",
        items: [{ order_item_id: "i1", product_id: "p1", variant_id: "v1", quantity: 1 }],
        tracking_code: "TRK1",
        carrier_name: "DHL",
        service_name: "Express",
        notes: "Zoho shipment SH-00001",
        destination: expect.objectContaining({ name: "Ann Lee", address1: "1 Main St", country: "US" }),
        $app: { zoho: { zoho_shipment_id: "sh1" } },
      }),
    ]);
    expect(store.orders()[0].$app.zoho.zoho_shipping_claimed_at).toBeNull();
  });

  it("reads Zoho's default Shipment Order payload, fetching tracking it leaves out", async () => {
    const zohoApi = fakeZoho({ salesorders: [structuredClone(SALES_ORDER)], shipmentorders: [SHIPMENT] });
    const store = createFakeStore({ connection: CONNECTED, orders: [structuredClone(ORDER)] });

    await syncShipments(store.ctx, await zohoFor(store), { shipment_order: { shipment_order_id: "sh1", salesorder_id: "so1", created_time: "…" } });

    expect(store.shipments()[0]).toMatchObject({ tracking_code: "TRK1", carrier_name: "DHL", $app: { zoho: { zoho_shipment_id: "sh1" } } });
    expect(zohoApi.calls("GET", "/shipmentorders/sh1")).toHaveLength(1);
  });

  it("uses tracking from the call itself without asking Zoho again", async () => {
    const zohoApi = fakeZoho({ salesorders: [structuredClone(SALES_ORDER)] });
    const store = createFakeStore({ connection: CONNECTED, orders: [structuredClone(ORDER)] });

    await syncShipments(store.ctx, await zohoFor(store), { shipment_order: { shipment_order_id: "sh1", shipment_number: "SH-1", salesorder_id: "so1", tracking_number: "T-9", carrier: "UPS" } });

    expect(store.shipments()[0]).toMatchObject({ tracking_code: "T-9", carrier_name: "UPS", notes: "Zoho shipment SH-1" });
    expect(zohoApi.calls("GET", "/shipmentorders/")).toHaveLength(0);
  });

  it("uses tracking from the sales order's packages when the call has none", async () => {
    const zohoApi = fakeZoho({
      salesorders: [{ ...structuredClone(SALES_ORDER), packages: [{ package_id: "pk1", shipment_id: "sh9", shipment_number: "SH-9", tracking_number: "PK-TRK", delivery_method: "UPS" }] }],
    });
    const store = createFakeStore({ connection: CONNECTED, orders: [structuredClone(ORDER)] });

    await syncShipments(store.ctx, await zohoFor(store), { salesorder: { salesorder_id: "so1", delivery_method: "Courier" } });

    expect(store.shipments()[0]).toMatchObject({ tracking_code: "PK-TRK", carrier_name: "UPS", notes: "Zoho shipment SH-9" });
    expect(zohoApi.calls("GET", "/shipmentorders/")).toHaveLength(0);
  });

  it("ignores calls with nothing new, unknown sales orders and canceled orders", async () => {
    fakeZoho({ salesorders: [structuredClone(SALES_ORDER)] });
    const shipped = { ...structuredClone(ORDER), items: [{ ...ORDER.items[0], quantity_delivered: 1 }, ORDER.items[1]] };
    const store = createFakeStore({ connection: CONNECTED, orders: [shipped, { ...structuredClone(ORDER), id: "o2", canceled: true, $app: { zoho: { zoho_salesorder_id: "so2" } } }] });
    const zoho = await zohoFor(store);

    expect(await syncShipments(store.ctx, zoho, { shipment_order: { salesorder_id: "so1" } })).toMatchObject({ status: "ignored", note: "Nothing new to ship on order #1001" });
    expect(await syncShipments(store.ctx, zoho, { shipment_order: { salesorder_id: "elsewhere" } })).toMatchObject({ status: "ignored" });
    expect(await syncShipments(store.ctx, zoho, { shipment_order: { salesorder_id: "so2" } })).toMatchObject({ status: "ignored", note: "Order #1001 is canceled in Swell" });
    expect(await syncShipments(store.ctx, zoho, { note: "x" })).toMatchObject({ status: "ignored", note: "The call names no sales order" });
    expect(store.shipments()).toEqual([]);
  });

  it("copies tracking added in Zoho later onto the Swell shipment made from it", async () => {
    fakeZoho({ salesorders: [structuredClone(SALES_ORDER)] });
    const shipped = { ...structuredClone(ORDER), items: [{ ...ORDER.items[0], quantity_delivered: 1 }, ORDER.items[1]] };
    const store = createFakeStore({ connection: CONNECTED, orders: [shipped] });
    store.shipments().push({ id: "s1", order_id: "o1", $app: { zoho: { zoho_shipment_id: "sh1" } } });
    const zoho = await zohoFor(store);
    const edited = { shipment_order: { shipment_order_id: "sh1", salesorder_id: "so1", tracking_number: "LATE-1", carrier: "DHL" } };

    expect(await syncShipments(store.ctx, zoho, edited)).toMatchObject({ status: "processed", note: "Updated tracking on order #1001", shipment_id: "s1" });
    expect(store.shipments()).toEqual([expect.objectContaining({ id: "s1", tracking_code: "LATE-1", carrier_name: "DHL" })]);
    // The same edit again changes nothing.
    expect(await syncShipments(store.ctx, zoho, edited)).toMatchObject({ status: "ignored" });
  });

  it("backs off while another run holds the order", async () => {
    fakeZoho({ salesorders: [structuredClone(SALES_ORDER)] });
    const busy = { ...structuredClone(ORDER), $app: { zoho: { zoho_salesorder_id: "so1", zoho_shipping_claimed_at: now() } } };
    const store = createFakeStore({ connection: CONNECTED, orders: [busy] });
    await expect(syncShipments(store.ctx, await zohoFor(store), { salesorder_id: "so1" })).rejects.toBeInstanceOf(ShipmentBusyError);
  });
});

describe("processWebhookEvent", () => {
  const adjustment = JSON.stringify({ inventory_adjustment: { inventory_adjustment_id: "a1", line_items: [{ item_id: "z1" }, { item_id: "z2" }] } });

  function eventIn(store: ReturnType<typeof createFakeStore>, event: Record<string, any>) {
    const record = { id: "e1", status: "received", date_created: now(), ...event };
    store.events().push(record);
    return record as any;
  }

  it("refreshes stock for the items a stock call mentions", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = withLinks(createFakeStore({ connection: CONNECTED, products: [structuredClone(SHIRT)] }));
    const event = eventIn(store, { topic: "stock", source: "inventory_adjustment", body: adjustment });

    expect(await processWebhookEvent(store.ctx, event)).toBe("processed");
    expect(stockOf(store, "p1", "v1")).toBe(3);
    expect(store.events()[0]).toMatchObject({ status: "processed", note: "TS-RED: Zoho 3, Swell 5 → 3; TS-BLUE: Zoho 4, Swell 1 → 4", error: null, processed_at: expect.any(String) });
  });

  it("hands items left at the deadline to a new event", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = withLinks(createFakeStore({ connection: CONNECTED, products: [structuredClone(SHIRT)] }));
    const event = eventIn(store, { topic: "stock", source: "inventory_adjustment", body: adjustment });

    await processWebhookEvent(store.ctx, event, { budgetMs: -1 });

    expect(store.events()).toEqual([
      expect.objectContaining({ id: "e1", status: "processed" }),
      expect.objectContaining({ topic: "stock", source: "inventory_adjustment", status: "received", pending_item_ids: ["z2"] }),
    ]);
    // The continuation carries the ids, not the body.
    expect(await processWebhookEvent(store.ctx, store.events()[1] as any)).toBe("processed");
    expect(stockOf(store, "p1", "v2")).toBe(4);
  });

  it("creates the Swell shipment for a shipments call", async () => {
    fakeZoho({ salesorders: [structuredClone(SALES_ORDER)], shipmentorders: [SHIPMENT] });
    const store = createFakeStore({ connection: CONNECTED, orders: [structuredClone(ORDER)] });
    const event = eventIn(store, { topic: "shipments", body: JSON.stringify({ shipment_order: SHIPMENT }) });

    expect(await processWebhookEvent(store.ctx, event)).toBe("processed");
    expect(store.shipments()).toHaveLength(1);
  });

  it("records why a call was ignored or failed", async () => {
    fakeZoho({ fail: (url) => (url.pathname.includes("/items/") ? jsonResponse({ code: 5, message: "Zoho is down" }, 500) : undefined) });
    const store = withLinks(createFakeStore({ connection: CONNECTED, products: [structuredClone(SHIRT)] }));

    await processWebhookEvent(store.ctx, eventIn(store, { id: "e1", topic: "stock", body: '{"note":"no items"}' }));
    await processWebhookEvent(store.ctx, eventIn(store, { id: "e2", topic: "stock", body: adjustment }));

    expect(store.events()[0]).toMatchObject({ status: "ignored", note: "The call mentions no items" });
    expect(store.events()[1]).toMatchObject({ status: "error", error: expect.stringContaining("Zoho is down") });
  });

  it("ignores calls while Zoho is not connected, and never repeats a handled call", async () => {
    const zohoApi = fakeZoho({ items: ZOHO_ITEMS });
    const store = createFakeStore({ connection: { status: "disconnected" } });
    const event = eventIn(store, { topic: "stock", body: adjustment });

    expect(await processWebhookEvent(store.ctx, event)).toBe("ignored");
    expect(await processWebhookEvent(store.ctx, { ...event, status: "processed" })).toBe("processed");
    expect(zohoApi.fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a Zoho rate limit so the platform redelivers the event", async () => {
    fakeZoho({ fail: () => jsonResponse({ code: 44, message: "Too many requests" }, 429) });
    const store = withLinks(createFakeStore({ connection: CONNECTED, products: [structuredClone(SHIRT)] }));
    const event = eventIn(store, { topic: "stock", body: adjustment });

    await expect(processWebhookEvent(store.ctx, event)).rejects.toThrow(/Too many requests/);
    expect(store.events()[0].status).toBe("received");
  });

  it("runs from the webhook-event function with the created record", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = withLinks(createFakeStore({ connection: CONNECTED, products: [structuredClone(SHIRT)] }));
    const event = eventIn(store, { topic: "stock", body: adjustment });

    await webhookEventFunction(createMockRequest({ data: event, swell: store.swell as any, store: { id: "swell-apps" }, appId: "zoho" }));
    expect(store.events()[0].status).toBe("processed");

    // Event data without the record's fields: the record is read back.
    const second = eventIn(store, { id: "e2", topic: "stock", body: adjustment });
    await webhookEventFunction(createMockRequest({ data: { id: second.id }, swell: store.swell as any, store: { id: "swell-apps" }, appId: "zoho" }));
    expect(store.events()[1].status).toBe("processed");
  });
});

describe("webhook maintenance", () => {
  const old = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  it("retries calls left unprocessed, and gives up after three attempts", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = withLinks(createFakeStore({ connection: CONNECTED, products: [structuredClone(SHIRT)] }));
    const body = JSON.stringify({ item: { item_id: "z1" } });
    store.events().push(
      { id: "stuck", topic: "stock", status: "received", body, date_created: old(10) },
      { id: "hopeless", topic: "stock", status: "received", body, attempts: 3, date_created: old(20) },
      { id: "fresh", topic: "stock", status: "received", body, date_created: old(1) },
    );

    expect(await retryStuckEvents(store.ctx)).toBe(1);

    const byId = Object.fromEntries(store.events().map((e) => [e.id, e]));
    expect(byId.stuck).toMatchObject({ status: "processed", attempts: 1 });
    expect(byId.hopeless).toMatchObject({ status: "error", error: "Not processed after 3 attempts" });
    expect(byId.fresh.status).toBe("received");
    expect(stockOf(store, "p1", "v1")).toBe(3);
  });

  it("deletes handled calls older than two weeks", async () => {
    const store = createFakeStore({ connection: CONNECTED });
    store.events().push(
      { id: "old-done", status: "processed", date_created: old(15 * 24 * 60) },
      { id: "old-error", status: "error", date_created: old(15 * 24 * 60) },
      { id: "old-waiting", status: "received", date_created: old(15 * 24 * 60) },
      { id: "recent", status: "processed", date_created: old(60) },
    );

    expect(await pruneEvents(store.ctx)).toBe(2);
    expect(store.events().map((e) => e.id)).toEqual(["old-waiting", "recent"]);
  });

  it("runs both from the maintenance cron", async () => {
    const store = createFakeStore({ connection: { status: "disconnected" } });
    store.events().push(
      { id: "stuck", topic: "stock", status: "received", body: "{}", date_created: old(10) },
      { id: "old", status: "ignored", date_created: old(15 * 24 * 60) },
    );

    await webhookMaintenanceFunction(createMockRequest({ swell: store.swell as any, store: { id: "swell-apps" }, appId: "zoho" }));

    expect(store.events()).toEqual([expect.objectContaining({ id: "stuck", status: "ignored" })]);
  });
});
