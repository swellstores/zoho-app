import { afterEach, describe, expect, it, vi } from "vitest";
import productSyncFunction from "../../../functions/product-sync";
import { runProductSyncBatch, startProductSync } from "../../../functions/lib/products/backfill";
import { syncProduct } from "../../../functions/lib/products/sync";
import { recentFailures } from "../../../functions/lib/products/links";
import { isSyncable, sellableUnits, unitPrice } from "../../../functions/lib/products/units";
import { createZohoClient } from "../../../functions/lib/zoho/client";
import { jsonResponse } from "../../helpers/fake-connection-store";
import { CONNECTED_INVENTORY, createFakeStore, fakeZoho } from "../../helpers/fake-store";
import { createMockRequest } from "../../helpers/mock-request";

const SHIRT = {
  id: "p1",
  name: "T-Shirt",
  price: 20,
  active: true,
  stock_tracking: true,
  variants: {
    results: [
      { id: "v1", name: "Red / M", sku: "TS-RED-M", price: 22, stock_level: 5, active: true },
      { id: "v2", name: "Blue / M", sku: "TS-BLUE-M", stock_level: 0, active: true },
      { id: "v3", name: "Old", sku: "TS-OLD", archived: true },
    ],
  },
};
const MUG = { id: "p2", name: "Mug", sku: "MUG-1", price: 10, active: true, stock_tracking: true, stock_level: 7 };

afterEach(() => {
  vi.unstubAllGlobals();
});

async function zohoFor(store: ReturnType<typeof createFakeStore>) {
  return (await createZohoClient(store.ctx))!;
}

describe("sellableUnits", () => {
  it("turns each live variant into a unit, inheriting the price from the product", () => {
    expect(sellableUnits(SHIRT)).toEqual([
      expect.objectContaining({ variantId: "v1", name: "T-Shirt — Red / M", sku: "TS-RED-M", price: 22, stockLevel: 5 }),
      expect.objectContaining({ variantId: "v2", name: "T-Shirt — Blue / M", sku: "TS-BLUE-M", price: 20, stockLevel: 0 }),
    ]);
  });

  it("takes the price from the standard purchase option before the legacy price fields", () => {
    const product = {
      id: "p",
      price: 99,
      purchase_options: { standard: { active: true, price: 30 } },
      variants: { results: [{ id: "a", price: 99, purchase_options: { standard: { price: 35 } } }, { id: "b" }] },
    };
    expect(unitPrice(product, product.variants.results[0])).toBe(35);
    expect(unitPrice(product, product.variants.results[1])).toBe(30);
    expect(unitPrice({ id: "legacy", price: 12 })).toBe(12);
  });

  it("uses the first active subscription plan for a subscription-only product", () => {
    const product = {
      id: "p",
      purchase_options: {
        standard: { active: false, price: 50 },
        subscription: { active: true, plans: [{ active: false, price: 5 }, { active: true, price: 9 }] },
      },
    };
    expect(unitPrice(product)).toBe(9);
    expect(unitPrice({ id: "free" })).toBe(0);
  });

  it("uses the product itself when it has no variants", () => {
    expect(sellableUnits(MUG)).toEqual([
      expect.objectContaining({ productId: "p2", variantId: null, name: "Mug", sku: "MUG-1", tracked: true, active: true }),
    ]);
  });

  it("treats a blank SKU as none and keeps names within Zoho's 100 characters", () => {
    const [unit] = sellableUnits({ id: "p", name: "x".repeat(150), sku: "  " });
    expect(unit.sku).toBeNull();
    expect(unit.name).toHaveLength(100);
  });

  it("leaves bundles and gift cards out", () => {
    expect(isSyncable({ id: "b", bundle: true })).toBe(false);
    expect(isSyncable({ id: "g", type: "giftcard" })).toBe(false);
    expect(isSyncable(MUG)).toBe(true);
  });
});

