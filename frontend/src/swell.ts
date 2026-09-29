import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppContext, SwellClient } from "../../functions/lib/swell-client";

/** Credentials and identity the Swell admin proxy injects into every request. */
export interface ProxyContext {
  apiHost: string;
  storeId: string;
  accessToken: string;
  appId: string;
  /** Public host of this page, e.g. <store>--<install>--app.swell.store */
  pageHost: string | null;
  adminUrl: string | null;
  /** `test`, `live` or a branch id */
  environment: string | null;
}

export function readProxyContext(c: Context): ProxyContext | null {
  const apiHost = c.req.header("swell-api-host");
  const storeId = c.req.header("swell-store-id");
  const accessToken = c.req.header("swell-access-token");
  const appId = c.req.header("swell-app-id");
  if (!apiHost || !storeId || !accessToken || !appId) return null;
  return {
    apiHost,
    storeId,
    accessToken,
    appId,
    pageHost: c.req.header("x-forwarded-host") ?? null,
    adminUrl: c.req.header("swell-admin-url") ?? null,
    environment: c.req.header("swell-environment-id") ?? null,
  };
}

function authorization(proxy: ProxyContext): string {
  return `Basic ${btoa(`${proxy.storeId}:${proxy.accessToken}`)}`;
}

function adminApiBase(proxy: ProxyContext): string | null {
  try {
    const url = new URL(proxy.adminUrl ?? "");
    return url.protocol === "https:" && url.hostname.endsWith(".swell.store") ? `${url.origin}/admin/api` : null;
  } catch {
    return null;
  }
}

/**
 * The proxy injects app credentials even for anonymous visitors, so any
 * route touching store data must validate the dashboard session cookie.
 *
 * Dashboard sessions are not visible to the app's store-scoped token
 * (`/:sessions/<id>` answers empty), so the cookie is checked the way the
 * dashboard itself authenticates: the admin API's /session with X-Session.
 */
export async function hasAdminSession(c: Context, proxy: ProxyContext): Promise<boolean> {
  const sessionId = getCookie(c, "_swell_admin_session");
  const deny = (reason: string, detail: Record<string, unknown> = {}) => {
    // The reason only: never cookie, session or token values.
    console.log(JSON.stringify({ admin_session_denied: reason, ...detail }));
    return false;
  };
  if (!sessionId) return deny("no_cookie");
  const adminApi = adminApiBase(proxy);
  if (!adminApi) return deny("no_admin_url", { admin_url: proxy.adminUrl });

  const response = await fetch(`${adminApi}/session`, { headers: { "x-session": sessionId } });
  const text = await response.text();
  if (!response.ok) return deny("lookup_failed", { status: response.status });
  let session: any = null;
  try {
    session = text ? JSON.parse(text) : null;
  } catch {
    return deny("invalid_response");
  }
  // Unknown session ids come back as an empty object.
  if (!session?.user_id) return deny("unknown_session");
  if (session.client_id !== proxy.storeId) {
    return deny("session_mismatch", { client_id: session.client_id ?? null, store_id: proxy.storeId });
  }
  return true;
}

export class SwellApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Swell API ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    this.name = "SwellApiError";
  }
}

function toQueryString(query: Record<string, any>): string {
  const params = new URLSearchParams();
  const append = (key: string, value: any) => {
    if (value === undefined || value === null) return;
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) append(`${key}[${k}]`, v);
    } else {
      params.append(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(query)) append(key, value);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Backend API client acting as this app, with the proxy-injected token. */
export function createSwellClient(proxy: ProxyContext): SwellClient {
  const request = async (method: string, path: string, data?: any) => {
    const url = `${proxy.apiHost}${path}${method === "GET" && data ? toQueryString(data) : ""}`;
    const response = await fetch(url, {
      method,
      headers: {
        authorization: authorization(proxy),
        ...(method === "GET" ? {} : { "content-type": "application/json" }),
      },
      body: method === "GET" || data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Permission and gateway errors come back as plain text.
      body = { message: text.slice(0, 300) };
    }
    // Writes report validation failures as 200 with an `errors` object.
    if (!response.ok || (method !== "GET" && body?.errors)) {
      throw new SwellApiError(response.status, body);
    }
    return body;
  };
  return {
    get: (path, query) => request("GET", path, query),
    post: (path, data) => request("POST", path, data),
    put: (path, data) => request("PUT", path, data),
    delete: (path) => request("DELETE", path),
    settings: (id) => request("GET", `/settings/${id ?? proxy.appId}`),
  };
}

export function appContext(proxy: ProxyContext): AppContext {
  return { swell: createSwellClient(proxy), appId: proxy.appId, storeId: proxy.storeId };
}

export function callbackUrl(proxy: ProxyContext): string | null {
  return proxy.pageHost ? `https://${proxy.pageHost}/oauth/callback` : null;
}

/** The dashboard of the environment this page runs in: /admin/test for the test environment. */
export function dashboardUrl(proxy: ProxyContext): string | null {
  if (!proxy.adminUrl) return null;
  return `${proxy.adminUrl.replace(/\/$/, "")}/admin${proxy.environment === "test" ? "/test" : ""}`;
}
