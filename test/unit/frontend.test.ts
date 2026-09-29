import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../frontend/src/index";
import { jsonResponse } from "../helpers/fake-connection-store";

const API_HOST = "https://api.swell.store";
const PAGE_HOST = "swell-apps--abc--app.swell.store";
const CALLBACK = `https://${PAGE_HOST}/oauth/callback`;

const PROXY_HEADERS = {
  "swell-api-host": API_HOST,
  "swell-store-id": "swell-apps",
  "swell-access-token": "app-token",
  "swell-app-id": "zoho",
  "swell-admin-url": "https://swell-apps.swell.store",
  "swell-environment-id": "test",
  "swell-public-key": "app_pk_test_page",
  "x-forwarded-host": PAGE_HOST,
};
const SESSION = { cookie: "_swell_admin_session=sess_1" };
const JSON_POST = { ...PROXY_HEADERS, ...SESSION, "content-type": "application/json", origin: `https://${PAGE_HOST}` };

/**
 * Fakes the Swell backend API (sessions, app settings, the connections
 * collection) and Zoho accounts/API hosts behind global fetch.
 */
function fakePlatform(options: { settings?: Record<string, any>; connection?: Record<string, any> | null } = {}) {
  let record = options.connection ?? null;
  const events: Record<string, any>[] = [];
  const settings = options.settings ?? {
    connection: { data_center: "eu", client_id: "1000.CLIENT", client_secret: "shh" },
  };
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("authorization");

    if (url.href === "https://swell-apps.swell.store/admin/api/session") {
      const session = new Headers(init.headers).get("x-session");
      if (session === "sess_1") return jsonResponse({ id: "sess_1", user_id: "u1", client_id: "swell-apps" });
      if (session === "sess_other_store") return jsonResponse({ id: "x", user_id: "u2", client_id: "other-store" });
      return jsonResponse({});
    }
    if (url.origin === API_HOST) {
      if (auth !== `Basic ${btoa("swell-apps:app-token")}`) return jsonResponse({ error: "bad auth" }, 401);
      // Like the platform: a projection naming $app is a server error.
      if (url.searchParams.get("fields")?.includes("$app")) {
        return jsonResponse({ error: { code: "invalid_request", message: "FieldPath field names may not start with '$'" } }, 400);
      }
      if (url.pathname === "/settings/zoho") return jsonResponse(settings);
      if (url.pathname === "/settings/store") return jsonResponse({ id: "store", currency: "PLN" });
      if (url.pathname === "/connections" && method === "GET") {
        return jsonResponse({ results: record ? [record] : [] });
      }
      if (url.pathname === "/connections" && method === "POST") {
        record = { id: "conn_1", ...JSON.parse(String(init.body)) };
        return jsonResponse(record);
      }
      if (url.pathname === "/item-links" && method === "GET") return jsonResponse({ count: 0, results: [] });
      if (url.pathname === "/webhook-events" && method === "GET") return jsonResponse({ count: 0, results: [] });
      if (url.pathname === "/webhook-events" && method === "POST") {
        const event = { id: `e${events.length + 1}`, ...JSON.parse(String(init.body)) };
        events.push(event);
        return jsonResponse(event);
      }
      if (url.pathname === "/products" && method === "GET") return jsonResponse({ count: 2, results: [] });
      if (url.pathname === "/orders" && method === "GET") {
        return url.searchParams.get("where[$app.zoho.zoho_status]") === "error"
          ? jsonResponse({ count: 1, results: [{ id: "o1", number: "1001", $app: { zoho: { zoho_error: "No tax", zoho_retry_at: "2026-09-25T15:00:00.000Z" } } }] })
          : jsonResponse({ count: 4, results: [] });
      }
      if (url.pathname === `/connections/${record?.id}` && method === "PUT") {
        const patch = JSON.parse(String(init.body));
        for (const [k, v] of Object.entries<any>(patch)) record![k] = v && typeof v === "object" && "$set" in v ? v.$set : v;
        return jsonResponse(record);
      }
    }
    if (url.href === "https://accounts.zoho.eu/oauth/v2/token") {
      return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600, api_domain: "https://www.zohoapis.eu" });
    }
    if (url.pathname.endsWith("/organizations")) {
      return jsonResponse({ code: 0, organizations: [{ organization_id: "1", name: "Acme" }] });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, current: () => record, events };
}

