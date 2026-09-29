import { afterEach, describe, expect, it, vi } from "vitest";
import accountSyncFunction from "../../../functions/account-sync";
import orderContinueFunction from "../../../functions/order-continue";
import orderSyncFunction from "../../../functions/order-sync";
import { awaitsContinuation, continueOrder, MAX_CONTINUATIONS } from "../../../functions/lib/orders/continue";
import { retryFailedOrders } from "../../../functions/lib/orders/retry";
import { nextRetryAt, OrderBusyError, OrderContinueError, syncOrder } from "../../../functions/lib/orders/sync";
import { createZohoClient } from "../../../functions/lib/zoho/client";
import { jsonResponse } from "../../helpers/fake-connection-store";
import { CONNECTED_INVENTORY, createFakeStore, fakeZoho } from "../../helpers/fake-store";
import { createMockRequest } from "../../helpers/mock-request";

const MUG = { id: "p2", name: "Mug", sku: "MUG-1", price: 10, active: true, stock_tracking: true, stock_level: 7 };
const ACCOUNT = { id: "a1", email: "jane@example.com", first_name: "Jane", last_name: "Doe", name: "Jane Doe" };
const WARSAW = { name: "Jane Doe", address1: "1 Main St", city: "Warsaw", zip: "00-001", country: "PL" };
const TAXES = [
  { tax_id: "t8", tax_name: "VAT 8", tax_percentage: 8, tax_type: "tax" },
  { tax_id: "t23", tax_name: "VAT 23", tax_percentage: 23, tax_type: "tax" },
];

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "o1",
    number: "1001",
    account_id: "a1",
    date_created: "2026-09-25T10:00:00.000Z",
    paid: false,
    items: [
      { id: "i1", product_id: "p2", product_name: "Mug", quantity: 2, price: 10, discount_total: 2, taxes: [{ id: "vat", amount: 4.14 }] },
    ],
    taxes: [{ id: "vat", name: "VAT", rate: 23 }],
    shipment_total: 5,
    shipment_tax: 0,
    payment_total: 0,
    billing: { ...WARSAW, method: "card" },
    shipping: WARSAW,
    ...overrides,
  };
}

function setup(options: { orders?: Record<string, unknown>[]; connection?: Record<string, unknown>; settings?: Record<string, unknown> } = {}) {
  return createFakeStore({
    connection: options.connection ?? CONNECTED_INVENTORY,
    products: [MUG],
    accounts: [ACCOUNT],
    orders: options.orders ?? [order()],
    settings: options.settings,
  });
}

async function zohoFor(store: ReturnType<typeof createFakeStore>) {
  return (await createZohoClient(store.ctx))!;
}

