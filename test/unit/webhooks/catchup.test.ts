import { afterEach, describe, expect, it, vi } from "vitest";
import productBackfillFunction from "../../../functions/product-backfill";
import { runStockCatchup } from "../../../functions/lib/webhooks/catchup";
import { jsonResponse } from "../../helpers/fake-connection-store";
import { CONNECTED_INVENTORY, createFakeStore, fakeZoho, PUBLIC_KEY } from "../../helpers/fake-store";
import { createMockRequest } from "../../helpers/mock-request";

const RUNNING = { status: "running", cursor: null, refreshed: 0, started_at: "2026-09-29T12:00:00.000Z" };
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

afterEach(() => {
  vi.unstubAllGlobals();
});

function storeWith(connection: Record<string, unknown>) {
  const store = createFakeStore({
    connection: { ...CONNECTED_INVENTORY, date_connected: "2026-01-01T00:00:00.000Z", ...connection },
    products: [structuredClone(SHIRT), { ...MUG }],
  });
  store.links().push(
    { id: "l1", product_id: "p1", variant_id: "v1", zoho_item_id: "z1", zoho_tracked: true },
    { id: "l2", product_id: "p1", variant_id: "v2", zoho_item_id: "z2", zoho_tracked: true },
    { id: "l3", product_id: "p2", variant_id: null, zoho_item_id: "z3", zoho_tracked: true },
  );
  return store;
}

const variantStock = (store: ReturnType<typeof createFakeStore>, id: string) =>
  store.products()[0].variants.results.find((v: any) => v.id === id).stock_level;

describe("runStockCatchup", () => {
  it("sets every linked item to Zoho's stock, then finishes", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = storeWith({ stock_catchup: RUNNING });

    const job = await runStockCatchup(store.ctx, Date.now() + 5000);

    expect(job).toMatchObject({ status: "done", cursor: "l3", refreshed: 3, finished_at: expect.any(String) });
    expect([variantStock(store, "v1"), variantStock(store, "v2"), store.products()[1].stock_level]).toEqual([3, 4, 9]);
    expect(store.connection().stock_catchup).toMatchObject({ status: "done" });
  });

  it("stops at the deadline and goes on from the cursor next time", async () => {
    fakeZoho({ items: ZOHO_ITEMS });
    const store = storeWith({ stock_catchup: RUNNING });

    // Past the deadline: still one link, so each tick makes progress.
    expect(await runStockCatchup(store.ctx, Date.now() - 1)).toMatchObject({ status: "running", cursor: "l1", refreshed: 1 });
    expect(await runStockCatchup(store.ctx, Date.now() + 5000)).toMatchObject({ status: "done", refreshed: 3 });
    expect(variantStock(store, "v2")).toBe(4);
  });

  it("skips an item Zoho no longer has instead of stopping for good", async () => {
    fakeZoho({ items: ZOHO_ITEMS.filter((i) => i.item_id !== "z2") });
    const store = storeWith({ stock_catchup: RUNNING });

    expect(await runStockCatchup(store.ctx, Date.now() + 5000)).toMatchObject({ status: "done", refreshed: 2 });
    expect(variantStock(store, "v2")).toBe(1);
  });

  it("keeps its place when Zoho's rate limit is hit", async () => {
    fakeZoho({ items: ZOHO_ITEMS, fail: (u) => (u.pathname.endsWith("/items/z1") ? jsonResponse({ code: 44, message: "Too many requests" }, 429) : undefined) });
    const store = storeWith({ stock_catchup: RUNNING });

    expect(await runStockCatchup(store.ctx, Date.now() + 5000)).toMatchObject({ status: "running", cursor: null });
  });

  it("does nothing unless a refresh is running", async () => {
    const zohoApi = fakeZoho({ items: ZOHO_ITEMS });
    expect(await runStockCatchup(storeWith({}).ctx, Date.now() + 5000)).toBeNull();
    expect(await runStockCatchup(storeWith({ stock_catchup: { status: "done" } }).ctx, Date.now() + 5000)).toBeNull();
    expect(zohoApi.fetchMock).not.toHaveBeenCalled();
  });
});

describe("product-backfill function", () => {
  it("repairs the webhooks after a new install, then refreshes the stock the next minute", async () => {
    const zohoApi = fakeZoho({
      items: ZOHO_ITEMS,
      settingsUpdate: true,
      webhooks: [{ webhook_id: "w2", entity: "inventory_adjustment", url: "https://swell-apps--old--app.swell.store/webhooks/zoho/stock?token=" + "a".repeat(64) }],
      workflows: [{ workflow_id: "r2", entity: "inventory_adjustment", is_active: true, instant_actions: [{ action_type: "webhook", action_id: "w2" }] }],
    });
    const store = storeWith({ webhook_secret: "a".repeat(64) });
    const req = createMockRequest({ swell: store.swell as any, store: { id: "swell-apps" }, appId: "zoho" });
    Object.assign(req, { publicKey: PUBLIC_KEY });

    await productBackfillFunction(req);

    expect(zohoApi.webhooks[0].url).toBe("https://swell-apps.swell.store/functions/zoho/zoho-webhook");
    expect(store.connection()).toMatchObject({ webhook_public_key: PUBLIC_KEY, stock_catchup: { status: "running" } });
    expect(variantStock(store, "v1")).toBe(5);

    await productBackfillFunction(req);

    expect(store.connection()).toMatchObject({ stock_catchup: { status: "done", refreshed: 3 } });
    expect(variantStock(store, "v1")).toBe(3);
  });
});
