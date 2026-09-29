import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnect,
  getStatus,
  selectOrganization,
  startConnect,
} from "../../functions/lib/connection/actions";
import { CONFIGURED_SETTINGS, createFakeSwell, jsonResponse } from "../helpers/fake-connection-store";

const CALLBACK = "https://swell-apps--abc--app.swell.store/oauth/callback";

const CONNECTED = {
  id: "conn_1",
  status: "connected",
  data_center: "eu",
  accounts_server: "https://accounts.zoho.eu",
  api_domain: "https://www.zohoapis.eu",
  access_token: "at",
  refresh_token: "rt",
  organizations: [
    { organization_id: "1", name: "Both Ltd", books: true, inventory: true },
    { organization_id: "2", name: "Books Only", books: true, inventory: false },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getStatus", () => {
  it("reports disconnected with no record and no credentials", async () => {
    const { ctx } = createFakeSwell();
    expect(await getStatus(ctx)).toMatchObject({
      status: "disconnected",
      organization: null,
      credentials_configured: false,
    });
  });

  it("never exposes tokens or the nonce", async () => {
    const { ctx } = createFakeSwell({
      connection: { ...CONNECTED, oauth_nonce: "n0nce" },
      settings: CONFIGURED_SETTINGS,
    });
    const text = JSON.stringify(await getStatus(ctx));
    expect(text).not.toContain('"at"');
    expect(text).not.toContain('"rt"');
    expect(text).not.toContain("n0nce");
    expect(JSON.parse(text).credentials_configured).toBe(true);
  });

  it("points to the API Console of the chosen data center, even before credentials are saved", async () => {
    const eu = createFakeSwell({ settings: { connection: { data_center: "eu" } } });
    expect(await getStatus(eu.ctx)).toMatchObject({ credentials_configured: false, api_console: "https://api-console.zoho.eu" });
    const none = createFakeSwell({ settings: {} });
    expect((await getStatus(none.ctx)).api_console).toBe("https://api-console.zoho.com");
  });

  it("treats blank credentials as not configured", async () => {
    const { ctx } = createFakeSwell({
      settings: { connection: { data_center: "eu", client_id: "  ", client_secret: "x" } },
    });
    expect((await getStatus(ctx)).credentials_configured).toBe(false);
  });
});

