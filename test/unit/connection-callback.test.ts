import { afterEach, describe, expect, it, vi } from "vitest";
import { completeConnect, type CallbackParams } from "../../functions/lib/connection/callback";
import { CONFIGURED_SETTINGS, createFakeSwell, jsonResponse } from "../helpers/fake-connection-store";

const NONCE = "a".repeat(64);
const STATE = `swell-apps.${NONCE}`;
const EU = "https://accounts.zoho.eu";
const CALLBACK = "https://swell-apps--abc--app.swell.store/oauth/callback";

function pending(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn_1",
    status: "disconnected",
    oauth_nonce: NONCE,
    oauth_nonce_expires_at: new Date(Date.now() + 60_000).toISOString(),
    redirect_uri: CALLBACK,
    ...overrides,
  };
}

function zohoFetch(options: { orgs?: unknown[]; token?: Record<string, unknown> } = {}) {
  return vi.fn(async (input: URL | string, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth/v2/token")) {
      return jsonResponse(
        options.token ?? {
          access_token: "new-at",
          refresh_token: "new-rt",
          expires_in: 3600,
          api_domain: "https://www.zohoapis.eu",
        },
      );
    }
    if (url.endsWith("/oauth/v2/token/revoke")) return jsonResponse({});
    if (url.includes("/organizations")) {
      return jsonResponse({
        code: 0,
        organizations: options.orgs ?? [{ organization_id: "1", name: "Acme", currency_code: "PLN" }],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function setup(connection = pending()) {
  return createFakeSwell({ connection, settings: CONFIGURED_SETTINGS });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("completeConnect: state verification", () => {
  it.each<[string, CallbackParams]>([
    ["missing state", { code: "c" }],
    ["another store", { code: "c", state: `other-store.${NONCE}` }],
    ["wrong nonce", { code: "c", state: `swell-apps.${"b".repeat(64)}` }],
  ])("rejects %s without contacting Zoho", async (_label, params) => {
    const fetchMock = zohoFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = setup();

    await expect(completeConnect(ctx, params)).rejects.toMatchObject({ code: "invalid_state", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an expired link", async () => {
    vi.stubGlobal("fetch", zohoFetch());
    const { ctx } = setup(pending({ oauth_nonce_expires_at: new Date(Date.now() - 1).toISOString() }));
    await expect(completeConnect(ctx, { code: "c", state: STATE })).rejects.toMatchObject({ code: "expired_state" });
  });

  it("accepts a link only once", async () => {
    vi.stubGlobal("fetch", zohoFetch());
    const { ctx } = setup();
    const params = { code: "c", state: STATE, accounts_server: EU };

    await completeConnect(ctx, params);

    await expect(completeConnect(ctx, params)).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("completeConnect: exchange", () => {
  it("stores tokens, data center and the single org, and marks the store connected", async () => {
    const fetchMock = zohoFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, current } = setup();

    const view = await completeConnect(ctx, { code: "c", state: STATE, accounts_server: EU });

    expect(view).toMatchObject({
      status: "connected",
      data_center: "eu",
      organization: { id: "1", name: "Acme" },
      products: { books: true, inventory: true },
    });
    expect(current()).toMatchObject({
      access_token: "new-at",
      refresh_token: "new-rt",
      accounts_server: EU,
      api_domain: "https://www.zohoapis.eu",
      organization_currency: "PLN",
      oauth_nonce: null,
      last_error: null,
    });
    const tokenCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/oauth/v2/token"))!;
    expect(new URLSearchParams(String(tokenCall[1]!.body)).get("redirect_uri")).toBe(CALLBACK);
  });

  it("leaves the org unselected when the user has several", async () => {
    vi.stubGlobal("fetch", zohoFetch({ orgs: [{ organization_id: "1", name: "A" }, { organization_id: "2", name: "B" }] }));
    const { ctx } = setup();

    const view = await completeConnect(ctx, { code: "c", state: STATE, accounts_server: EU });

    expect(view.status).toBe("connected");
    expect(view.organization).toBeNull();
    expect(view.organizations).toHaveLength(2);
  });

  it("never sends the client secret to an unknown accounts server", async () => {
    const fetchMock = zohoFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, current } = setup();

    await expect(
      completeConnect(ctx, { code: "c", state: STATE, accounts_server: "https://accounts.zoho.eu.evil.example" }),
    ).rejects.toMatchObject({ code: "unknown_data_center" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(current()!.status).toBe("error");
  });

  it("falls back to the configured data center when Zoho sends no accounts-server", async () => {
    const fetchMock = zohoFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = setup();

    await completeConnect(ctx, { code: "c", state: STATE });

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://accounts.zoho.eu/oauth/v2/token");
  });

  it("records a denied consent as an error", async () => {
    vi.stubGlobal("fetch", zohoFetch());
    const { ctx, current } = setup();

    await expect(completeConnect(ctx, { state: STATE, error: "access_denied" })).rejects.toMatchObject({
      code: "zoho_denied",
    });
    expect(current()).toMatchObject({ status: "error", oauth_nonce: null });
  });

  it("keeps a working connection when a reconnect fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_client" })));
    const { ctx, current } = setup(pending({ status: "connected", refresh_token: "old-rt", accounts_server: EU }));

    await expect(completeConnect(ctx, { code: "c", state: STATE, accounts_server: EU })).rejects.toMatchObject({
      code: "token_exchange_failed",
      status: 502,
    });
    expect(current()).toMatchObject({ status: "connected", refresh_token: "old-rt" });
    expect(current()!.last_error).toMatch(/invalid_client/);
  });

  it("revokes the refresh token it replaces", async () => {
    const fetchMock = zohoFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = setup(pending({ status: "connected", refresh_token: "old-rt", accounts_server: EU }));

    await completeConnect(ctx, { code: "c", state: STATE, accounts_server: EU });

    const revoke = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/revoke"))!;
    expect(new URLSearchParams(String(revoke[1]!.body)).get("token")).toBe("old-rt");
  });

  it("refuses a grant without a refresh token", async () => {
    vi.stubGlobal("fetch", zohoFetch({ token: { access_token: "at", expires_in: 3600 } }));
    const { ctx } = setup();
    await expect(completeConnect(ctx, { code: "c", state: STATE })).rejects.toMatchObject({ code: "no_refresh_token" });
  });

  it("marks an account with neither Books nor Inventory as an error", async () => {
    vi.stubGlobal("fetch", zohoFetch({ orgs: [] }));
    const { ctx } = setup();

    const view = await completeConnect(ctx, { code: "c", state: STATE });

    expect(view.status).toBe("error");
    expect(view.last_error).toMatch(/No Zoho Books or Zoho Inventory organization/);
  });

  it("explains why the organization lists could not be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = String(input);
        if (url.endsWith("/oauth/v2/token")) {
          return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600, api_domain: "https://www.zohoapis.eu" });
        }
        return jsonResponse({ code: 57, message: "You are not authorized to perform this operation" }, 401);
      }),
    );
    const { ctx } = setup();

    const view = await completeConnect(ctx, { code: "c", state: STATE });

    expect(view.status).toBe("error");
    expect(view.last_error).toContain("Zoho Books: You are not authorized to perform this operation (code 57)");
    expect(view.last_error).toContain("Zoho Inventory:");
  });
});
