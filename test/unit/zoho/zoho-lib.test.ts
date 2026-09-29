import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dataCenterByAccountsServer,
  dataCenterByLocation,
  isKnownApiDomain,
} from "../../../functions/lib/zoho/data-centers";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  ZOHO_SCOPES,
  ZohoOAuthError,
} from "../../../functions/lib/zoho/oauth";
import { describeProblems, listOrganizations } from "../../../functions/lib/zoho/organizations";
import { buildState, createNonce, parseState, timingSafeEqual } from "../../../functions/lib/zoho/state";
import { jsonResponse } from "../../helpers/fake-connection-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("data centers", () => {
  it("resolves every location Zoho reports on the redirect", () => {
    for (const location of ["us", "eu", "in", "au", "jp", "ca", "sa", "uk"]) {
      expect(dataCenterByLocation(location)?.location).toBe(location);
    }
  });

  it("accepts only known Zoho accounts servers", () => {
    expect(dataCenterByAccountsServer("https://accounts.zoho.eu")?.location).toBe("eu");
    expect(dataCenterByAccountsServer("https://accounts.zohocloud.ca/")?.location).toBe("ca");
    expect(dataCenterByAccountsServer("https://accounts.zoho.eu.evil.com")).toBeUndefined();
    expect(dataCenterByAccountsServer("http://accounts.zoho.eu")).toBeUndefined();
    expect(dataCenterByAccountsServer("not a url")).toBeUndefined();
    expect(dataCenterByAccountsServer(undefined)).toBeUndefined();
  });

  it("recognizes Zoho API domains only", () => {
    expect(isKnownApiDomain("https://www.zohoapis.in")).toBe(true);
    expect(isKnownApiDomain("https://www.zohoapis.in.attacker.io")).toBe(false);
  });
});

describe("state", () => {
  it("round-trips the store id and nonce", () => {
    const nonce = createNonce();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(parseState(buildState("my.store", nonce))).toEqual({ storeId: "my.store", nonce });
  });

  it("rejects malformed state", () => {
    expect(parseState(undefined)).toBeNull();
    expect(parseState("nodot")).toBeNull();
    expect(parseState(".onlynonce")).toBeNull();
    expect(parseState("store.")).toBeNull();
  });

  it("compares nonces without short-circuiting on length only", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("oauth", () => {
  const eu = dataCenterByLocation("eu")!;

  it("builds the consent URL on the merchant's data center with fixed scopes", () => {
    const url = new URL(
      buildAuthorizeUrl(eu, {
        clientId: "1000.ABC",
        redirectUri: "https://store--app--app.swell.store/oauth/callback",
        state: "store.nonce",
      }),
    );
    expect(url.origin).toBe("https://accounts.zoho.eu");
    expect(url.pathname).toBe("/oauth/v2/auth");
    expect(url.searchParams.get("scope")).toBe(ZOHO_SCOPES.join(","));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("store.nonce");
    expect(url.searchParams.get("redirect_uri")).toBe("https://store--app--app.swell.store/oauth/callback");
  });

  it("exchanges the code at the data center's token endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        api_domain: "https://www.zohoapis.eu",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await exchangeCode(eu, { clientId: "id", clientSecret: "secret" }, {
      code: "c0de",
      redirectUri: "https://x/oauth/callback",
    });

    expect(tokens).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresInSeconds: 3600,
      apiDomain: "https://www.zohoapis.eu",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://accounts.zoho.eu/oauth/v2/token");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBe("secret");
    expect(form.get("redirect_uri")).toBe("https://x/oauth/callback");
    expect(form.get("code")).toBe("c0de");
  });

  it("treats Zoho's HTTP 200 error body as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_code" })));
    await expect(
      exchangeCode(eu, { clientId: "id", clientSecret: "s" }, { code: "x", redirectUri: "https://x" }),
    ).rejects.toMatchObject({ name: "ZohoOAuthError", code: "invalid_code" });
  });

  it("fails clearly on a non-JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 502 })));
    await expect(refreshAccessToken(eu.accountsServer, { clientId: "id", clientSecret: "s" }, "rt")).rejects.toBeInstanceOf(
      ZohoOAuthError,
    );
  });
});

describe("organizations", () => {
  it("merges Books and Inventory lists and flags which product each org has", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/books/v3/")) {
          return jsonResponse({
            code: 0,
            organizations: [
              { organization_id: "1", name: "Both Ltd" },
              { organization_id: "2", name: "Books Only" },
            ],
          });
        }
        return jsonResponse({ code: 0, organizations: [{ organization_id: "1", name: "Both Ltd" }] });
      }),
    );

    const { organizations: orgs, problems } = await listOrganizations("https://www.zohoapis.eu", "at");

    expect(problems).toEqual([]);
    expect(orgs).toEqual([
      { organization_id: "1", name: "Both Ltd", books: true, inventory: true },
      { organization_id: "2", name: "Books Only", books: true, inventory: false },
    ]);
  });

  it("treats a failing product API as absent rather than failing the connect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/inventory/")
          ? jsonResponse({ code: 57, message: "You are not authorized" }, 401)
          : jsonResponse({ code: 0, organizations: [{ organization_id: 9, name: "Numeric Id" }] }),
      ),
    );

    const { organizations, problems } = await listOrganizations("https://www.zohoapis.com", "at");

    expect(organizations).toEqual([{ organization_id: "9", name: "Numeric Id", books: true, inventory: false }]);
    expect(problems).toEqual([{ product: "inventory", status: 401, code: 57, message: "You are not authorized" }]);
    expect(describeProblems(problems)).toBe("Zoho Inventory: You are not authorized (code 57)");
  });
});
