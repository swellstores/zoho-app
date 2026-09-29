import { afterEach, describe, expect, it, vi } from "vitest";
import { webhookEndpoint } from "../../../functions/lib/webhooks/endpoint";
import { repairZohoWebhooks } from "../../../functions/lib/webhooks/repair";
import { getWebhooksStatus, setUpZohoRule } from "../../../functions/lib/webhooks/status";
import { createZohoRule, readZohoSetup, ZOHO_RULES } from "../../../functions/lib/webhooks/zoho-setup";
import { createZohoClient } from "../../../functions/lib/zoho/client";
import { jsonResponse } from "../../helpers/fake-connection-store";
import { CONNECTED_INVENTORY, createFakeStore, fakeZoho, PUBLIC_KEY } from "../../helpers/fake-store";

const SECRET = "a".repeat(64);
const ENDPOINT = webhookEndpoint({ storeId: "swell-apps", appId: "zoho", publicKey: PUBLIC_KEY })!;
const URL_NOW = ENDPOINT.url;
// What the first version gave Zoho: the app page host, which a new install changes.
const pageUrl = (topic: string, token = SECRET) => `https://swell-apps--old--app.swell.store/webhooks/zoho/${topic}?token=${token}&`;
const rule = (id: string, entity: string, webhook: string, is_active = true) => ({
  workflow_id: id,
  entity,
  is_active,
  instant_actions: [{ action_type: "webhook", action_id: webhook }],
});
// Credentials in settings, so a 401 can refresh the token and retry, like live.
const connected = (connection: Record<string, unknown> = {}) =>
  createFakeStore({
    connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET, ...connection },
    settings: { sync: { products: true }, connection: { data_center: "eu", client_id: "1000.CLIENT", client_secret: "shh" } },
  });
const current = (ids: string[]) => ({ webhook_public_key: PUBLIC_KEY, webhook_current_ids: ids });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readZohoSetup", () => {
  it("finds this store's rules by module, and tells ready, outdated, turned off and missing apart", async () => {
    fakeZoho({
      webhooks: [
        { webhook_id: "w1", entity: "shipment_order", url: URL_NOW },
        { webhook_id: "w2", entity: "inventory_adjustment", url: URL_NOW },
        // Another store's webhook, and one with no rule using it.
        { webhook_id: "w3", entity: "salesorder", url: pageUrl("stock", "b".repeat(64)) },
        { webhook_id: "w4", entity: "invoice", url: URL_NOW },
        // Still on the old page host.
        { webhook_id: "w5", entity: "purchase_receive", url: pageUrl("stock") },
        // The endpoint, but set up before the current key.
        { webhook_id: "w6", entity: "transfer_order", url: URL_NOW },
      ],
      workflows: [
        rule("r1", "shipment_order", "w1"),
        rule("r2", "inventory_adjustment", "w2", false),
        rule("r3", "salesorder", "w3"),
        rule("r5", "purchase_receive", "w5"),
        rule("r6", "transfer_order", "w6"),
      ],
    });
    const store = connected(current(["w1", "w2", "w4"]));

    const states = await readZohoSetup((await createZohoClient(store.ctx))!, SECRET, ENDPOINT, store.connection());

    const byEntity = Object.fromEntries(states.map((s) => [s.entity, [s.status, s.stale_webhook_ids]]));
    expect(byEntity).toEqual({
      shipment_order: ["ready", []],
      inventory_adjustment: ["inactive", []],
      purchase_receive: ["outdated", ["w5"]],
      transfer_order: ["outdated", ["w6"]],
      salesreturn_receive: ["missing", []],
      salesorder: ["missing", []],
      invoice: ["missing", []],
    });
    expect(states.map((s) => s.topic)).toEqual(["shipments", "stock", "stock", "stock", "stock", "stock", "stock"]);
  });

  it("treats every webhook as outdated once the install key changed", async () => {
    fakeZoho({ webhooks: [{ webhook_id: "w1", entity: "shipment_order", url: URL_NOW }], workflows: [rule("r1", "shipment_order", "w1")] });
    const store = connected({ webhook_public_key: "app_pk_test_old_install", webhook_current_ids: ["w1"] });

    const states = await readZohoSetup((await createZohoClient(store.ctx))!, SECRET, ENDPOINT, store.connection());

    expect(states[0]).toMatchObject({ status: "outdated", stale_webhook_ids: ["w1"] });
  });
});

