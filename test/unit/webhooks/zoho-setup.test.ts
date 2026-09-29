import { afterEach, describe, expect, it, vi } from "vitest";
import { getWebhooksStatus, setUpZohoRule } from "../../../functions/lib/webhooks/status";
import { createZohoRule, readZohoSetup, ZOHO_RULES } from "../../../functions/lib/webhooks/zoho-setup";
import { createZohoClient } from "../../../functions/lib/zoho/client";
import { jsonResponse } from "../../helpers/fake-connection-store";
import { CONNECTED_INVENTORY, createFakeStore, fakeZoho } from "../../helpers/fake-store";

const SECRET = "a".repeat(64);
const HOST = "host.swell.store";
const url = (topic: string, token = SECRET) => `https://${HOST}/webhooks/zoho/${topic}?token=${token}&`;
// Credentials in settings, so a 401 can refresh the token and retry, like live.
const connected = () =>
  createFakeStore({
    connection: { ...CONNECTED_INVENTORY, webhook_secret: SECRET },
    settings: { sync: { products: true }, connection: { data_center: "eu", client_id: "1000.CLIENT", client_secret: "shh" } },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readZohoSetup", () => {
  it("finds this store's rules by module, and tells ready, turned off and missing apart", async () => {
    fakeZoho({
      webhooks: [
        { webhook_id: "w1", entity: "shipment_order", url: url("shipments") },
        { webhook_id: "w2", entity: "inventory_adjustment", url: url("stock") },
        // Another store's webhook, and one with no rule using it.
        { webhook_id: "w3", entity: "salesorder", url: url("stock", "b".repeat(64)) },
        { webhook_id: "w4", entity: "invoice", url: url("stock") },
      ],
      workflows: [
        { workflow_id: "r1", entity: "shipment_order", is_active: true, instant_actions: [{ action_type: "webhook", action_id: "w1" }] },
        { workflow_id: "r2", entity: "inventory_adjustment", is_active: false, instant_actions: [{ action_type: "webhook", action_id: "w2" }] },
        { workflow_id: "r3", entity: "salesorder", is_active: true, instant_actions: [{ action_type: "webhook", action_id: "w3" }] },
      ],
    });
    const store = connected();

    const states = await readZohoSetup((await createZohoClient(store.ctx))!, SECRET);

    const byEntity = Object.fromEntries(states.map((s) => [s.entity, s.status]));
    expect(byEntity).toEqual({
      shipment_order: "ready",
      inventory_adjustment: "inactive",
      purchase_receive: "missing",
      transfer_order: "missing",
      salesreturn_receive: "missing",
      salesorder: "missing",
      invoice: "missing",
    });
    expect(states.map((s) => s.topic)).toEqual(["shipments", "stock", "stock", "stock", "stock", "stock", "stock"]);
  });
});

describe("createZohoRule", () => {
  it("creates the webhook with Zoho's default payload, then a rule that runs it on every create and edit", async () => {
    const zohoApi = fakeZoho({ settingsCreate: true });
    const store = connected();

    await createZohoRule((await createZohoClient(store.ctx))!, ZOHO_RULES[1], url("stock"));

    expect(zohoApi.webhooks).toEqual([
      expect.objectContaining({ entity: "inventory_adjustment", url: url("stock"), method: "POST", body_type: "application/json", raw_data: "${JSONString}" }),
    ]);
    expect(zohoApi.workflows).toEqual([
      expect.objectContaining({
        entity: "inventory_adjustment",
        rule_type: "add_edit",
        apply_rule_always: true,
        instant_actions: [{ action_type: "webhook", action_id: zohoApi.webhooks[0].webhook_id }],
      }),
    ]);
  });
});

describe("setUpZohoRule", () => {
  it("creates a missing rule, and leaves one that exists alone", async () => {
    const zohoApi = fakeZoho({ settingsCreate: true });
    const store = connected();

    expect(await setUpZohoRule(store.ctx, HOST, "transfer_order")).toMatchObject({ entity: "transfer_order", status: "ready" });
    expect(await setUpZohoRule(store.ctx, HOST, "transfer_order")).toMatchObject({ status: "ready" });
    expect(zohoApi.webhooks).toHaveLength(1);
    expect(zohoApi.webhooks[0].url).toBe(`https://${HOST}/webhooks/zoho/stock?token=${SECRET}`);
  });

  it("reuses the webhook a deleted rule left behind", async () => {
    const zohoApi = fakeZoho({
      settingsCreate: true,
      webhooks: [{ webhook_id: "w9", entity: "transfer_order", url: url("stock") }],
    });
    const store = connected();

    expect(await setUpZohoRule(store.ctx, HOST, "transfer_order")).toMatchObject({ status: "ready" });

    expect(zohoApi.webhooks).toHaveLength(1);
    expect(zohoApi.workflows).toEqual([expect.objectContaining({ entity: "transfer_order", instant_actions: [{ action_type: "webhook", action_id: "w9" }] })]);
  });

  it("asks to reconnect when the token cannot create settings", async () => {
    const zohoApi = fakeZoho();
    const store = connected();
    await expect(setUpZohoRule(store.ctx, HOST, "invoice")).rejects.toMatchObject({ code: "needs_reconnect", status: 409 });
    expect(zohoApi.webhooks).toEqual([]);
  });

  it("refuses unknown modules and Books-only organizations", async () => {
    fakeZoho({ settingsCreate: true });
    await expect(setUpZohoRule(connected().ctx, HOST, "bill")).rejects.toMatchObject({ code: "unknown_module" });
    const books = createFakeStore({ connection: { ...CONNECTED_INVENTORY, has_inventory: false, webhook_secret: SECRET } });
    await expect(setUpZohoRule(books.ctx, HOST, "invoice")).rejects.toMatchObject({ code: "no_inventory" });
  });
});

describe("getWebhooksStatus rules", () => {
  it("reports the rules, or why they could not be read", async () => {
    fakeZoho({ fail: (u) => (u.pathname.includes("/settings/") ? jsonResponse({ code: 5, message: "Zoho is down" }, 500) : undefined) });
    const status = await getWebhooksStatus(connected().ctx, HOST);
    expect(status.rules).toBeNull();
    expect(status.rules_error).toMatch(/Zoho is down/);
  });
});