describe("syncProduct", () => {
  it("creates missing tracked items with opening stock from Swell", async () => {
    const zohoApi = fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [SHIRT] });

    const result = await syncProduct(store.ctx, await zohoFor(store), SHIRT);

    expect(result.counts.created).toBe(2);
    expect(zohoApi.items).toEqual([
      expect.objectContaining({ name: "T-Shirt — Red / M", sku: "TS-RED-M", rate: 22, item_type: "inventory", initial_stock: 5, initial_stock_rate: 22 }),
      expect.objectContaining({ name: "T-Shirt — Blue / M", sku: "TS-BLUE-M", item_type: "inventory" }),
    ]);
    expect(zohoApi.items[1]).not.toHaveProperty("initial_stock");
    expect(zohoApi.items[0]).not.toHaveProperty("purchase_rate");
    expect(store.links()).toEqual([
      expect.objectContaining({ product_id: "p1", variant_id: "v1", zoho_item_id: "1000", status: "synced", zoho_tracked: true }),
      expect.objectContaining({ product_id: "p1", variant_id: "v2", zoho_item_id: "1001", status: "synced" }),
    ]);
  });

  it("links an existing Zoho item by SKU without changing it, and takes Zoho's stock", async () => {
    const zohoApi = fakeZoho({
      items: [{ item_id: "900", name: "Mug (Zoho name)", sku: "MUG-1", item_type: "inventory", actual_available_for_sale_stock: 3 }],
    });
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [MUG] });

    const result = await syncProduct(store.ctx, await zohoFor(store), MUG);

    expect(result.counts.linked).toBe(1);
    expect(zohoApi.calls("PUT", "/items")).toHaveLength(0);
    expect(zohoApi.calls("POST", "/items")).toHaveLength(0);
    expect(store.stock).toEqual([
      expect.objectContaining({ parent_id: "p2", quantity: -4, reason: "missing" }),
    ]);
    expect(store.products()[0].stock_level).toBe(3);
    expect(store.links()[0]).toMatchObject({ zoho_item_id: "900", zoho_tracked: true, swell_tracked: true });
  });

  it("links by exact name only when the product has no SKU and exactly one item matches", async () => {
    const noSku = { ...MUG, sku: null };
    fakeZoho({ items: [{ item_id: "901", name: "Mug", item_type: "sales" }] });
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [noSku] });

    expect((await syncProduct(store.ctx, await zohoFor(store), noSku)).counts.linked).toBe(1);
    expect(store.links()[0].zoho_item_id).toBe("901");
    expect(store.stock).toHaveLength(0);
  });

  it("creates instead of guessing when the name is ambiguous", async () => {
    const noSku = { ...MUG, sku: null };
    const zohoApi = fakeZoho({ items: [{ item_id: "1", name: "Mug" }, { item_id: "2", name: "Mug" }] });
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [noSku] });

    await syncProduct(store.ctx, await zohoFor(store), noSku);

    expect(zohoApi.calls("POST", "/items")).toHaveLength(1);
  });

  it("creates non-stock items when Swell does not track stock, and in Books-only orgs", async () => {
    const untracked = { ...MUG, stock_tracking: false };
    const zohoApi = fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [untracked] });
    await syncProduct(store.ctx, await zohoFor(store), untracked);

    const bowl = { ...MUG, id: "p9", sku: "BOWL-1" };
    const booksStore = createFakeStore({ connection: { ...CONNECTED_INVENTORY, has_inventory: false }, products: [bowl] });
    await syncProduct(booksStore.ctx, await zohoFor(booksStore), bowl);

    expect(zohoApi.items.map((i) => i.item_type)).toEqual(["sales", "sales"]);
    expect(zohoApi.items.every((i) => i.initial_stock === undefined)).toBe(true);
    expect(String(zohoApi.calls("POST", "/items")[1][0])).toContain("/books/v3/items");
  });

  it("does not create items for inactive products", async () => {
    const draft = { ...MUG, active: false };
    const zohoApi = fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [draft] });

    expect((await syncProduct(store.ctx, await zohoFor(store), draft)).counts.skipped).toBe(1);
    expect(zohoApi.calls("POST", "/items")).toHaveLength(0);
  });

  it("leaves linked items alone on a full sync, and pushes Swell edits to them", async () => {
    const zohoApi = fakeZoho({ items: [{ item_id: "900", name: "Mug", sku: "MUG-1", rate: 10 }] });
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [MUG] });
    const zoho = await zohoFor(store);
    await syncProduct(store.ctx, zoho, MUG);

    expect((await syncProduct(store.ctx, zoho, MUG)).counts.unchanged).toBe(1);

    const renamed = { ...MUG, name: "Big Mug", price: 12 };
    expect((await syncProduct(store.ctx, zoho, renamed, { changedFields: ["name", "price"] })).counts.updated).toBe(1);
    expect(zohoApi.items[0]).toMatchObject({ name: "Big Mug", rate: 12, sku: "MUG-1" });
  });

  it("records a failing unit on its link and carries on with the others", async () => {
    fakeZoho({
      fail: (url, init) =>
        init.method === "POST" && JSON.parse(String(init.body)).sku === "TS-RED-M"
          ? jsonResponse({ code: 1001, message: 'Item "TS-RED-M" already exists' })
          : undefined,
    });
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [SHIRT] });

    const result = await syncProduct(store.ctx, await zohoFor(store), SHIRT);

    expect(result.counts).toMatchObject({ created: 1, failed: 1 });
    expect(store.links().find((l) => l.variant_id === "v1")).toMatchObject({
      status: "error",
      error: 'Zoho POST /items: Item "TS-RED-M" already exists (code 1001)',
    });
  });

  it("stops on a Zoho rate limit so the caller can pause", async () => {
    fakeZoho({ fail: () => jsonResponse({ code: 45, message: "exceeded the maximum number of requests per minute" }, 429) });
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [SHIRT] });

    await expect(syncProduct(store.ctx, await zohoFor(store), SHIRT)).rejects.toMatchObject({ name: "ZohoRateLimitError" });
    expect(store.links()).toHaveLength(0);
  });

  it("stops at the deadline and reports it", async () => {
    fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [SHIRT] });

    const result = await syncProduct(store.ctx, await zohoFor(store), SHIRT, { deadline: Date.now() - 1 });

    expect(result.incomplete).toBe(true);
    expect(store.links()).toHaveLength(0);
  });
});