describe("createZohoRule", () => {
  it("creates the webhook with the key, topic and token as headers, then a rule that runs it on every create and edit", async () => {
    const zohoApi = fakeZoho({ settingsCreate: true });
    const store = connected();

    const id = await createZohoRule((await createZohoClient(store.ctx))!, ZOHO_RULES[1], ENDPOINT, SECRET);

    expect(zohoApi.webhooks).toEqual([
      expect.objectContaining({
        webhook_id: id,
        entity: "inventory_adjustment",
        url: URL_NOW,
        method: "POST",
        body_type: "application/json",
        raw_data: "${JSONString}",
        headers: [
          { param_name: "Authorization", param_value: PUBLIC_KEY },
          { param_name: "X-Swell-Topic", param_value: "stock" },
          { param_name: "X-Swell-Token", param_value: SECRET },
        ],
      }),
    ]);
    expect(zohoApi.workflows).toEqual([
      expect.objectContaining({
        entity: "inventory_adjustment",
        rule_type: "add_edit",
        apply_rule_always: true,
        instant_actions: [{ action_type: "webhook", action_id: id }],
      }),
    ]);
  });
});

describe("setUpZohoRule", () => {
  it("creates a missing rule, records its webhook as current, and leaves it alone afterwards", async () => {
    const zohoApi = fakeZoho({ settingsCreate: true });
    const store = connected();

    expect(await setUpZohoRule(store.ctx, "transfer_order")).toMatchObject({ entity: "transfer_order", status: "ready" });
    expect(await setUpZohoRule(store.ctx, "transfer_order")).toMatchObject({ status: "ready" });

    expect(zohoApi.webhooks).toHaveLength(1);
    expect(zohoApi.webhooks[0].url).toBe(URL_NOW);
    expect(store.connection()).toMatchObject(current([zohoApi.webhooks[0].webhook_id]));
  });

  it("reuses the webhook a deleted rule left behind, pointing it at the endpoint", async () => {
    const zohoApi = fakeZoho({
      settingsCreate: true,
      settingsUpdate: true,
      webhooks: [{ webhook_id: "w9", entity: "transfer_order", url: pageUrl("stock") }],
    });
    const store = connected();

    expect(await setUpZohoRule(store.ctx, "transfer_order")).toMatchObject({ status: "ready" });

    expect(zohoApi.webhooks).toEqual([expect.objectContaining({ webhook_id: "w9", url: URL_NOW })]);
    expect(zohoApi.workflows).toEqual([expect.objectContaining({ entity: "transfer_order", instant_actions: [{ action_type: "webhook", action_id: "w9" }] })]);
  });

  it("updates an outdated stock webhook and catches up on the stock it missed", async () => {
    const zohoApi = fakeZoho({
      settingsUpdate: true,
      webhooks: [{ webhook_id: "w5", entity: "purchase_receive", url: pageUrl("stock") }],
      workflows: [rule("r5", "purchase_receive", "w5")],
    });
    const store = connected();

    expect(await setUpZohoRule(store.ctx, "purchase_receive")).toMatchObject({ status: "ready", stale_webhook_ids: [] });

    expect(zohoApi.webhooks[0]).toMatchObject({ url: URL_NOW, headers: expect.arrayContaining([{ param_name: "Authorization", param_value: PUBLIC_KEY }]) });
    expect(zohoApi.workflows).toHaveLength(1);
    expect(store.connection()).toMatchObject({ ...current(["w5"]), stock_catchup: { status: "running", cursor: null } });
  });

  it("asks to reconnect when the token cannot create or update settings", async () => {
    const zohoApi = fakeZoho({
      webhooks: [{ webhook_id: "w5", entity: "purchase_receive", url: pageUrl("stock") }],
      workflows: [rule("r5", "purchase_receive", "w5")],
    });
    const store = connected();
    await expect(setUpZohoRule(store.ctx, "invoice")).rejects.toMatchObject({ code: "needs_reconnect", status: 409 });
    await expect(setUpZohoRule(store.ctx, "purchase_receive")).rejects.toMatchObject({ code: "needs_reconnect", status: 409 });
    expect(zohoApi.webhooks).toEqual([expect.objectContaining({ webhook_id: "w5", url: pageUrl("stock") })]);
  });

  it("refuses unknown modules, Books-only organizations and a page without the install key", async () => {
    fakeZoho({ settingsCreate: true });
    await expect(setUpZohoRule(connected().ctx, "bill")).rejects.toMatchObject({ code: "unknown_module" });
    const books = createFakeStore({ connection: { ...CONNECTED_INVENTORY, has_inventory: false, webhook_secret: SECRET } });
    await expect(setUpZohoRule(books.ctx, "invoice")).rejects.toMatchObject({ code: "no_inventory" });
    await expect(setUpZohoRule({ ...connected().ctx, publicKey: null }, "invoice")).rejects.toMatchObject({ code: "no_public_key" });
  });
});

