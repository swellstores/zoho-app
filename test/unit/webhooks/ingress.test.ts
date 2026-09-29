import { afterEach, describe, expect, it, vi } from "vitest";
import webhookFunction from "../../../functions/zoho-webhook";
import { isEndpointUrl, webhookEndpoint, webhookHeaders } from "../../../functions/lib/webhooks/endpoint";
import { itemIdsIn, parseWebhookBody, recordOf, sourceModule } from "../../../functions/lib/webhooks/payload";
import { ensureWebhookSecret, receiveWebhook } from "../../../functions/lib/webhooks/receive";
import { getWebhooksStatus, sourceLabel } from "../../../functions/lib/webhooks/status";
import { createMockRequest } from "../../helpers/mock-request";
import { CONNECTED_INVENTORY, createFakeStore, fakeZoho, PUBLIC_KEY } from "../../helpers/fake-store";

const SECRET = "a".repeat(64);
const ADJUSTMENT = {
  inventory_adjustment: {
    inventory_adjustment_id: "adj1",
    line_items: [
      { item_id: "z1", quantity_adjusted: -2 },
      { item_id: "z2", quantity_adjusted: 5 },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseWebhookBody", () => {
  it("reads a JSON body", () => {
    expect(parseWebhookBody(JSON.stringify(ADJUSTMENT))).toEqual(ADJUSTMENT);
  });

  it("reads form data, unpacking JSON values and a JSONString parameter", () => {
    const form = new URLSearchParams({ JSONString: JSON.stringify(ADJUSTMENT), note: "hi" }).toString();
    expect(parseWebhookBody(form)).toEqual({ ...ADJUSTMENT, note: "hi" });
    expect(parseWebhookBody("salesorder=" + encodeURIComponent('{"salesorder_id":"so1"}'))).toEqual({ salesorder: { salesorder_id: "so1" } });
    // The older webhook style: payload=${JSONString}
    expect(parseWebhookBody("payload=" + encodeURIComponent(JSON.stringify(ADJUSTMENT)))).toEqual(ADJUSTMENT);
  });

  it("returns an empty object for an empty or unreadable body", () => {
    expect(parseWebhookBody("")).toEqual({});
    expect(parseWebhookBody("{broken")).toEqual({ "{broken": "" });
  });
});

describe("payload helpers", () => {
  it("names the Zoho module a record came from", () => {
    expect(sourceModule(ADJUSTMENT)).toBe("inventory_adjustment");
    expect(sourceModule({ note: "x" })).toBeNull();
  });

  it("returns the record under its module key, or the payload when flat", () => {
    expect(recordOf(ADJUSTMENT)).toBe(ADJUSTMENT.inventory_adjustment);
    const flat = { salesorder_id: "so1" };
    expect(recordOf(flat)).toBe(flat);
  });

  it("collects every item id once, at any depth", () => {
    expect(itemIdsIn({ a: [{ item_id: "z1" }, { item_id: 7 }], b: { c: { item_id: "z1" } }, d: { item_id: "" } })).toEqual(["z1", "7"]);
  });
});

describe("receiveWebhook", () => {
  it("stores a call with this store's token and records when the topic last arrived", async () => {
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET } });

    const result = await receiveWebhook(store.ctx, "stock", SECRET, JSON.stringify(ADJUSTMENT), "application/json");

    expect(result).toEqual({ ok: true, source: "inventory_adjustment", check: false });
    expect(store.events()).toEqual([
      expect.objectContaining({ topic: "stock", source: "inventory_adjustment", status: "received", content_type: "application/json" }),
    ]);
    expect(store.connection().webhook_stock_at).toEqual(expect.any(String));
    expect(store.connection().webhook_stock_sources).toEqual(["inventory_adjustment"]);
  });

  it("counts Zoho's empty check call, sent when a webhook is saved, without storing it", async () => {
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET } });

    const result = await receiveWebhook(store.ctx, "stock", SECRET, "payload=", "application/x-www-form-urlencoded;charset=UTF-8");
    // With a JSON body, as the app sets its webhooks up.
    const json = await receiveWebhook(store.ctx, "stock", SECRET, '{\n  "payload": ""\n}', "application/json; charset=utf-8");

    expect(result).toEqual({ ok: true, source: null, check: true });
    expect(json).toEqual({ ok: true, source: null, check: true });
    expect(store.events()).toEqual([]);
    expect(store.connection().webhook_stock_at).toEqual(expect.any(String));
  });

  it("lists each stock source once", async () => {
    const store = createFakeStore({
      connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET, webhook_stock_sources: ["inventory_adjustment"] },
    });
    await receiveWebhook(store.ctx, "stock", SECRET, JSON.stringify(ADJUSTMENT), undefined);
    expect(store.connection().webhook_stock_sources).toEqual(["inventory_adjustment"]);
  });

  it("records shipments calls separately", async () => {
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET } });
    await receiveWebhook(store.ctx, "shipments", SECRET, '{"shipment_order":{"shipment_id":"sh1"}}', undefined);
    expect(store.connection().webhook_shipments_at).toEqual(expect.any(String));
    expect(store.connection().webhook_stock_at).toBeUndefined();
  });

  it("refuses a wrong or missing token, and any call before a token exists", async () => {
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET } });
    await expect(receiveWebhook(store.ctx, "stock", "b".repeat(64), "{}", undefined)).rejects.toMatchObject({ status: 401 });
    await expect(receiveWebhook(store.ctx, "stock", undefined, "{}", undefined)).rejects.toMatchObject({ status: 401 });

    const fresh = createFakeStore({ connection: CONNECTED_INVENTORY });
    await expect(receiveWebhook(fresh.ctx, "stock", "", "{}", undefined)).rejects.toMatchObject({ status: 401 });
    expect(store.events()).toEqual([]);
    expect(fresh.events()).toEqual([]);
  });

  it("keeps an oversized body out of the store", async () => {
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET } });
    await receiveWebhook(store.ctx, "stock", SECRET, "x".repeat(300_000), undefined);
    expect(store.events()[0].body).toHaveLength(200_000);
  });
});