const stateOf = (store: ReturnType<typeof createFakeStore>, id = "o1") =>
  store.orders().find((o) => o.id === id)!.$app?.zoho ?? {};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncOrder: placed order (Inventory)", () => {
  it("creates the contact, the item and a sales order with tax, discount and shipping", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup();

    const state = await syncOrder(store.ctx, await zohoFor(store), "o1");

    expect(zoho.contacts).toEqual([
      expect.objectContaining({
        contact_name: "Jane Doe",
        contact_type: "customer",
        email: "jane@example.com",
        billing_address: expect.objectContaining({ attention: "Jane Doe", address: "1 Main St", city: "Warsaw" }),
      }),
    ]);
    expect(zoho.items).toEqual([expect.objectContaining({ sku: "MUG-1" })]);
    expect(zoho.salesorders).toEqual([
      expect.objectContaining({
        customer_id: zoho.contacts[0].contact_id,
        reference_number: "1001",
        date: "2026-09-25",
        discount_type: "item_level",
        shipping_charge: 5,
        shipping_address_id: zoho.contacts[0].shipping_address.address_id,
        line_items: [expect.objectContaining({ item_id: zoho.items[0].item_id, rate: 10, quantity: 2, discount: 2, tax_id: "t23" })],
      }),
    ]);
    expect(zoho.invoices).toHaveLength(0);
    // Zoho creates it as a draft, which reserves nothing.
    expect(zoho.salesorders[0].status).toBe("confirmed");
    expect(state).toMatchObject({ zoho_status: "synced", zoho_salesorder_id: zoho.salesorders[0].salesorder_id, zoho_salesorder_confirmed: true });
    expect(stateOf(store)).toMatchObject({
      zoho_status: "synced",
      zoho_contact_id: zoho.contacts[0].contact_id,
      zoho_salesorder_number: zoho.salesorders[0].salesorder_number,
      zoho_salesorder_url: `https://inventory.zoho.eu/app/org1#/salesorders/${zoho.salesorders[0].salesorder_id}`,
    });
  });

  it("links an existing Zoho contact by email instead of creating one", async () => {
    const zoho = fakeZoho({ taxes: TAXES, contacts: [{ contact_id: "c9", contact_name: "J. Doe (Zoho)", email: "jane@example.com" }] });
    const store = setup();

    await syncOrder(store.ctx, await zohoFor(store), "o1");

    expect(zoho.contacts).toHaveLength(1);
    expect(zoho.contacts[0].contact_name).toBe("J. Doe (Zoho)");
    expect(store.contactLinks()).toEqual([expect.objectContaining({ account_id: "a1", zoho_contact_id: "c9" })]);
    expect(zoho.salesorders[0].customer_id).toBe("c9");
  });

  it("adds a new shipping address to the contact once, then reuses it", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const krakow = { ...WARSAW, address1: "5 Market Sq", city: "Krakow" };
    const store = setup({ orders: [order(), order({ id: "o2", number: "1002", shipping: krakow }), order({ id: "o3", number: "1003", shipping: krakow })] });
    const client = await zohoFor(store);

    for (const id of ["o1", "o2", "o3"]) await syncOrder(store.ctx, client, id);

    const [contact] = zoho.contacts;
    expect(contact.addresses).toHaveLength(1);
    expect(zoho.salesorders[1].shipping_address_id).toBe(contact.addresses[0].address_id);
    expect(zoho.salesorders[2].shipping_address_id).toBe(contact.addresses[0].address_id);
  });

  it("confirms a sales order an earlier run created but did not confirm", async () => {
    const zoho = fakeZoho({ taxes: TAXES, salesorders: [{ salesorder_id: "so1", salesorder_number: "SO-1", reference_number: "1001", status: "draft" }] });
    const store = setup({ orders: [order({ $app: { zoho: { zoho_salesorder_id: "so1", zoho_status: "pending" } } })] });

    await syncOrder(store.ctx, await zohoFor(store), "o1");

    expect(zoho.salesorders[0].status).toBe("confirmed");
    expect(stateOf(store)).toMatchObject({ zoho_salesorder_confirmed: true, zoho_status: "synced" });
  });

  it("adopts a sales order left by a run that died before saving it", async () => {
    const zoho = fakeZoho({ taxes: TAXES, salesorders: [{ salesorder_id: "so1", salesorder_number: "SO-1", reference_number: "1001" }] });
    // The dead run left its mark behind.
    const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const store = setup({ orders: [order({ $app: { zoho: { zoho_claimed_at: stale } } })] });

    await syncOrder(store.ctx, await zohoFor(store), "o1");

    expect(zoho.salesorders).toHaveLength(1);
    expect(stateOf(store).zoho_salesorder_id).toBe("so1");
  });

  it("skips the look-up for leftovers on a first run", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ paid: true, payment_total: 23 })] });

    await syncOrder(store.ctx, await zohoFor(store), "o1", { event: "paid" });

    expect(zoho.fetchMock.mock.calls.filter(([u]) => String(u).includes("reference_number="))).toHaveLength(0);
    expect(zoho.fetchMock.mock.calls.filter(([u, r]) => (r?.method ?? "GET") === "GET" && /\/salesorders\/\w+\?/.test(String(u)))).toHaveLength(0);
    expect(stateOf(store).zoho_status).toBe("synced");
  });

  it("does nothing for drafts and canceled orders", async () => {
    fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ draft: true }), order({ id: "o2", canceled: true })] });
    const client = await zohoFor(store);
    expect(await syncOrder(store.ctx, client, "o1")).toBeNull();
    expect(await syncOrder(store.ctx, client, "o2")).toBeNull();
  });
});