describe("repairZohoWebhooks", () => {
  const NOW = Date.parse("2026-09-29T12:00:00.000Z");

  it("after a new install, points every webhook at the new key and catches up on stock", async () => {
    const zohoApi = fakeZoho({
      settingsUpdate: true,
      webhooks: [
        { webhook_id: "w1", entity: "shipment_order", url: URL_NOW },
        { webhook_id: "w2", entity: "inventory_adjustment", url: pageUrl("stock") },
        { webhook_id: "w3", entity: "salesorder", url: pageUrl("stock", "b".repeat(64)) },
      ],
      workflows: [rule("r1", "shipment_order", "w1"), rule("r2", "inventory_adjustment", "w2")],
    });
    const store = connected({ webhook_public_key: "app_pk_test_old_install", webhook_current_ids: ["w1", "w2"] });

    expect(await repairZohoWebhooks(store.ctx, NOW)).toBe(2);

    expect(zohoApi.webhooks.map((h) => [h.webhook_id, h.url])).toEqual([
      ["w1", URL_NOW],
      ["w2", URL_NOW],
      // Not this store's: left alone.
      ["w3", pageUrl("stock", "b".repeat(64))],
    ]);
    expect(zohoApi.webhooks[0].headers).toContainEqual({ param_name: "X-Swell-Topic", param_value: "shipments" });
    expect(store.connection()).toMatchObject({
      ...current(["w1", "w2"]),
      webhook_repair_error: null,
      webhook_checked_at: new Date(NOW).toISOString(),
      stock_catchup: { status: "running" },
    });
  });

  it("reads Zoho only when the key changed or a day passed", async () => {
    const zohoApi = fakeZoho({ settingsUpdate: true });
    const store = connected({ ...current([]), webhook_checked_at: new Date(NOW - 60_000).toISOString() });

    expect(await repairZohoWebhooks(store.ctx, NOW)).toBeNull();
    expect(zohoApi.fetchMock).not.toHaveBeenCalled();

    expect(await repairZohoWebhooks(store.ctx, NOW + 25 * 60 * 60 * 1000)).toBe(0);
    expect(zohoApi.calls("GET", "/settings/webhooks")).toHaveLength(1);
    expect(store.connection().stock_catchup).toBeUndefined();
  });

  it("records the key even when there is nothing to update, so the next minute is quiet", async () => {
    const zohoApi = fakeZoho();
    const store = connected();

    expect(await repairZohoWebhooks(store.ctx, NOW)).toBe(0);
    expect(store.connection()).toMatchObject(current([]));
    expect(await repairZohoWebhooks(store.ctx, NOW + 60_000)).toBeNull();
    expect(zohoApi.calls("GET", "/settings/webhooks")).toHaveLength(1);
  });

  it("waits for a reconnect when the token cannot update settings", async () => {
    const zohoApi = fakeZoho({
      webhooks: [{ webhook_id: "w2", entity: "inventory_adjustment", url: pageUrl("stock") }],
      workflows: [rule("r2", "inventory_adjustment", "w2")],
    });
    const store = connected();

    expect(await repairZohoWebhooks(store.ctx, NOW)).toBe(0);
    expect(store.connection()).toMatchObject({ webhook_repair_error: "needs_reconnect" });
    expect(store.connection().webhook_public_key).toBeUndefined();

    const calls = zohoApi.fetchMock.mock.calls.length;
    expect(await repairZohoWebhooks(store.ctx, NOW + 25 * 60 * 60 * 1000)).toBeNull();
    expect(zohoApi.fetchMock.mock.calls).toHaveLength(calls);
  });

  it("does nothing for Books-only organizations or without the install key", async () => {
    const zohoApi = fakeZoho();
    const books = createFakeStore({ connection: { ...CONNECTED_INVENTORY, has_inventory: false } });
    expect(await repairZohoWebhooks(books.ctx, NOW)).toBeNull();
    expect(await repairZohoWebhooks({ ...connected().ctx, publicKey: null }, NOW)).toBeNull();
    expect(zohoApi.fetchMock).not.toHaveBeenCalled();
  });
});

