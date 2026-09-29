import { vi } from "vitest";
import type { AppContext } from "../../functions/lib/swell-client";
import { jsonResponse } from "./fake-connection-store";

type Doc = Record<string, any>;

let nextId = 1;
const newId = () => `6ab700000000000000${String(nextId++).padStart(6, "0")}`;

function valueAt(doc: Doc, path: string) {
  return path.split(".").reduce<any>((value, key) => (value == null ? undefined : value[key]), doc);
}

function matches(doc: Doc, where: Doc = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "$or") return (cond as Doc[]).some((sub) => matches(doc, sub));
    const value = valueAt(doc, key);
    // Like the platform: range comparisons on $app fields match nothing.
    if (key.startsWith("$app.") && cond && typeof cond === "object" && ["$lt", "$lte", "$gt", "$gte"].some((op) => op in cond)) return false;
    if (cond && typeof cond === "object" && "$ne" in cond) return (value ?? null) !== (cond.$ne ?? null);
    if (cond && typeof cond === "object" && "$in" in cond) return (cond.$in as unknown[]).includes(value);
    if (cond && typeof cond === "object" && "$gt" in cond) return String(value) > String(cond.$gt);
    if (cond && typeof cond === "object" && "$gte" in cond) return value != null && String(value) >= String(cond.$gte);
    if (cond && typeof cond === "object" && "$lt" in cond) return value != null && String(value) < String(cond.$lt);
    if (cond && typeof cond === "object" && "$lte" in cond) return value != null && String(value) <= String(cond.$lte);
    return (value ?? null) === (cond ?? null) || (cond === false && !value);
  });
}

function applyPatch(doc: Doc, patch: Doc) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "$app") {
      // $app writes deep-merge per app, like the platform.
      doc.$app ??= {};
      for (const [appId, fields] of Object.entries<Doc>(value)) doc.$app[appId] = { ...doc.$app[appId], ...fields };
      continue;
    }
    doc[key] = value && typeof value === "object" && !Array.isArray(value) && "$set" in value ? value.$set : value;
  }
  return doc;
}

/**
 * In-memory Swell store with the collections the product sync touches:
 * the app's connections and item-links, products (with variants and the
 * stock ledger) and app settings.
 */