describe("currency", () => {
  it("reports the store currency, USD when the store has none set", async () => {
    expect((await getStatus(createFakeSwell().ctx)).store_currency).toBe("USD");
    expect((await getStatus(createFakeSwell({ storeSettings: { currency: "pln" } }).ctx)).store_currency).toBe("PLN");
  });

  it("looks up the organization's currency once for older connections", async () => {
    const fetchMock = vi.fn(async (_u: URL, _i: RequestInit) =>
      jsonResponse({ code: 0, organization: { organization_id: "1", currency_code: "PLN" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, current } = createFakeSwell({
      connection: {
        ...CONNECTED,
        organization_id: "1",
        organization_name: "Both Ltd",
        has_inventory: true,
        token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });

    expect((await getStatus(ctx)).organization).toEqual({ id: "1", name: "Both Ltd", currency: "PLN" });
    expect(current()!.organization_currency).toBe("PLN");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/inventory/v1/organizations/1?");

    await getStatus(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores the chosen organization's currency", async () => {
    const { ctx, current } = createFakeSwell({
      connection: {
        ...CONNECTED,
        organizations: [{ organization_id: "2", name: "Books Only", books: true, inventory: false, currency_code: "EUR" }],
      },
    });
    await selectOrganization(ctx, "2");
    expect(current()!.organization_currency).toBe("EUR");
  });
});

describe("startConnect", () => {
  it("refuses to start without credentials in settings", async () => {
    const { ctx } = createFakeSwell();
    await expect(startConnect(ctx, CALLBACK)).rejects.toMatchObject({ code: "missing_credentials", status: 400 });
  });

  it("rejects a redirect URI that is not the app's https callback", async () => {
    const { ctx } = createFakeSwell({ settings: CONFIGURED_SETTINGS });
    for (const uri of ["http://x.swell.store/oauth/callback", "https://x/elsewhere", undefined]) {
      await expect(startConnect(ctx, uri)).rejects.toMatchObject({ code: "invalid_redirect_uri" });
    }
  });

  it("stores a fresh nonce and returns the consent URL for the configured data center", async () => {
    const { ctx, current } = createFakeSwell({ settings: CONFIGURED_SETTINGS });

    const { authorize_url } = await startConnect(ctx, CALLBACK);

    const url = new URL(authorize_url);
    expect(url.origin).toBe("https://accounts.zoho.eu");
    expect(url.searchParams.get("client_id")).toBe("1000.CLIENT");
    expect(url.searchParams.get("state")).toBe(`swell-apps.${current()!.oauth_nonce}`);
    expect(current()!.redirect_uri).toBe(CALLBACK);
    expect(Date.parse(current()!.oauth_nonce_expires_at)).toBeGreaterThan(Date.now());
  });

  it("issues a new nonce on every click, invalidating the previous link", async () => {
    const { ctx, current } = createFakeSwell({ settings: CONFIGURED_SETTINGS });
    await startConnect(ctx, CALLBACK);
    const first = current()!.oauth_nonce;
    await startConnect(ctx, CALLBACK);
    expect(current()!.oauth_nonce).not.toBe(first);
  });
});

describe("selectOrganization", () => {
  it("switches to an org the user can access and adopts its products", async () => {
    const { ctx, current } = createFakeSwell({ connection: CONNECTED });
    expect(await selectOrganization(ctx, "2")).toMatchObject({
      organization: { id: "2", name: "Books Only" },
      products: { books: true, inventory: false },
    });
    expect(current()!.has_inventory).toBe(false);
  });

  it("forgets which webhooks have called in when the organization changes, but keeps the token", async () => {
    const seen = { webhook_secret: "s", webhook_stock_at: "2026-09-28T10:00:00.000Z", webhook_stock_sources: ["bill"], webhook_shipments_at: "2026-09-28T10:00:00.000Z" };
    const same = createFakeSwell({ connection: { ...CONNECTED, organization_id: "1", ...seen } });
    await selectOrganization(same.ctx, "1");
    expect(same.current()).toMatchObject(seen);

    const other = createFakeSwell({ connection: { ...CONNECTED, organization_id: "1", ...seen } });
    await selectOrganization(other.ctx, "2");
    expect(other.current()).toMatchObject({ webhook_secret: "s", webhook_stock_at: null, webhook_shipments_at: null, webhook_stock_sources: [] });
  });

  it("rejects an org id that was not offered", async () => {
    const { ctx } = createFakeSwell({ connection: CONNECTED });
    await expect(selectOrganization(ctx, "999")).rejects.toMatchObject({ code: "unknown_organization" });
  });

  it("requires a connection", async () => {
    const { ctx } = createFakeSwell();
    await expect(selectOrganization(ctx, "1")).rejects.toMatchObject({ code: "not_connected", status: 409 });
  });
});

describe("disconnect", () => {
  it("revokes the refresh token at the stored accounts server and clears the record", async () => {
    const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, current } = createFakeSwell({ connection: { ...CONNECTED, organization_id: "1" } });

    const view = await disconnect(ctx);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://accounts.zoho.eu/oauth/v2/token/revoke");
    expect(new URLSearchParams(String(init.body)).get("token")).toBe("rt");
    expect(view).toMatchObject({ status: "disconnected", organization: null, organizations: [] });
    expect(current()!.refresh_token).toBeNull();
    expect(current()!.access_token).toBeNull();
  });

  it("still disconnects when Zoho is unreachable, and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { ctx, current } = createFakeSwell({ connection: CONNECTED });

    expect(await disconnect(ctx)).toMatchObject({ status: "disconnected" });
    expect(current()!.refresh_token).toBeNull();
    expect(current()!.last_error).toMatch(/revoke/);
  });

  it("is a no-op when there was never a connection", async () => {
    const { ctx, swell } = createFakeSwell();
    expect(await disconnect(ctx)).toMatchObject({ status: "disconnected" });
    expect(swell.put).not.toHaveBeenCalled();
  });
});
