import { Hono, type Context } from "hono";
import { disconnect, getStatus, selectOrganization, startConnect } from "../../functions/lib/connection/actions";
import { completeConnect } from "../../functions/lib/connection/callback";
import { startProductSync } from "../../functions/lib/products/backfill";
import { getProductsStatus } from "../../functions/lib/products/status";
import { getOrdersStatus, retryOrder } from "../../functions/lib/orders/status";
import { AppError } from "../../functions/lib/swell-client";
import { getWebhooksStatus, setUpZohoRule } from "../../functions/lib/webhooks/status";
import { renderCallbackPage } from "./callback-page";
import { appContext, callbackUrl, dashboardUrl, hasAdminSession, readProxyContext, SwellApiError, type ProxyContext } from "./swell";

type Env = { Variables: { proxy: ProxyContext } };

const app = new Hono<Env>();

// Swell's gateway owns /api on *.swell.store hosts, so the page API lives
// under /app-api. Every route is POST: the admin proxy caches GET 2xx
// responses without the session cookie in the cache key, so an
// authenticated GET would be served to anyone who asks for the same URL.
const API = "/app-api";

function apiError(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as any);
}

/** One page section's data; a failure is shown inside that section, not as a broken page. */
async function section<T>(name: string, load: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await load();
  } catch (error) {
    console.error(`status section ${name}:`, error instanceof Error ? error.message : error);
    return { error: `This section could not be loaded (${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}).` };
  }
}

app.onError((error, c) => {
  if (error instanceof AppError) return apiError(c, error.status, error.code, error.message);
  if (error instanceof SwellApiError) {
    console.error(error.message);
    return apiError(c, 502, "swell_api_error", `Swell refused the request (${error.status}). Try again, and contact support if it persists.`);
  }
  console.error(error);
  return apiError(c, 500, "internal_error", "Something went wrong. Try again, and contact support if it persists.");
});

app.use(`${API}/*`, async (c, next) => {
  const proxy = readProxyContext(c);
  if (!proxy) {
    return apiError(c, 400, "no_proxy", "Open this page from the Swell dashboard.");
  }
  if (c.req.method !== "POST") {
    return apiError(c, 405, "post_required", "Use POST.");
  }
  // A JSON body forces a CORS preflight, so other *.swell.store pages
  // cannot post here with the merchant's same-site cookie.
  if (!c.req.header("content-type")?.startsWith("application/json")) {
    return apiError(c, 415, "json_required", "Send a JSON body.");
  }
  const origin = c.req.header("origin");
  if (origin && proxy.pageHost && origin !== `https://${proxy.pageHost}`) {
    return apiError(c, 403, "bad_origin", "Cross-origin request refused.");
  }
  if (!(await hasAdminSession(c, proxy))) {
    return apiError(c, 401, "unauthorized", "Your Swell session expired. Reload the page from the dashboard.");
  }
  c.set("proxy", proxy);
  await next();
  c.header("cache-control", "no-store");
});

app.post(`${API}/status`, async (c) => {
  const proxy = c.get("proxy");
  const ctx = appContext(proxy);
  const status = await getStatus(ctx);
  const ready = status.status === "connected" && status.organization;
  const [catalog, orders, webhooks] = ready
    ? await Promise.all([
        section("products", () => getProductsStatus(ctx)),
        section("orders", () => getOrdersStatus(ctx)),
        section("webhooks", () => getWebhooksStatus(ctx)),
      ])
    : [null, null, null];
  return c.json({ ...status, catalog, orders, webhooks, callback_url: callbackUrl(proxy) });
});

app.post(`${API}/orders/retry`, async (c) => {
  const { order_id } = await c.req.json().catch(() => ({}) as any);
  return c.json(await retryOrder(appContext(c.get("proxy")), order_id));
});

app.post(`${API}/webhooks/setup`, async (c) => {
  const { entity } = await c.req.json().catch(() => ({}) as any);
  return c.json(await setUpZohoRule(appContext(c.get("proxy")), entity));
});

app.post(`${API}/products/sync`, async (c) => {
  return c.json(await startProductSync(appContext(c.get("proxy"))));
});

app.post(`${API}/connect`, async (c) => {
  const proxy = c.get("proxy");
  const redirectUri = callbackUrl(proxy);
  if (!redirectUri) {
    return apiError(c, 400, "no_callback_url", "Open this page from the Swell dashboard.");
  }
  return c.json(await startConnect(appContext(proxy), redirectUri));
});

app.post(`${API}/organization`, async (c) => {
  const { organization_id } = await c.req.json().catch(() => ({}) as any);
  return c.json(await selectOrganization(appContext(c.get("proxy")), organization_id));
});

app.post(`${API}/disconnect`, async (c) => {
  return c.json(await disconnect(appContext(c.get("proxy"))));
});

// Zoho redirects the merchant's browser here. The single-use `state` nonce
// is what authorizes this request, not the dashboard session.
app.get("/oauth/callback", async (c) => {
  const proxy = readProxyContext(c);
  if (!proxy) {
    return c.html(
      renderCallbackPage({ ok: false, title: "Something went wrong", message: "This page must be reached through Swell.", dashboardUrl: null }),
      400,
    );
  }
  const q = c.req.query();
  try {
    const view = await completeConnect(appContext(proxy), {
      code: q.code,
      state: q.state,
      error: q.error,
      accounts_server: q["accounts-server"],
    });
    const connected = view.status === "connected";
    return c.html(
      renderCallbackPage({
        ok: connected,
        title: connected ? "Zoho is connected" : "Connected, but not usable yet",
        message: !connected
          ? view.last_error ?? "Check the Zoho page in your Swell dashboard."
          : view.organization
            ? `Connected to ${view.organization.name}. You can close this tab and return to Swell.`
            : "Close this tab and choose your Zoho organization on the Zoho page in Swell.",
        dashboardUrl: dashboardUrl(proxy),
      }),
    );
  } catch (error) {
    if (!(error instanceof AppError)) console.error(error);
    return c.html(
      renderCallbackPage({
        ok: false,
        title: "Zoho was not connected",
        message: error instanceof AppError ? error.message : "Something went wrong. Start again from the Zoho page in Swell.",
        dashboardUrl: dashboardUrl(proxy),
      }),
      error instanceof AppError ? (error.status as any) : 500,
    );
  }
});

export default app;