describe("catalog sync", () => {
  const products = [MUG, SHIRT, { id: "p3", name: "Bundle", bundle: true, active: true }];

  it("refuses to start before an organization is chosen", async () => {
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, organization_id: null } });
    await expect(startProductSync(store.ctx)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("refuses to start while product sync is turned off", async () => {
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, settings: { sync: { products: false } } });
    await expect(startProductSync(store.ctx)).rejects.toMatchObject({ code: "sync_disabled" });
  });

  it("walks the catalog in id order, skipping bundles, and finishes", async () => {
    fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products });

    await startProductSync(store.ctx);
    expect(store.connection().product_sync).toMatchObject({ status: "running", total: 3, processed: 0 });

    const job = await runProductSyncBatch(store.ctx);

    expect(job).toMatchObject({ status: "done", processed: 3, created: 3, linked: 0, failed: 0, cursor: "p3" });
    expect(store.connection().product_sync.finished_at).toBeTruthy();
  });

  it("does nothing when no sync was started", async () => {
    const zohoApi = fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products });
    expect(await runProductSyncBatch(store.ctx)).toBeNull();
    expect(zohoApi.fetchMock).not.toHaveBeenCalled();
  });

  it("pauses for an hour on the daily limit and resumes where it stopped", async () => {
    let limited = true;
    fakeZoho({
      fail: () => (limited ? jsonResponse({ code: 45, message: "exceeded the maximum call rate limit" }, 429) : undefined),
    });
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products });
    await startProductSync(store.ctx);

    const paused = await runProductSyncBatch(store.ctx);
    expect(paused).toMatchObject({ status: "running", processed: 0 });
    expect(paused!.note).toMatch(/daily API limit/);
    expect(Date.parse(paused!.resume_at!)).toBeGreaterThan(Date.now() + 59 * 60 * 1000);

    limited = false;
    expect(await runProductSyncBatch(store.ctx)).toMatchObject({ processed: 0 });
    const resumed = await runProductSyncBatch(store.ctx, Date.parse(paused!.resume_at!) + 1);
    expect(resumed).toMatchObject({ status: "done", processed: 3, note: null });
  });
});