const storeCalls = (fetchMock: ReturnType<typeof fakePlatform>["fetchMock"]) =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes("/connections") || String(u).includes("/settings/"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/app-api gate", () => {
  it("refuses requests that did not come through the Swell proxy", async () => {
    fakePlatform();
    expect((await app.request("/app-api/status", { method: "POST", headers: SESSION, body: "{}" })).status).toBe(400);
  });

  it("refuses anonymous visitors even though the proxy injected credentials", async () => {
    const { fetchMock } = fakePlatform();
    expect(
      (await app.request("/app-api/status", { method: "POST", headers: { ...PROXY_HEADERS, "content-type": "application/json" }, body: "{}" })).status,
    ).toBe(401);
    expect(storeCalls(fetchMock)).toHaveLength(0);
  });

  it("refuses a forged session cookie", async () => {
    const { fetchMock } = fakePlatform();
    const res = await app.request("/app-api/status", {
      method: "POST",
      headers: { ...PROXY_HEADERS, "content-type": "application/json", cookie: "_swell_admin_session=forged" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(storeCalls(fetchMock)).toHaveLength(0);
  });

  it("refuses a real session that belongs to another store", async () => {
    const { fetchMock } = fakePlatform();
    const res = await app.request("/app-api/status", {
      method: "POST",
      headers: { ...PROXY_HEADERS, "content-type": "application/json", cookie: "_swell_admin_session=sess_other_store" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(storeCalls(fetchMock)).toHaveLength(0);
  });

  it("never serves page data over GET, which the admin proxy would cache for everyone", async () => {
    const { fetchMock } = fakePlatform();
    const res = await app.request("/app-api/status", { headers: { ...PROXY_HEADERS, ...SESSION } });
    expect(res.status).toBe(405);
    expect(storeCalls(fetchMock)).toHaveLength(0);
  });

  it("refuses non-JSON posts, which a cross-site form could send", async () => {
    fakePlatform();
    const res = await app.request("/app-api/disconnect", {
      method: "POST",
      headers: { ...JSON_POST, "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(res.status).toBe(415);
  });

  it("refuses posts from another origin", async () => {
    fakePlatform();
    const res = await app.request("/app-api/disconnect", {
      method: "POST",
      headers: { ...JSON_POST, origin: "https://evil.swell.store" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});

describe("/app-api routes", () => {
  it("returns the status with this store's callback URL", async () => {
    fakePlatform();
    const res = await app.request("/app-api/status", { method: "POST", headers: JSON_POST, body: "{}" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      status: "disconnected",
      credentials_configured: true,
      callback_url: CALLBACK,
    });
  });

  it("returns the redirect URI of the last connect, which a new install makes outdated", async () => {
    const old = "https://swell-apps--old--app.swell.store/oauth/callback";
    fakePlatform({ connection: { id: "conn_1", status: "disconnected", redirect_uri: old } });
    const res = await app.request("/app-api/status", { method: "POST", headers: JSON_POST, body: "{}" });
    expect(await res.json()).toMatchObject({ redirect_uri: old, callback_url: CALLBACK });
  });

  it("starts a connect using the callback URL derived from the proxy host", async () => {
    const { current } = fakePlatform();

    const res = await app.request("/app-api/connect", { method: "POST", headers: JSON_POST, body: "{}" });

    const { authorize_url } = (await res.json()) as { authorize_url: string };
    expect(new URL(authorize_url).searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(current()!.redirect_uri).toBe(CALLBACK);
  });

  it("maps app errors to their status and code", async () => {
    fakePlatform({ settings: { connection: { data_center: "eu" } } });
    const res = await app.request("/app-api/connect", { method: "POST", headers: JSON_POST, body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "missing_credentials" } });
  });
});

describe("/app-api catalog", () => {
  const CONNECTED = {
    id: "conn_1",
    status: "connected",
    organization_id: "org1",
    organization_name: "Acme",
    has_inventory: true,
    has_books: true,
    organizations: [{ organization_id: "org1", name: "Acme", books: true, inventory: true }],
  };

  it("reports the catalog sync once an organization is chosen", async () => {
    fakePlatform({ connection: CONNECTED });
    const res = await app.request("/app-api/status", { method: "POST", headers: JSON_POST, body: "{}" });
    expect(await res.json()).toMatchObject({
      products: { books: true, inventory: true },
      catalog: { sync_enabled: true, job: { status: "idle" }, failures: [], untracked_in_swell: 0 },
      orders: {
        sync_enabled: true,
        synced: 4,
        failed: 1,
        failures: [{ order_id: "o1", number: "1001", error: "No tax", retry_at: "2026-09-25T15:00:00.000Z" }],
      },
      webhooks: {
        applies: true,
        // The store gateway, with the install key from the proxy: not the page host.
        manual: {
          url: "https://swell-apps.swell.store/functions/zoho/zoho-webhook",
          headers: [
            { name: "Authorization", value: "app_pk_test_page" },
            { name: "X-Swell-Token", value: expect.stringMatching(/^[0-9a-f]{64}$/) },
          ],
        },
        shipments: { last_received_at: null },
        failures: [],
      },
    });
  });

  it("still loads the page when one section fails, and says so in that section", async () => {
    fakePlatform({ connection: CONNECTED });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: any, init?: any) =>
      String(input).includes("/item-links") ? jsonResponse({ error: "boom" }, 500) : original(input, init),
    );
    const res = await app.request("/app-api/status", { method: "POST", headers: JSON_POST, body: "{}" });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.catalog.error).toMatch(/could not be loaded/);
    expect(body.orders.synced).toBe(4);
  });

  it("refuses to retry an order without an id", async () => {
    fakePlatform({ connection: CONNECTED });
    const res = await app.request("/app-api/orders/retry", { method: "POST", headers: JSON_POST, body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_order" } });
  });

  it("starts a catalog sync", async () => {
    const { current } = fakePlatform({ connection: CONNECTED });
    const res = await app.request("/app-api/products/sync", { method: "POST", headers: JSON_POST, body: "{}" });
    expect(await res.json()).toMatchObject({ status: "running", total: 2, processed: 0 });
    expect(current()!.product_sync).toMatchObject({ status: "running" });
  });
});

describe("webhooks", () => {
  it("are no longer taken on the page host, which changes with every install", async () => {
    const { events } = fakePlatform({ connection: { id: "conn_1", status: "connected", has_inventory: true, webhook_secret: "c".repeat(64) } });
    const res = await app.request(`/webhooks/zoho/stock?token=${"c".repeat(64)}`, {
      method: "POST",
      headers: { ...PROXY_HEADERS, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(events).toEqual([]);
  });
});

describe("/oauth/callback", () => {
  it("completes the handshake from Zoho's redirect and confirms it", async () => {
    const { current } = fakePlatform();
    const connect = await app.request("/app-api/connect", { method: "POST", headers: JSON_POST, body: "{}" });
    const { authorize_url } = (await connect.json()) as { authorize_url: string };
    const state = new URL(authorize_url).searchParams.get("state")!;

    const res = await app.request(
      `/oauth/callback?code=c0de&state=${state}&location=eu&accounts-server=https%3A%2F%2Faccounts.zoho.eu`,
      { headers: PROXY_HEADERS },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connected to Acme");
    expect(html).toContain('href="https://swell-apps.swell.store/admin/test"');
    expect(current()).toMatchObject({ status: "connected", refresh_token: "rt", organization_id: "1" });
  });

  it("links back to the live dashboard outside the test environment", async () => {
    fakePlatform({ connection: { id: "conn_1", status: "disconnected" } });
    const res = await app.request("/oauth/callback?code=c&state=swell-apps.nope", {
      headers: { ...PROXY_HEADERS, "swell-environment-id": "live" },
    });
    expect(await res.text()).toContain('href="https://swell-apps.swell.store/admin"');
  });

  it("shows the reason, escaped, when the link is not valid", async () => {
    fakePlatform({ connection: { id: "conn_1", status: "disconnected" } });
    const res = await app.request("/oauth/callback?code=c&state=swell-apps.<b>x</b>", { headers: PROXY_HEADERS });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Start again from the Zoho page");
    expect(html).not.toContain("<b>x</b>");
  });
});