describe("syncOrder: paid order", () => {
  it("invoices the sales order's lines, marks the invoice sent and records the payment", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ paid: true, payment_total: 23 })] });

    await syncOrder(store.ctx, await zohoFor(store), "o1");

    const [salesorder] = zoho.salesorders;
    const [invoice] = zoho.invoices;
    expect(invoice.line_items).toEqual([
      expect.objectContaining({ salesorder_item_id: salesorder.line_items[0].line_item_id, item_id: salesorder.line_items[0].item_id, tax_id: "t23" }),
    ]);
    expect(invoice.status).toBe("sent");
    expect(zoho.payments).toEqual([
      expect.objectContaining({
        customer_id: zoho.contacts[0].contact_id,
        payment_mode: "creditcard",
        amount: 23,
        reference_number: "1001",
        invoices: [expect.objectContaining({ invoice_id: invoice.invoice_id, amount_applied: 23 })],
      }),
    ]);
    expect(stateOf(store)).toMatchObject({
      zoho_status: "synced",
      zoho_invoice_id: invoice.invoice_id,
      zoho_payment_id: zoho.payments[0].payment_id,
      zoho_invoice_url: `https://inventory.zoho.eu/app/org1#/invoices/${invoice.invoice_id}`,
    });
  });

  it("settles the whole invoice for orders marked paid by hand", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ paid: true, payment_total: 0 })] });

    await syncOrder(store.ctx, await zohoFor(store), "o1");

    expect(zoho.payments[0].amount).toBe(zoho.invoices[0].total);
    expect(zoho.payments[0].payment_mode).toBe("creditcard");
  });

  it("adds only what is missing when the order is paid after it was placed", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup();
    const client = await zohoFor(store);
    await syncOrder(store.ctx, client, "o1");

    Object.assign(store.orders()[0], { paid: true, payment_total: 23 });
    await syncOrder(store.ctx, client, "o1");
    await syncOrder(store.ctx, client, "o1");

    expect(zoho.salesorders).toHaveLength(1);
    expect(zoho.invoices).toHaveLength(1);
    expect(zoho.payments).toHaveLength(1);
    expect(zoho.contacts).toHaveLength(1);
  });

  it("invoices directly in Books-only organizations, without a sales order", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ connection: { ...CONNECTED_INVENTORY, has_inventory: false }, orders: [order({ paid: true, payment_total: 23 })] });

    await syncOrder(store.ctx, await zohoFor(store), "o1");

    expect(zoho.salesorders).toHaveLength(0);
    expect(zoho.invoices[0].line_items).toEqual([expect.objectContaining({ item_id: zoho.items[0].item_id, tax_id: "t23", discount: 2 })]);
    expect(String(zoho.calls("POST", "/invoices")[0][0])).toContain("/books/v3/invoices");
    expect(stateOf(store).zoho_invoice_url).toContain("https://books.zoho.eu/app/org1#/invoices/");
    expect(zoho.payments).toHaveLength(1);
  });
});

describe("syncOrder: failures", () => {
  it("records a missing Zoho tax on the order and schedules a retry", async () => {
    const zoho = fakeZoho({ taxes: [TAXES[0]] });
    const store = setup();

    const state = await syncOrder(store.ctx, await zohoFor(store), "o1");

    expect(state).toMatchObject({ zoho_status: "error", zoho_attempts: 1 });
    expect(stateOf(store).zoho_error).toMatch(/no tax with a rate of 23%/);
    expect(Date.parse(stateOf(store).zoho_retry_at)).toBeGreaterThan(Date.now());
    expect(zoho.salesorders).toHaveLength(0);
  });

  it("refuses lines with more than one tax", async () => {
    fakeZoho({ taxes: TAXES });
    const store = setup({
      orders: [
        order({
          items: [{ id: "i1", product_id: "p2", product_name: "Mug", quantity: 1, price: 10, taxes: [{ id: "a", amount: 1 }, { id: "b", amount: 1 }] }],
          taxes: [{ id: "a", rate: 8 }, { id: "b", rate: 23 }],
        }),
      ],
    });

    await syncOrder(store.ctx, await zohoFor(store), "o1");

    expect(stateOf(store).zoho_error).toMatch(/more than one tax/);
  });

  it("clears the error once a retry succeeds", async () => {
    let taxes = [TAXES[0]];
    const zoho = fakeZoho({ taxes: TAXES, fail: (url) => (url.pathname.endsWith("/settings/taxes") ? jsonResponse({ code: 0, taxes }) : undefined) });
    const store = setup();
    const client = await zohoFor(store);
    await syncOrder(store.ctx, client, "o1");

    taxes = TAXES;
    await syncOrder(store.ctx, client, "o1");

    expect(stateOf(store)).toMatchObject({ zoho_status: "synced", zoho_error: null, zoho_attempts: 0, zoho_retry_at: null });
    expect(zoho.salesorders).toHaveLength(1);
  });

  it("lets a Zoho rate limit through so the event is redelivered", async () => {
    fakeZoho({ fail: () => jsonResponse({ code: 45, message: "exceeded the maximum number of requests per minute" }, 429) });
    const store = setup();
    await expect(syncOrder(store.ctx, await zohoFor(store), "o1")).rejects.toMatchObject({ name: "ZohoRateLimitError" });
  });

  it("backs off 10 minutes, then doubles up to a day", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(Date.parse(nextRetryAt(1, now)) - now).toBe(10 * 60 * 1000);
    expect(Date.parse(nextRetryAt(3, now)) - now).toBe(40 * 60 * 1000);
    expect(Date.parse(nextRetryAt(20, now)) - now).toBe(24 * 60 * 60 * 1000);
  });
});

