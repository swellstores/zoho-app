import { afterEach, describe, expect, it, vi } from "vitest";
import stockAdjustedFunction from "../../../functions/stock-adjusted";
import { reconcileSwellAdjustment } from "../../../functions/lib/products/swell-adjustments";
import { ZOHO_STOCK_MESSAGE } from "../../../functions/lib/products/stock";
import { createZohoClient } from "../../../functions/lib/zoho/client";
import { CONNECTED_INVENTORY, createFakeStore, fakeZoho } from "../../helpers/fake-store";
import { createMockRequest } from "../../helpers/mock-request";

const SHIRT = {
  id: "p1",
  name: "T-Shirt",
  stock_tracking: true,
  active: true,
  variants: { results: [{ id: "v1", name: "Red", sku: "TS-RED", stock_level: 6, active: true }] },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(entry: Record<string, unknown>, options: { tracked?: boolean; settings?: Record<string, unknown>; connection?: Record<string, unknown> } = {}) {
  const store = createFakeStore({
    connection: options.connection ?? CONNECTED_INVENTORY,
    products: [structuredClone(SHIRT)],
    settings: options.settings,
  });
  store.links().push({ id: "l1", product_id: "p1", variant_id: "v1", zoho_item_id: "z1", zoho_tracked: options.tracked ?? true });
  // The Swell change that fired product.stock_adjusted.
  store.stock.push({ parent_id: "p1", variant_id: "v1", quantity: 1, ...entry });
  const zoho = fakeZoho({ items: [{ item_id: "z1", item_type: "inventory", actual_available_for_sale_stock: 5 }] });
  return { store, zoho };
}

const level = (store: ReturnType<typeof createFakeStore>) => store.products()[0].variants.results[0].stock_level;

describe("reconcileSwellAdjustment", () => {
  it("puts Zoho's level back after a return is restocked in Swell", async () => {
    const { store } = setup({ reason: "returned", order_id: "o1" });

    const outcome = await reconcileSwellAdjustment(store.ctx, (await createZohoClient(store.ctx))!, "p1", "v1");

    expect(outcome).toBe('reset from Zoho after "returned": TS-RED: Zoho 5, Swell 6 → 5');
    expect(level(store)).toBe(5);
    expect(store.stock.at(-1)).toMatchObject({ quantity: -1, reason_message: ZOHO_STOCK_MESSAGE });
  });

  it("also replaces a manual adjustment made in the dashboard", async () => {
    const { store } = setup({ reason: "received", reason_message: "Counted the shelf" });
    await reconcileSwellAdjustment(store.ctx, (await createZohoClient(store.ctx))!, "p1", "v1");
    expect(level(store)).toBe(5);
  });

  it("leaves sales, cancellations and its own adjustments alone", async () => {
    for (const entry of [{ reason: "sold" }, { reason: "canceled" }, { reason: "received", reason_message: ZOHO_STOCK_MESSAGE }]) {
      const { store, zoho } = setup(entry);
      const outcome = await reconcileSwellAdjustment(store.ctx, (await createZohoClient(store.ctx))!, "p1", "v1");
      expect(outcome).not.toMatch(/^reset/);
      expect(level(store)).toBe(6);
      expect(zoho.calls("GET", "/items/")).toHaveLength(0);
    }
  });

  it("skips items whose stock Zoho does not track", async () => {
    const { store } = setup({ reason: "returned" }, { tracked: false });
    expect(await reconcileSwellAdjustment(store.ctx, (await createZohoClient(store.ctx))!, "p1", "v1")).toBe("not tracked in Zoho");
    expect(level(store)).toBe(6);
  });
});

describe("stock-adjusted function", () => {
  const request = (store: ReturnType<typeof createFakeStore>) =>
    // Like the platform: the product's fields, and the event's data under $event.
    createMockRequest({
      data: { ...structuredClone(SHIRT), $event: { type: "product.stock_adjusted", data: { id: "p1", variant_id: "v1", variant_stock_level: 6 } } } as any,
      swell: store.swell as any,
      store: { id: "swell-apps" },
      appId: "zoho",
    });

  it("resets the unit from the event's product and variant", async () => {
    const { store } = setup({ reason: "returned" });
    await stockAdjustedFunction(request(store));
    expect(level(store)).toBe(5);
  });

  it("does nothing when product sync is off or the organization has no Inventory", async () => {
    const off = setup({ reason: "returned" }, { settings: { sync: { products: false } } });
    await stockAdjustedFunction(request(off.store));
    expect(level(off.store)).toBe(6);

    const books = setup({ reason: "returned" }, { connection: { ...CONNECTED_INVENTORY, has_inventory: false } });
    await stockAdjustedFunction(request(books.store));
    expect(level(books.store)).toBe(6);
    expect(books.zoho.fetchMock).not.toHaveBeenCalled();
  });
});