export function createFakeStore(
  init: { connection?: Doc; products?: Doc[]; settings?: Doc; orders?: Doc[]; accounts?: Doc[] } = {},
) {
  const collections: Record<string, Doc[]> = {
    "/connections": init.connection ? [{ id: "conn_1", ...init.connection }] : [],
    "/item-links": [],
    "/contact-links": [],
    "/products": (init.products ?? []).map((p) => ({ ...p })),
    "/orders": (init.orders ?? []).map((o) => ({ ...o })),
    "/accounts": (init.accounts ?? []).map((a) => ({ ...a })),
    "/webhook-events": [],
    "/shipments": [],
  };
  const stock: Doc[] = [];
  const settings = init.settings ?? { sync: { products: true } };

  const list = (name: string, query: Doc = {}) => {
    let docs = collections[name].filter((d) => matches(d, query.where));
    if (query.sort === "id asc") docs = [...docs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const limit = query.limit ?? 15;
    return { count: docs.length, results: docs.slice(0, limit).map((d) => ({ ...d })) };
  };

  const swell = {
    get: vi.fn(async (url: string, query?: Doc) => {
      const recordMatch = url.match(/^(\/(?:products|orders|accounts|webhook-events|shipments))\/([^/]+)$/);
      if (recordMatch) {
        const doc = collections[recordMatch[1]].find((p) => p.id === recordMatch[2]);
        return doc ? structuredClone(doc) : null;
      }
      if (url === "/settings/store") return { id: "store" };
      if (url === "/products:stock") {
        // Newest first, like `sort: date_created desc`.
        const entries = stock.filter((e) => matches(e, query?.where)).reverse();
        return { count: entries.length, results: entries.slice(0, query?.limit ?? 15) };
      }
      if (collections[url]) return list(url, query);
      throw new Error(`unexpected GET ${url}`);
    }),
    post: vi.fn(async (url: string, data: Doc) => {
      if (url === "/products:stock") {
        stock.push(data);
        const product = collections["/products"].find((p) => p.id === data.parent_id)!;
        const variants: Doc[] = product.variants?.results ?? [];
        const target = data.variant_id ? variants.find((v) => v.id === data.variant_id)! : product;
        target.stock_level = (target.stock_level ?? 0) + data.quantity;
        // Like the platform: the entry carries the level after it.
        return { ...data, level: target.stock_level };
      }
      if (!collections[url]) throw new Error(`unexpected POST ${url}`);
      const doc = applyPatch({ id: newId() }, data);
      collections[url].push(doc);
      return { ...doc };
    }),
    put: vi.fn(async (url: string, patch: Doc) => {
      const [, name, id] = url.match(/^(\/[^/]+)\/([^/]+)$/) ?? [];
      const doc = collections[name]?.find((d) => d.id === id);
      if (!doc) throw new Error(`unexpected PUT ${url}`);
      return { ...applyPatch(doc, patch) };
    }),
    delete: vi.fn(async (url: string) => {
      const [, name, id] = url.match(/^(\/[^/]+)\/([^/]+)$/) ?? [];
      const list = collections[name];
      const index = list?.findIndex((d) => d.id === id) ?? -1;
      if (index < 0) throw new Error(`unexpected DELETE ${url}`);
      return list.splice(index, 1)[0];
    }),
    settings: vi.fn(async () => settings),
  };

  const ctx: AppContext = { swell, appId: "zoho", storeId: "swell-apps" };
  return {
    swell,
    ctx,
    stock,
    links: () => collections["/item-links"],
    contactLinks: () => collections["/contact-links"],
    orders: () => collections["/orders"],
    accounts: () => collections["/accounts"],
    connection: () => collections["/connections"][0],
    products: () => collections["/products"],
    events: () => collections["/webhook-events"],
    shipments: () => collections["/shipments"],
  };
}

export const CONNECTED_INVENTORY = {
  status: "connected",
  data_center: "eu",
  accounts_server: "https://accounts.zoho.eu",
  api_domain: "https://www.zohoapis.eu",
  access_token: "at",
  refresh_token: "rt",
  token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  organization_id: "org1",
  organization_name: "Acme",
  has_books: true,
  has_inventory: true,
};

/**
 * Fakes the Zoho items API (Inventory and Books share the shape) behind
 * global fetch, with an in-memory item list.
 */
export function fakeZoho(
  init: {
    items?: Doc[];
    contacts?: Doc[];
    taxes?: Doc[];
    salesorders?: Doc[];
    invoices?: Doc[];
    creditnotes?: Doc[];
    shipmentorders?: Doc[];
    webhooks?: Doc[];
    workflows?: Doc[];
    /** The token has ZohoInventory.settings.CREATE */
    settingsCreate?: boolean;
    fail?: (url: URL, init: RequestInit) => Response | undefined;
  } = {},
) {
  const items: Doc[] = (init.items ?? []).map((i) => ({ ...i }));
  const contacts: Doc[] = (init.contacts ?? []).map((c) => ({ ...c }));
  const taxes: Doc[] = init.taxes ?? [];
  const salesorders: Doc[] = (init.salesorders ?? []).map((d) => ({ ...d }));
  const invoices: Doc[] = (init.invoices ?? []).map((d) => ({ ...d }));
  const creditnotes: Doc[] = (init.creditnotes ?? []).map((d) => ({ ...d }));
  const shipmentorders: Doc[] = (init.shipmentorders ?? []).map((d) => ({ ...d }));
  const webhooks: Doc[] = (init.webhooks ?? []).map((d) => ({ ...d }));
  const workflows: Doc[] = (init.workflows ?? []).map((d) => ({ ...d }));
  const payments: Doc[] = [];
  const refunds: Doc[] = [];
  let seq = 1000;
  const fetchMock = vi.fn(async (input: URL | string, req: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = req.method ?? "GET";
    const failure = init.fail?.(url, req);
    if (failure) return failure;

    if (url.pathname === "/oauth/v2/token") {
      return jsonResponse({ access_token: "refreshed-at", expires_in: 3600 });
    }
    const path = url.pathname.replace(/^\/(inventory\/v1|books\/v3)/, "");
    if (path === "/items" && method === "GET") {
      const sku = url.searchParams.get("sku");
      const name = url.searchParams.get("name");
      const found = items.filter((i) => (sku !== null ? i.sku === sku : name !== null ? i.name === name : true));
      return jsonResponse({ code: 0, items: found.map((i) => ({ ...i })) });
    }
    if (path === "/items" && method === "POST") {
      const item = { item_id: String(seq++), ...JSON.parse(String(req.body)) };
      items.push(item);
      return jsonResponse({ code: 0, item });
    }
    const body = () => JSON.parse(String(req.body));
    if (path === "/settings/taxes") return jsonResponse({ code: 0, taxes });
    if (path === "/contacts" && method === "GET") {
      const email = url.searchParams.get("email");
      return jsonResponse({ code: 0, contacts: contacts.filter((c) => !email || c.email === email) });
    }
    if (path === "/contacts" && method === "POST") {
      const data = body();
      const contact = {
        contact_id: String(seq++),
        ...data,
        email: data.contact_persons?.[0]?.email,
        ...(data.shipping_address ? { shipping_address: { ...data.shipping_address, address_id: String(seq++) } } : {}),
      };
      contacts.push(contact);
      return jsonResponse({ code: 0, contact });
    }
    const addressMatch = path.match(/^\/contacts\/(\w+)\/address$/);
    if (addressMatch && method === "POST") {
      const contact = contacts.find((c) => c.contact_id === addressMatch[1])!;
      const address = { ...body(), address_id: String(seq++) };
      (contact.addresses ??= []).push(address);
      return jsonResponse({ code: 0, address_info: address });
    }
    const contactMatch = path.match(/^\/contacts\/(\w+)$/);
    if (contactMatch) {
      const contact = contacts.find((c) => c.contact_id === contactMatch[1]);
      if (method === "PUT") Object.assign(contact!, body());
      return jsonResponse({ code: 0, contact: { ...contact } });
    }
    const invoicePayment = path.match(/^\/invoices\/(\w+)\/payments\/(\w+)$/);
    if (invoicePayment && method === "DELETE") {
      // Like Zoho: a payment taken off its only invoice is deleted.
      const payment = payments.find((p) => p.invoices?.some((a: Doc) => a.invoice_payment_id === invoicePayment[2]))!;
      const applied = payment.invoices.find((a: Doc) => a.invoice_payment_id === invoicePayment[2]);
      const invoice = invoices.find((i) => i.invoice_id === invoicePayment[1])!;
      invoice.balance += applied.amount_applied;
      payment.invoices = payment.invoices.filter((a: Doc) => a !== applied);
      if (!payment.invoices.length) payments.splice(payments.indexOf(payment), 1);
      else payment.unused_amount += applied.amount_applied;
      return jsonResponse({ code: 0, message: "The payment has been deleted." });
    }
    const invoicePayments = path.match(/^\/invoices\/(\w+)\/payments$/);
    if (invoicePayments) {
      return jsonResponse({
        code: 0,
        payments: payments.filter((p) => p.invoices?.some((a: Doc) => a.invoice_id === invoicePayments[1])),
      });
    }
    for (const [collection, list, key, idKey] of [
      ["/salesorders", salesorders, "salesorder", "salesorder_id"],
      ["/invoices", invoices, "invoice", "invoice_id"],
      ["/creditnotes", creditnotes, "creditnote", "creditnote_id"],
    ] as const) {
      if (path === collection && method === "GET") {
        const ref = url.searchParams.get("reference_number");
        return jsonResponse({ code: 0, [collection.slice(1)]: list.filter((d) => !ref || d.reference_number === ref) });
      }
      if (path === collection && method === "POST") {
        const data = body();
        const lines = (data.line_items ?? []).map((line: Doc) => ({
          line_item_id: String(seq++),
          account_id: "sales",
          ...(key === "salesorder" ? { quantity_packed: 0, quantity_shipped: 0 } : {}),
          // Zoho fills in the item's name on item lines.
          ...(line.item_id ? { name: items.find((i) => i.item_id === line.item_id)?.name } : {}),
          ...line,
        }));
        const total = lines.reduce((sum: number, l: Doc) => sum + l.rate * l.quantity - (l.discount ?? 0), 0) + (data.shipping_charge ?? 0);
        const prefix = { salesorder: "SO", invoice: "INV", creditnote: "CN" }[key];
        const doc: Doc = { [idKey]: String(seq++), [`${key}_number`]: `${prefix}-${seq}`, ...data, line_items: lines, total, balance: total, status: "draft" };
        if (key === "salesorder") doc.shipped_status = "pending";
        if (key === "invoice") {
          // Invoicing a sales order's lines ties the two, like Zoho.
          const so = salesorders.find((o) => o.line_items?.some((l: Doc) => lines.some((x: Doc) => x.salesorder_item_id === l.line_item_id)));
          if (so) so.invoice_id = doc.invoice_id;
        }
        list.push(doc);
        return jsonResponse({ code: 0, [key]: doc });
      }
      const docMatch = path.match(new RegExp(`^${collection}/(\\w+)(/status/(sent|void|confirmed)|/refunds)?$`));
      if (docMatch) {
        const doc = list.find((d) => d[idKey] === docMatch[1]);
        if (docMatch[3] === "void" && key === "salesorder" && doc!.invoice_id) {
          const invoice = invoices.find((i) => i.invoice_id === doc!.invoice_id);
          if (invoice?.status !== "void") return jsonResponse({ code: 36009, message: "Invoiced sales order cannot be marked void." }, 400);
        }
        if (docMatch[3] === "void" && key === "invoice" && payments.some((p) => p.invoices?.some((a: Doc) => a.invoice_id === doc![idKey]))) {
          return jsonResponse({ code: 1047, message: "Invoices with payments cannot be voided" }, 400);
        }
        if (docMatch[3]) doc!.status = docMatch[3];
        if (docMatch[2] === "/refunds") {
          const refund = { creditnote_refund_id: String(seq++), creditnote_id: doc![idKey], ...body() };
          refunds.push(refund);
          doc!.balance -= refund.amount;
          return jsonResponse({ code: 0, creditnote_refund: refund });
        }
        return jsonResponse({ code: 0, [key]: { ...doc } });
      }
    }
    const paymentMatch = path.match(/^\/customerpayments\/(\w+)(\/refunds)?$/);
    if (paymentMatch) {
      const payment = payments.find((p) => p.payment_id === paymentMatch[1]);
      if (!payment) return jsonResponse({ code: 1002, message: "Payment does not exist." }, 404);
      if (method === "PUT") {
        const data = body();
        for (const applied of payment.invoices ?? []) {
          const invoice = invoices.find((i) => i.invoice_id === applied.invoice_id);
          if (invoice) invoice.balance += applied.amount_applied;
        }
        Object.assign(payment, data);
        payment.unused_amount = payment.amount - (data.invoices ?? []).reduce((sum: number, a: Doc) => sum + a.amount_applied, 0);
      }
      if (method === "POST" && paymentMatch[2]) {
        const refund = { payment_refund_id: String(seq++), payment_id: payment.payment_id, ...body() };
        refunds.push(refund);
        payment.unused_amount -= refund.amount;
        return jsonResponse({ code: 0, payment_refund: refund });
      }
      return jsonResponse({ code: 0, payment: { ...payment } });
    }
    if (path === "/customerpayments" && method === "POST") {
      const data = body();
      const payment = {
        payment_id: String(seq++),
        account_id: "undeposited",
        unused_amount: 0,
        ...data,
        invoices: (data.invoices ?? []).map((a: Doc) => ({ invoice_payment_id: String(seq++), ...a })),
      };
      payments.push(payment);
      for (const applied of payment.invoices ?? []) {
        const invoice = invoices.find((i) => i.invoice_id === applied.invoice_id);
        if (invoice) invoice.balance -= applied.amount_applied;
      }
      return jsonResponse({ code: 0, payment });
    }
    if (path === "/settings/webhooks" && method === "GET") {
      // Like Zoho: each webhook lists the rules that use it.
      return jsonResponse({
        code: 0,
        webhooks: webhooks.map((h) => {
          const related = workflows
            .filter((w) => w.instant_actions?.some((a: Doc) => a.action_id === h.webhook_id))
            .map((w) => ({ workflow_id: w.workflow_id, workflow_name: w.workflow_name }));
          // Like Zoho: an empty string, not a list, when no rule uses the webhook.
          return { ...h, related_rules: related.length ? related : "" };
        }),
      });
    }
    if (path === "/settings/workflows" && method === "GET") return jsonResponse({ code: 0, workflows });
    if ((path === "/settings/webhooks" || path === "/settings/workflows") && method === "POST") {
      if (!init.settingsCreate) return jsonResponse({ code: 57, message: "You are not authorized to perform this operation" }, 401);
      if (path === "/settings/webhooks") {
        const webhook = { webhook_id: String(seq++), ...body() };
        webhooks.push(webhook);
        return jsonResponse({ code: 0, webhook });
      }
      const workflow = { workflow_id: String(seq++), is_active: true, ...body() };
      workflows.push(workflow);
      return jsonResponse({ code: 0, workflow });
    }
    const shipmentMatch = path.match(/^\/shipmentorders\/(\w+)$/);
    if (shipmentMatch) {
      const shipment = shipmentorders.find((d) => d.shipment_id === shipmentMatch[1]);
      if (!shipment) return jsonResponse({ code: 1003, message: "Shipment does not exist" }, 404);
      return jsonResponse({ code: 0, shipment_order: { ...shipment } });
    }
    const itemMatch = path.match(/^\/items\/(\w+)$/);
    if (itemMatch) {
      const item = items.find((i) => i.item_id === itemMatch[1]);
      if (!item) return jsonResponse({ code: 1003, message: "Item does not exist" }, 404);
      if (method === "PUT") Object.assign(item, JSON.parse(String(req.body)));
      return jsonResponse({ code: 0, item: { ...item } });
    }
    throw new Error(`unexpected Zoho ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const calls = (method: string, pathPart: string) =>
    fetchMock.mock.calls.filter(([u, r]) => (r?.method ?? "GET") === method && String(u).includes(pathPart));
  return { fetchMock, items, contacts, salesorders, invoices, creditnotes, payments, refunds, webhooks, workflows, calls };
}