describe("submitted and paid arriving close together", () => {
  it("submitted marks the order before anything else, and clears the mark once done", async () => {
    fakeZoho({ taxes: TAXES });
    const store = setup();

    await syncOrder(store.ctx, await zohoFor(store), "o1", { event: "submitted" });

    const [firstWrite] = store.swell.put.mock.calls;
    expect(firstWrite[0]).toBe("/orders/o1");
    expect(firstWrite[1]).toEqual({ $app: { zoho: { zoho_claimed_at: expect.any(String) } } });
    expect(stateOf(store)).toMatchObject({ zoho_status: "synced", zoho_claimed_at: null });
  });

  it("paid waits while submitted is still creating the sales order", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({
      orders: [order({ paid: true, $app: { zoho: { zoho_claimed_at: new Date(Date.now() - 5000).toISOString() } } })],
    });

    await expect(syncOrder(store.ctx, await zohoFor(store), "o1", { event: "paid" })).rejects.toBeInstanceOf(OrderBusyError);
    expect(zoho.fetchMock).not.toHaveBeenCalled();
  });

  it("paid carries on once the mark is cleared, or when it is stale", async () => {
    const zoho = fakeZoho({ taxes: TAXES, salesorders: [{ salesorder_id: "so1", salesorder_number: "SO-1", reference_number: "1002", line_items: [] }] });
    const stale = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const store = setup({
      orders: [
        order({ paid: true, payment_total: 23, $app: { zoho: { zoho_claimed_at: stale } } }),
        order({ id: "o2", number: "1002", paid: true, payment_total: 23, $app: { zoho: { zoho_claimed_at: null, zoho_salesorder_id: "so1" } } }),
      ],
    });
    const client = await zohoFor(store);

    await syncOrder(store.ctx, client, "o1", { event: "paid" });
    await syncOrder(store.ctx, client, "o2", { event: "paid" });

    expect(stateOf(store, "o1").zoho_status).toBe("synced");
    expect(stateOf(store, "o2").zoho_invoice_id).toBeTruthy();
    expect(zoho.salesorders).toHaveLength(2);
  });

  it("any event backs off while another run holds the order", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ canceled: true, $app: { zoho: { zoho_salesorder_id: "so1", zoho_claimed_at: new Date().toISOString() } } })] });

    await expect(syncOrder(store.ctx, await zohoFor(store), "o1", { event: "canceled" })).rejects.toBeInstanceOf(OrderBusyError);
    expect(zoho.fetchMock).not.toHaveBeenCalled();
  });

  it("the paid event is redelivered when it has to wait", async () => {
    fakeZoho({ taxes: TAXES });
    const store = setup({
      orders: [order({ paid: true, $app: { zoho: { zoho_claimed_at: new Date().toISOString() } } })],
    });
    const request = createMockRequest({
      data: { id: "o1", $event: { id: "e", type: "order.paid", model: "orders", data: {} } },
      swell: store.swell,
      store: { id: "swell-apps" },
      appId: "zoho",
    });

    await expect(orderSyncFunction(request)).rejects.toBeInstanceOf(OrderBusyError);
  });
});