describe("webhook secret and endpoint", () => {
  it("creates the secret once and keeps it", async () => {
    const store = createFakeStore({ connection: CONNECTED_INVENTORY });
    const first = await ensureWebhookSecret(store.ctx, store.connection() as any);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(store.connection().webhook_secret).toBe(first);
    expect(await ensureWebhookSecret(store.ctx, store.connection() as any)).toBe(first);
  });

  it("points at the webhook function on the store gateway, which outlives any install", () => {
    const endpoint = webhookEndpoint({ storeId: "swell-apps", appId: "zoho", publicKey: PUBLIC_KEY })!;
    expect(endpoint).toEqual({ url: "https://swell-apps.swell.store/functions/zoho/zoho-webhook", publicKey: PUBLIC_KEY });
    expect(webhookEndpoint({ storeId: "swell-apps", appId: "zoho", publicKey: null })).toBeNull();
    expect(webhookHeaders(endpoint, "stock", "abc")).toEqual([
      { param_name: "Authorization", param_value: PUBLIC_KEY },
      { param_name: "X-Swell-Topic", param_value: "stock" },
      { param_name: "X-Swell-Token", param_value: "abc" },
    ]);
  });

  it("recognizes the endpoint URL whatever query Zoho kept", () => {
    const endpoint = webhookEndpoint({ storeId: "swell-apps", appId: "zoho", publicKey: PUBLIC_KEY })!;
    expect(isEndpointUrl("https://swell-apps.swell.store/functions/zoho/zoho-webhook?", endpoint)).toBe(true);
    expect(isEndpointUrl("https://swell-apps.swell.store/functions/zoho/zoho-webhook&", endpoint)).toBe(true);
    expect(isEndpointUrl("https://other.swell.store/functions/zoho/zoho-webhook", endpoint)).toBe(false);
    expect(isEndpointUrl("not a url", endpoint)).toBe(false);
  });
});