describe("opening stock value", () => {
  it("values opening stock at the regular price, and gives a free product none", async () => {
    const zohoApi = fakeZoho();
    const free = { ...MUG, id: "p9", sku: "FREE-1", price: 0 };
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [MUG, free] });

    await syncProduct(store.ctx, await zohoFor(store), MUG);
    await syncProduct(store.ctx, await zohoFor(store), free);

    expect(zohoApi.items[0]).toMatchObject({ sku: "MUG-1", initial_stock: 7, initial_stock_rate: 10 });
    expect(zohoApi.items[1]).toMatchObject({ sku: "FREE-1", item_type: "inventory" });
    expect(zohoApi.items[1]).not.toHaveProperty("initial_stock");
  });
});

describe("failed links", () => {
  it("leaves out products deleted since they failed", async () => {
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [MUG] });
    store.links().push(
      { id: "l1", product_id: "p2", status: "error", error: "Zoho said no", date_synced: "2026-09-29T05:00:00.000Z" },
      { id: "l2", product_id: "gone", status: "error", error: "Zoho said no", date_synced: "2026-09-29T05:19:04.000Z" },
    );
    expect((await recentFailures(store.swell)).map((l) => l.id)).toEqual(["l1"]);
  });
});

describe("product-sync function", () => {
  function event(type: string, data: Record<string, unknown>, changed: Record<string, unknown> = {}) {
    return { ...data, $event: { id: "e1", type, model: "products", data: changed } };
  }

  async function run(store: ReturnType<typeof createFakeStore>, data: Record<string, unknown>) {
    await productSyncFunction(createMockRequest({ data, swell: store.swell, store: { id: "swell-apps" }, appId: "zoho" }));
  }

  it("ignores updates that do not touch name, SKU, price or activity", async () => {
    const zohoApi = fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [MUG] });

    await run(store, event("product.updated", { id: "p2" }, { stock_level: 3, stock_status: "in_stock" }));

    expect(zohoApi.fetchMock).not.toHaveBeenCalled();
    expect(store.swell.get).not.toHaveBeenCalled();
  });

  it("forgets the links of a deleted product or variant, and leaves Zoho alone", async () => {
    const zohoApi = fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [MUG] });
    store.links().push(
      { id: "l1", product_id: "p1", variant_id: "v1", zoho_item_id: "z1" },
      { id: "l2", product_id: "p1", variant_id: "v2", zoho_item_id: "z2" },
      { id: "l3", product_id: "p2", variant_id: null, zoho_item_id: "z3" },
    );

    await run(store, event("product.variant.deleted", { id: "v1", parent_id: "p1" }));
    expect(store.links().map((l) => l.id)).toEqual(["l2", "l3"]);

    await run(store, event("product.deleted", { id: "p2" }));
    expect(store.links().map((l) => l.id)).toEqual(["l2"]);
    expect(zohoApi.fetchMock).not.toHaveBeenCalled();
  });

  it("syncs a price change made in the purchase options", async () => {
    const zohoApi = fakeZoho({ items: [{ item_id: "z3", sku: "MUG-1", name: "Mug", rate: 10 }] });
    const mug = { ...MUG, purchase_options: { standard: { active: true, price: 14 } } };
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [mug] });
    store.links().push({ id: "l3", product_id: "p2", variant_id: null, zoho_item_id: "z3", status: "synced" });

    await run(store, event("product.updated", { id: "p2" }, { purchase_options: { standard: { price: 14 } } }));

    expect(zohoApi.items[0].rate).toBe(14);
  });

  it("syncs a new product", async () => {
    const zohoApi = fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [MUG] });

    await run(store, event("product.created", { id: "p2" }));

    expect(zohoApi.items).toEqual([expect.objectContaining({ sku: "MUG-1" })]);
  });

  it("syncs only the changed variant, found through its parent", async () => {
    const zohoApi = fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [SHIRT] });

    await run(store, event("product.variant.created", { id: "v2", parent_id: "p1" }));

    expect(zohoApi.items).toEqual([expect.objectContaining({ sku: "TS-BLUE-M" })]);
  });

  it("does nothing while product sync is turned off", async () => {
    const zohoApi = fakeZoho();
    const store = createFakeStore({ connection: CONNECTED_INVENTORY, products: [MUG], settings: { sync: { products: false } } });

    await run(store, event("product.created", { id: "p2" }));

    expect(zohoApi.fetchMock).not.toHaveBeenCalled();
  });
});