describe("cancellations and refunds", () => {
  async function paidAndSynced(overrides: Record<string, unknown> = {}, connection = CONNECTED_INVENTORY) {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ connection, orders: [order({ paid: true, payment_total: 23, ...overrides })] });
    const client = await zohoFor(store);
    await syncOrder(store.ctx, client, "o1", { event: "paid" });
    return { zoho, store, client };
  }

  it("voids the sales order of an order canceled before payment, once", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup();
    const client = await zohoFor(store);
    await syncOrder(store.ctx, client, "o1", { event: "submitted" });

    store.orders()[0].canceled = true;
    await syncOrder(store.ctx, client, "o1", { event: "canceled" });
    await syncOrder(store.ctx, client, "o1");

    expect(zoho.salesorders[0].status).toBe("void");
    expect(zoho.calls("POST", "/status/void")).toHaveLength(1);
    expect(stateOf(store)).toMatchObject({ zoho_status: "synced", zoho_salesorder_voided: true });
    expect(zoho.creditnotes).toHaveLength(0);
  });

  it("ignores a canceled order that never reached Zoho", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ canceled: true })] });

    expect(await syncOrder(store.ctx, await zohoFor(store), "o1", { event: "canceled" })).toBeNull();
    expect(zoho.fetchMock).not.toHaveBeenCalled();
  });

  it("undoes a paid order canceled before shipping: payment removed, invoice and sales order voided", async () => {
    const { zoho, store, client } = await paidAndSynced();

    store.orders()[0].canceled = true;
    await syncOrder(store.ctx, client, "o1", { event: "canceled" });

    expect(zoho.calls("DELETE", "/payments/")).toHaveLength(1);
    // Zoho deletes a payment taken off its only invoice.
    expect(zoho.payments).toHaveLength(0);
    expect(zoho.invoices[0].status).toBe("void");
    expect(zoho.salesorders[0].status).toBe("void");
    expect(zoho.creditnotes).toHaveLength(0);
    expect(stateOf(store)).toMatchObject({
      zoho_status: "synced",
      zoho_payment_unapplied: true,
      zoho_invoice_voided: true,
      zoho_salesorder_voided: true,
    });
  });

  it("records no refund for such an order: money in and out net to zero in Zoho", async () => {
    const { zoho, store, client } = await paidAndSynced();
    store.orders()[0].canceled = true;
    await syncOrder(store.ctx, client, "o1", { event: "canceled" });

    Object.assign(store.orders()[0], { refunded: true, refund_total: 23 });
    await syncOrder(store.ctx, client, "o1", { event: "refunded" });

    expect(zoho.refunds).toHaveLength(0);
    expect(stateOf(store)).toMatchObject({ zoho_status: "synced", zoho_error: null });
  });

  it("handles cancel and refund arriving as one change", async () => {
    const { zoho, store, client } = await paidAndSynced();

    Object.assign(store.orders()[0], { canceled: true, refunded: true, refund_total: 23 });
    await syncOrder(store.ctx, client, "o1", { event: "canceled" });

    expect(zoho.invoices[0].status).toBe("void");
    expect(zoho.salesorders[0].status).toBe("void");
    expect(stateOf(store).zoho_status).toBe("synced");
  });

  it("credits a shipped order with money-only lines, so no stock moves, then refunds the credit note", async () => {
    const { zoho, store, client } = await paidAndSynced();
    zoho.salesorders[0].shipped_status = "shipped";

    store.orders()[0].canceled = true;
    await syncOrder(store.ctx, client, "o1", { event: "canceled" });
    Object.assign(store.orders()[0], { refunded: true, refund_total: 23 });
    await syncOrder(store.ctx, client, "o1", { event: "refunded" });

    const [invoice] = zoho.invoices;
    expect(zoho.creditnotes).toEqual([
      expect.objectContaining({
        customer_id: zoho.contacts[0].contact_id,
        reference_number: "1001",
        shipping_charge: 5,
        notes: expect.stringContaining(`Reverses invoice ${invoice.invoice_number}`),
        line_items: [expect.objectContaining({ name: invoice.line_items[0].name, account_id: "sales", rate: 10, quantity: 2, discount: 2, tax_id: "t23" })],
      }),
    ]);
    // Item lines would put goods back in stock; lines pointing at a paid
    // invoice's lines are rejected by Zoho.
    expect(zoho.creditnotes[0].line_items[0]).not.toHaveProperty("item_id");
    expect(zoho.creditnotes[0].line_items[0]).not.toHaveProperty("invoice_item_id");
    expect(zoho.invoices[0].status).not.toBe("void");
    expect(zoho.refunds).toEqual([expect.objectContaining({ creditnote_id: zoho.creditnotes[0].creditnote_id, amount: 23, from_account_id: "undeposited" })]);
  });

  it("treats a full refund without a cancellation as money-only: credit note, then refund", async () => {
    const { zoho, store, client } = await paidAndSynced();

    Object.assign(store.orders()[0], { refunded: true, refund_total: 23 });
    await syncOrder(store.ctx, client, "o1", { event: "refunded" });

    expect(zoho.invoices[0].status).not.toBe("void");
    expect(zoho.creditnotes).toHaveLength(1);
    expect(zoho.refunds).toHaveLength(1);
  });

  it("undoes a canceled paid order in a Books-only organization unless Swell delivered it", async () => {
    const booksOnly = { ...CONNECTED_INVENTORY, has_inventory: false };
    const undelivered = await paidAndSynced({}, booksOnly);
    undelivered.store.orders()[0].canceled = true;
    await syncOrder(undelivered.store.ctx, undelivered.client, "o1", { event: "canceled" });
    expect(undelivered.zoho.invoices[0].status).toBe("void");
    expect(undelivered.zoho.creditnotes).toHaveLength(0);

    const delivered = await paidAndSynced({}, booksOnly);
    delivered.store.orders()[0].canceled = true;
    delivered.store.orders()[0].items[0].quantity_delivered = 2;
    await syncOrder(delivered.store.ctx, delivered.client, "o1", { event: "canceled" });
    expect(delivered.zoho.creditnotes).toHaveLength(1);
  });

  it("adopts a credit note left by a run that failed before saving it", async () => {
    const { zoho, store, client } = await paidAndSynced();
    zoho.salesorders[0].shipped_status = "shipped";
    zoho.creditnotes.push({ creditnote_id: "cn9", creditnote_number: "CN-9", reference_number: "1001", balance: 28 });

    store.orders()[0].canceled = true;
    await syncOrder(store.ctx, client, "o1", { event: "canceled" });

    expect(zoho.creditnotes).toHaveLength(1);
    expect(stateOf(store).zoho_creditnote_id).toBe("cn9");
  });
});