describe("zoho-webhook function", () => {
  const call = (store: ReturnType<typeof createFakeStore>, headers: Record<string, string>, body = JSON.stringify(ADJUSTMENT)) => {
    const req = createMockRequest({ method: "POST", headers, swell: store.swell as any, store: { id: "swell-apps" }, appId: "zoho" });
    Object.assign(req, { rawBody: body, publicKey: PUBLIC_KEY });
    return webhookFunction(req);
  };

  it("stores a call that carries this store's token and a topic", async () => {
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET } });
    expect(await call(store, { "x-swell-topic": "stock", "x-swell-token": SECRET, "content-type": "application/json" })).toEqual({ ok: true });
    expect(store.events()).toEqual([expect.objectContaining({ topic: "stock", source: "inventory_adjustment", status: "received" })]);
  });

  it("answers 401 to a wrong token, 404 to an unknown topic and 413 to a runaway body", async () => {
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET } });
    await expect(call(store, { "x-swell-topic": "stock", "x-swell-token": "b".repeat(64) })).rejects.toMatchObject({ status: 401 });
    await expect(call(store, { "x-swell-topic": "stock" })).rejects.toMatchObject({ status: 401 });
    await expect(call(store, { "x-swell-topic": "orders", "x-swell-token": SECRET })).rejects.toMatchObject({ status: 404 });
    await expect(call(store, { "x-swell-topic": "stock", "x-swell-token": SECRET }, "x".repeat(1_000_001))).rejects.toMatchObject({ status: 413 });
    expect(store.events()).toEqual([]);
  });
});

describe("getWebhooksStatus", () => {
  it("does not apply to a Zoho Books organization and creates no secret", async () => {
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, has_inventory: false } });
    const status = await getWebhooksStatus(store.ctx);
    expect(status).toMatchObject({ applies: false, manual: null });
    expect(store.connection().webhook_secret).toBeUndefined();
  });

  it("gives what a rule set up by hand needs, what has arrived, and recent failures", async () => {
    fakeZoho();
    const store = createFakeStore({
      connection: {
        ...CONNECTED_INVENTORY,
        webhook_secret: SECRET,
        webhook_stock_at: "2026-09-28T10:00:00.000Z",
        webhook_stock_sources: ["inventory_adjustment", "bill", "custom_thing"],
      },
    });
    const recent = new Date().toISOString();
    store.events().push(
      { id: "e1", topic: "shipments", source: "shipment_order", status: "error", error: "Boom", date_created: recent },
      { id: "e2", topic: "stock", status: "error", error: "Old", date_created: "2020-01-01T00:00:00.000Z" },
      { id: "e3", topic: "stock", status: "processed", date_created: recent },
    );

    const status = await getWebhooksStatus(store.ctx);

    expect(status.applies).toBe(true);
    expect(status.manual).toEqual({
      url: "https://swell-apps.swell.store/functions/zoho/zoho-webhook",
      headers: [
        { name: "Authorization", value: PUBLIC_KEY },
        { name: "X-Swell-Token", value: SECRET },
      ],
      topic_header: "X-Swell-Topic",
    });
    expect(status.shipments.last_received_at).toBeNull();
    expect(status.stock.last_received_at).toBe("2026-09-28T10:00:00.000Z");
    expect(status.rules).toHaveLength(7);
    expect(status.rules!.every((r) => r.status === "missing")).toBe(true);
    expect(status.rules_error).toBeNull();
    expect(status.failures).toEqual([{ id: "e1", topic: "shipments", source: "Shipments", error: "Boom", date_created: recent }]);
  });

  it("reads no rules without the install key, which only the dashboard passes", async () => {
    fakeZoho();
    const store = createFakeStore({ connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET } });
    const status = await getWebhooksStatus({ ...store.ctx, publicKey: null });
    expect(status).toMatchObject({ manual: null, rules: null, rules_error: expect.stringMatching(/Swell dashboard/) });
  });

  it("labels modules for people", () => {
    expect(sourceLabel("purchasereceive")).toBe("Purchase receives");
    expect(sourceLabel("some_module")).toBe("Some module");
  });
});