describe("getWebhooksStatus rules", () => {
  it("reports the rules, or why they could not be read", async () => {
    fakeZoho({ fail: (u) => (u.pathname.includes("/settings/") ? jsonResponse({ code: 5, message: "Zoho is down" }, 500) : undefined) });
    const status = await getWebhooksStatus(connected().ctx);
    expect(status.rules).toBeNull();
    expect(status.rules_error).toMatch(/Zoho is down/);
  });

  it("asks the maintenance job to look again when the page sees an outdated webhook", async () => {
    fakeZoho({
      webhooks: [{ webhook_id: "w2", entity: "inventory_adjustment", url: pageUrl("stock") }],
      workflows: [rule("r2", "inventory_adjustment", "w2")],
    });
    const store = connected({ ...current([]), webhook_checked_at: "2026-09-29T11:00:00.000Z", webhook_repair_error: "needs_reconnect" });

    const status = await getWebhooksStatus(store.ctx);

    expect(status.rules![1]).toMatchObject({ status: "outdated", stale_webhook_ids: ["w2"] });
    expect(status.repair_error).toBe("needs_reconnect");
    expect(store.connection().webhook_checked_at).toBeNull();
  });
});

describe("repairZohoWebhooks time budget", () => {
  const NOW = Date.parse("2026-09-29T12:00:00.000Z");
  const stale = () => ({
    settingsUpdate: true,
    webhooks: ZOHO_RULES.map((r, i) => ({ webhook_id: `w${i}`, entity: r.entity, url: pageUrl(r.topic) })),
    workflows: ZOHO_RULES.map((r, i) => rule(`r${i}`, r.entity, `w${i}`)),
  });

  it("stops at its deadline, keeps what it did, and goes on next time", async () => {
    const zohoApi = fakeZoho(stale());
    const store = connected();

    // Already past the deadline: one webhook per run, never none.
    expect(await repairZohoWebhooks(store.ctx, NOW, NOW - 1)).toBe(1);
    expect(store.connection()).toMatchObject({ ...current(["w0"]), webhook_checked_at: null });

    expect(await repairZohoWebhooks(store.ctx, NOW + 60_000)).toBe(6);
    expect(store.connection()).toMatchObject({ ...current(["w0", "w1", "w2", "w3", "w4", "w5", "w6"]), webhook_checked_at: expect.any(String) });
    expect(zohoApi.webhooks.every((h) => h.url === URL_NOW)).toBe(true);
    expect(await repairZohoWebhooks(store.ctx, NOW + 120_000)).toBeNull();
  });

  it("keeps what it did when Zoho fails half way", async () => {
    let puts = 0;
    fakeZoho({ ...stale(), fail: (u, init) => (init.method === "PUT" && ++puts > 2 ? jsonResponse({ code: 9, message: "Zoho hiccup" }, 500) : undefined) });
    const store = connected();

    await expect(repairZohoWebhooks(store.ctx, NOW)).rejects.toThrow(/hiccup/);
    expect(store.connection()).toMatchObject({ ...current(["w0", "w1"]), webhook_checked_at: null });
  });
});