describe("runs that stop early or die", () => {
  it("stops at its time budget, saves progress as pending, and finishes in the next run", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ paid: true, payment_total: 23 })] });
    const client = await zohoFor(store);

    await expect(syncOrder(store.ctx, client, "o1", { event: "paid", budgetMs: 0 })).rejects.toBeInstanceOf(OrderContinueError);
    expect(stateOf(store)).toMatchObject({ zoho_status: "pending", zoho_claimed_at: null, zoho_contact_id: zoho.contacts[0].contact_id });
    expect(Date.parse(stateOf(store).zoho_retry_at)).toBeGreaterThan(Date.now());
    expect(zoho.salesorders).toHaveLength(0);

    await syncOrder(store.ctx, client, "o1", { event: "paid" });
    expect(stateOf(store).zoho_status).toBe("synced");
    expect(zoho.payments).toHaveLength(1);
  });

  it("finds a payment a killed run recorded but never saved, instead of paying twice", async () => {
    const { zoho, store, client } = await (async () => {
      const zoho = fakeZoho({ taxes: TAXES });
      const store = setup({ orders: [order({ paid: true, payment_total: 23 })] });
      const client = await zohoFor(store);
      await syncOrder(store.ctx, client, "o1", { event: "paid" });
      return { zoho, store, client };
    })();
    // The run died right after recording the payment.
    Object.assign(store.orders()[0].$app.zoho, { zoho_payment_id: undefined, zoho_status: undefined });

    await syncOrder(store.ctx, client, "o1");
    expect(zoho.payments).toHaveLength(1);
    expect(stateOf(store).zoho_payment_id).toBe(zoho.payments[0].payment_id);

    // …and the reversal can take it off, so the invoice can be voided.
    Object.assign(store.orders()[0].$app.zoho, { zoho_payment_id: undefined });
    store.orders()[0].canceled = true;
    await syncOrder(store.ctx, client, "o1", { event: "canceled" });
    expect(zoho.payments).toHaveLength(0);
    expect(zoho.invoices[0].status).toBe("void");
    expect(zoho.salesorders[0].status).toBe("void");
  });

  it("counts runs in a row that stop early, and resets the count when the order is synced", async () => {
    fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ paid: true, payment_total: 23 })] });
    const client = await zohoFor(store);

    await expect(syncOrder(store.ctx, client, "o1", { event: "paid", budgetMs: 0 })).rejects.toBeInstanceOf(OrderContinueError);
    await expect(syncOrder(store.ctx, client, "o1", { budgetMs: 0 })).rejects.toBeInstanceOf(OrderContinueError);
    expect(stateOf(store).zoho_continuations).toBe(2);

    await syncOrder(store.ctx, client, "o1");
    expect(stateOf(store)).toMatchObject({ zoho_status: "synced", zoho_continuations: 0 });
  });

  it("the order event does not ask for redelivery when a run stops early; order-continue takes over", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ paid: true, payment_total: 23 })] });
    const client = await zohoFor(store);
    await expect(syncOrder(store.ctx, client, "o1", { event: "paid", budgetMs: 0 })).rejects.toBeInstanceOf(OrderContinueError);

    // The order update that saved the progress fires order-continue.
    const updated = structuredClone(store.orders()[0]);
    await orderContinueFunction(createMockRequest({ data: updated, swell: store.swell, store: { id: "swell-apps" }, appId: "zoho" }));

    expect(stateOf(store).zoho_status).toBe("synced");
    expect(zoho.payments).toHaveLength(1);
  });

  it("order-continue ignores every other order update", async () => {
    const pending = (state: Record<string, unknown>) => order({ $app: { zoho: { zoho_status: "pending", zoho_continuations: 1, ...state } } });
    expect(awaitsContinuation(pending({}), "zoho")).toBe(true);
    expect(awaitsContinuation(pending({ zoho_claimed_at: new Date().toISOString() }), "zoho")).toBe(false);
    expect(awaitsContinuation(pending({ zoho_continuations: MAX_CONTINUATIONS + 1 }), "zoho")).toBe(false);
    expect(awaitsContinuation(pending({ zoho_continuations: 0 }), "zoho")).toBe(false);
    expect(awaitsContinuation(order({ $app: { zoho: { zoho_status: "synced" } } }), "zoho")).toBe(false);
    expect(awaitsContinuation({ ...pending({}), draft: true }, "zoho")).toBe(false);

    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup();
    await orderContinueFunction(createMockRequest({ data: order({ $app: { zoho: { zoho_status: "synced" } } }), swell: store.swell, store: { id: "swell-apps" }, appId: "zoho" }));
    expect(store.swell.get).not.toHaveBeenCalled();
    expect(zoho.fetchMock).not.toHaveBeenCalled();
  });

  it("continueOrder leaves busy, rate-limited and unfinished orders to later runs without throwing", async () => {
    fakeZoho({ taxes: TAXES, fail: () => jsonResponse({ code: 44, message: "Too many requests" }, 429) });
    const store = setup({ orders: [order({ $app: { zoho: { zoho_status: "pending", zoho_continuations: 1 } } })] });
    await expect(continueOrder(store.ctx, await zohoFor(store), "o1")).resolves.toBeUndefined();

    const busy = setup({ orders: [order({ $app: { zoho: { zoho_claimed_at: new Date().toISOString() } } })] });
    await expect(continueOrder(busy.ctx, await zohoFor(busy), "o1")).resolves.toBeUndefined();
  });

  it("the retry job gives each order only the time its own run has left", async () => {
    fakeZoho({ taxes: TAXES });
    const due = new Date(Date.now() - 1000).toISOString();
    const store = setup({ orders: [order({ $app: { zoho: { zoho_status: "pending", zoho_retry_at: due } } })] });
    const spy = vi.spyOn(Date, "now");
    const start = Date.now();
    // The cron run's own lookups used 4.5 of its 5.5 seconds.
    spy.mockReturnValueOnce(start).mockImplementation(() => start + 4500);

    expect(await retryFailedOrders(store.ctx, start)).toBe(0);
    spy.mockRestore();
    expect(stateOf(store).zoho_salesorder_id).toBeUndefined();
  });

  it("the retry job picks up pending orders and orders held by a run that died", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const due = new Date(Date.now() - 1000).toISOString();
    const store = setup({
      orders: [
        order({ $app: { zoho: { zoho_status: "pending", zoho_retry_at: due } } }),
        order({ id: "o2", number: "1002", $app: { zoho: { zoho_claimed_at: stale } } }),
        order({ id: "o3", number: "1003", $app: { zoho: { zoho_claimed_at: new Date().toISOString() } } }),
      ],
    });

    expect(await retryFailedOrders(store.ctx)).toBe(2);
    expect(zoho.salesorders.map((s) => s.reference_number).sort()).toEqual(["1001", "1002"]);
  });
});

