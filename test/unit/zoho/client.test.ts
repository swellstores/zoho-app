import { afterEach, describe, expect, it, vi } from "vitest";
import { createZohoClient, ZohoApiError, ZohoRateLimitError } from "../../../functions/lib/zoho/client";
import { jsonResponse } from "../../helpers/fake-connection-store";
import { CONNECTED_INVENTORY, createFakeStore } from "../../helpers/fake-store";

const SETTINGS = { connection: { data_center: "eu", client_id: "id", client_secret: "secret" } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createZohoClient", () => {
  it("returns null until the store is connected with an organization", async () => {
    expect(await createZohoClient(createFakeStore().ctx)).toBeNull();
    const { ctx } = createFakeStore({ connection: { ...CONNECTED_INVENTORY, organization_id: null } });
    expect(await createZohoClient(ctx)).toBeNull();
  });

  it("uses Inventory for items when the org has it, Books otherwise", async () => {
    expect((await createZohoClient(createFakeStore({ connection: CONNECTED_INVENTORY }).ctx))!.itemsApi).toBe("inventory");
    const booksOnly = createFakeStore({ connection: { ...CONNECTED_INVENTORY, has_inventory: false } });
    expect((await createZohoClient(booksOnly.ctx))!.itemsApi).toBe("books");
  });

  it("calls the org's data center with the organization id and the token", async () => {
    const fetchMock = vi.fn(async (_u: URL, _i: RequestInit) => jsonResponse({ code: 0, items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const zoho = (await createZohoClient(createFakeStore({ connection: CONNECTED_INVENTORY }).ctx))!;

    await zoho.request("inventory", "GET", "/items", { query: { sku: "A-1", skip: undefined } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url.origin + url.pathname).toBe("https://www.zohoapis.eu/inventory/v1/items");
    expect(url.searchParams.get("organization_id")).toBe("org1");
    expect(url.searchParams.get("sku")).toBe("A-1");
    expect(url.searchParams.has("skip")).toBe(false);
    expect(new Headers(init.headers).get("authorization")).toBe("Zoho-oauthtoken at");
  });

  it("refreshes a token that is about to expire, and stores it", async () => {
    const fetchMock = vi.fn(async (u: URL | string, _i: RequestInit) =>
      String(u).endsWith("/oauth/v2/token")
        ? jsonResponse({ access_token: "fresh", expires_in: 3600 })
        : jsonResponse({ code: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = createFakeStore({
      connection: { ...CONNECTED_INVENTORY, token_expires_at: new Date(Date.now() + 60_000).toISOString() },
      settings: SETTINGS,
    });
    const zoho = (await createZohoClient(store.ctx))!;

    await zoho.request("books", "GET", "/items");

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://accounts.zoho.eu/oauth/v2/token");
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("authorization")).toBe("Zoho-oauthtoken fresh");
    expect(store.connection().access_token).toBe("fresh");
  });

  it("refreshes and retries once when Zoho rejects the token", async () => {
    let first = true;
    const fetchMock = vi.fn(async (u: URL | string, _i: RequestInit) => {
      if (String(u).endsWith("/oauth/v2/token")) return jsonResponse({ access_token: "fresh", expires_in: 3600 });
      if (first) {
        first = false;
        return jsonResponse({ code: 57, message: "You are not authorized" }, 401);
      }
      return jsonResponse({ code: 0, ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const zoho = (await createZohoClient(createFakeStore({ connection: CONNECTED_INVENTORY, settings: SETTINGS }).ctx))!;

    expect(await zoho.request("inventory", "GET", "/items")).toMatchObject({ ok: true });
  });

  it("marks the connection broken when the refresh token is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_code" })),
    );
    const store = createFakeStore({
      connection: { ...CONNECTED_INVENTORY, token_expires_at: new Date(0).toISOString() },
      settings: SETTINGS,
    });
    const zoho = (await createZohoClient(store.ctx))!;

    await expect(zoho.request("inventory", "GET", "/items")).rejects.toMatchObject({ code: "zoho_auth" });
    expect(store.connection()).toMatchObject({ status: "error" });
    expect(store.connection().last_error).toMatch(/Reconnect/);
  });

  it.each([
    ["The API call for this organization has exceeded the maximum call rate limit", "day"],
    ["For security reasons your organization has been blocked as it have exceeded the maximum number of requests per minute", "minute"],
  ])("tells a daily limit from a per-minute one: %s", async (message, scope) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 45, message }, 429)));
    const zoho = (await createZohoClient(createFakeStore({ connection: CONNECTED_INVENTORY }).ctx))!;

    const error = await zoho.request("inventory", "GET", "/items").catch((e) => e);

    expect(error).toBeInstanceOf(ZohoRateLimitError);
    expect(error.scope).toBe(scope);
  });

  it("turns a non-zero Zoho code into an error even with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: 1001, message: "Item already exists" })));
    const zoho = (await createZohoClient(createFakeStore({ connection: CONNECTED_INVENTORY }).ctx))!;

    const error = await zoho.request("inventory", "POST", "/items", { body: {} }).catch((e) => e);

    expect(error).toBeInstanceOf(ZohoApiError);
    expect(error).toMatchObject({ code: 1001, message: "Zoho POST /items: Item already exists (code 1001)" });
  });
});