describe("order-retry and functions", () => {
  it("retries failed orders whose back-off has passed, and leaves the others", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const store = setup({
      orders: [
        order({ $app: { zoho: { zoho_status: "error", zoho_retry_at: past, zoho_attempts: 1 } } }),
        order({ id: "o2", number: "1002", $app: { zoho: { zoho_status: "error", zoho_retry_at: future } } }),
        order({ id: "o3", number: "1003" }),
      ],
    });

    expect(await retryFailedOrders(store.ctx)).toBe(1);
    expect(zoho.salesorders.map((s) => s.reference_number)).toEqual(["1001"]);
  });

  it("order-sync does nothing while order sync is turned off", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ settings: { sync: { orders: false } } });

    await orderSyncFunction(createMockRequest({ data: { id: "o1" }, swell: store.swell, store: { id: "swell-apps" }, appId: "zoho" }));

    expect(zoho.fetchMock).not.toHaveBeenCalled();
  });

  it("leaves an order paid at checkout to the paid event, so the two never race", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup({ orders: [order({ paid: true, payment_total: 23 })] });
    const event = (type: string) =>
      createMockRequest({
        data: { id: "o1", $event: { id: "e", type, model: "orders", data: {} } },
        swell: store.swell,
        store: { id: "swell-apps" },
        appId: "zoho",
      });

    await orderSyncFunction(event("order.submitted"));
    expect(zoho.fetchMock).not.toHaveBeenCalled();

    await orderSyncFunction(event("order.paid"));
    expect(zoho.salesorders).toHaveLength(1);
    expect(zoho.invoices).toHaveLength(1);
    expect(zoho.payments).toHaveLength(1);
  });

  it("order-sync sends a placed order", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup();

    await orderSyncFunction(createMockRequest({ data: { id: "o1" }, swell: store.swell, store: { id: "swell-apps" }, appId: "zoho" }));

    expect(zoho.salesorders).toHaveLength(1);
  });
});

describe("account-sync", () => {
  function accountEvent(changed: Record<string, unknown>) {
    return { id: "a1", $event: { id: "e", type: "account.updated", model: "accounts", data: changed } };
  }

  async function run(store: ReturnType<typeof createFakeStore>, data: Record<string, unknown>) {
    await accountSyncFunction(createMockRequest({ data, swell: store.swell, store: { id: "swell-apps" }, appId: "zoho" }));
  }

  it("sends name and phone changes to a linked contact", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup();
    await syncOrder(store.ctx, await zohoFor(store), "o1");
    Object.assign(store.accounts()[0], { first_name: "Janet", name: "Janet Doe", phone: "+48 600 000 000" });

    await run(store, accountEvent({ first_name: "Janet", name: "Janet Doe", phone: "+48 600 000 000" }));

    expect(zoho.contacts[0].contact_name).toBe("Janet Doe");
    expect(zoho.contacts[0].contact_persons[0]).toMatchObject({
      first_name: "Janet",
      phone: "+48 600 000 000",
      email: "jane@example.com",
      is_primary_contact: true,
    });
  });

  it("ignores customers without a Zoho contact and unrelated changes", async () => {
    const zoho = fakeZoho({ taxes: TAXES });
    const store = setup();

    await run(store, accountEvent({ first_name: "Janet" }));
    await syncOrder(store.ctx, await zohoFor(store), "o1");
    zoho.fetchMock.mockClear();
    await run(store, accountEvent({ order_count: 2 }));

    expect(zoho.fetchMock).not.toHaveBeenCalled();
  });
});
