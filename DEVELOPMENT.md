# Zoho for Swell: technical notes

For developers working on the app. The merchant-facing description and setup guide is [README.md](README.md).

## Features

| Feature | Status |
|---|---|
| Connect a Zoho account with the merchant's own Zoho API client (OAuth 2.0, all Zoho data centers) | Done |
| Detect which products the Zoho organization has (Books, Inventory, or both) and pick an organization | Done |
| Disconnect, revoking the app's access at Zoho | Done |
| Products and variants → Zoho items, with a catalog sync button | Done |
| Customers → Zoho contacts, created with their first order | Done |
| Orders → sales orders (Inventory), invoices and payments | Done |
| Stock levels from Zoho Inventory → Swell, by webhook (Zoho is the source of truth) | Done |
| Shipments in Zoho Inventory → Swell shipments, by webhook | Done |

### Product sync

Each Swell variant becomes one Zoho item; a product without variants becomes one item. Items are named `Product — Variant`. Zoho item groups are not used, so the same flat items work in Books-only organizations.

- **Matching.** A Swell product or variant is linked to the Zoho item with the same SKU. Without a SKU, it is linked only when exactly one Zoho item has exactly the same name. The Zoho item id is stored in the app's `item-links` collection, and everything after that goes by that id.
- **Linking existing items** does not change them in Zoho. When Zoho Inventory tracks the item, the Swell stock level is replaced with Zoho's available-for-sale stock (Zoho is the source of truth for stock).
- **Prices.** A unit's price is its standard purchase option price (`purchase_options.standard.price`, the variant's first, then the product's), then the legacy `price` fields that mirror it, then the first active subscription plan's price for subscription-only products. The legacy `cost` field is not used anywhere.
- **Creating missing items.** Active products only; drafts are created when they become active. When Swell tracks stock (and the organization has Inventory), the item is a stock item with Swell's stock as opening stock. Zoho requires a positive opening stock rate (code 2051 otherwise) and Swell keeps no cost price, so opening stock is valued at the unit's price; a free product starts with no opening stock. Otherwise it is a non-stock item.
- **Deleting.** A deleted product or variant (`product.deleted`, `product.variant.deleted`) only drops its item links; the Zoho item stays. Failures of products deleted before this was handled are left out of the page's failure list.
- **Stock changes made in Swell.** Zoho owns stock, so a Swell stock change outside orders (a return put back to stock, a manual adjustment) is replaced with Zoho's level by `stock-adjusted` (`product.stock_adjusted`) within seconds. It reads the newest stock ledger entry and leaves sales, cancellations and the app's own entries alone. Returned goods count again once Zoho receives them (Sales Return Receive).
- **Edits.** Changing a product's or variant's name, SKU, price (including in `purchase_options`) or active state in Swell updates its Zoho item. Stock changes in Swell are never sent to Zoho; stock changes in Zoho reach Swell through the stock webhook (see [Updates from Zoho](#updates-from-zoho-webhooks)).
- **Catalog sync.** The **Sync products** button on the Zoho page links or creates items for the whole catalog. A cron job works through it in small batches (about 7 seconds a minute) and shows progress. When Zoho's API limit is reached (100 calls a minute; 1,000–10,000 a day depending on the Zoho plan) it pauses and continues automatically. Items that could not be synced are listed with Zoho's reason.
- **Not synced:** bundles, gift cards, deleting products or variants in Zoho, and Swell stock locations (opening stock goes to Zoho's default location).
- If Zoho tracks stock for an item but Swell does not, Swell can sell more than Zoho has. The Zoho page shows how many linked items are in that state.

### Order sync

- **When.** A placed order becomes a Zoho sales order (organizations with Inventory). Zoho creates sales orders as drafts, which reserve nothing, so the app confirms it right away; a confirmed sales order reserves the stock in Zoho. When the order is paid, an invoice is created from the sales order's lines, marked as sent (this does not email the customer) and a customer payment is recorded against it. Books-only organizations get the invoice and payment when the order is paid. Orders placed before connecting are not sent.
- **Customers.** A customer becomes a Zoho contact when their first order syncs, matched by email; an existing contact is linked without changes. Customers who never ordered are not sent. Later changes to a linked customer's name, email, phone or default addresses in Swell are sent to the contact. Each new shipping address is added to the contact once and used on the sales order.
- **Lines.** Each order line uses the product's linked Zoho item (linked or created on the way). Bundles and gift cards become text lines. Line discounts are sent as item-level discounts; shipping is sent as the shipping charge.
- **Taxes.** Each line's tax is matched to a Zoho tax with exactly the same percentage (and the shipping tax likewise). If Zoho has no such tax, the order is not sent and shows an error until one is created. Lines with more than one tax are not supported yet.
- **Idempotency.** Every Zoho document id is saved on the order as soon as it is created, and before creating a document the app looks for one with the order number as reference, so retries never duplicate.
- **Time limit.** Functions are killed at 10 seconds, and each Zoho or Swell call takes 0.2–1.5 s from the function, so a paid order needs two or three runs. Each run stops starting Zoho writes after about 5 seconds, saves what it did and marks the order "In progress" (`pending`). That update starts the next run at once through `order-continue`, not the platform's event redelivery, which backs off to about 12 minutes after the second try. After 6 such runs in a row, the order waits for the retry job instead, so a run that makes no progress cannot chain forever. A run that was killed anyway is recovered once its mark is two minutes old, looking up by order number whatever it created but did not save. The retry job gives each order only the time left in its own 10 seconds.
- **Event order.** Events for one order can run at the same time (`paid` seconds after `submitted`, `refunded` right after `canceled`). Every run marks the order before it starts and clears the mark when done; a run that finds a mark under two minutes old backs off, and its event is redelivered about a minute later. An order already paid when `submitted` runs is handled entirely by `paid`.
- **Failures** are shown on the order (Zoho tab) and on the Zoho page, and retried automatically after 10 minutes, doubling up to once a day, or immediately with **Retry now**.
- **Cancellations and refunds.** The app never moves stock in Zoho on its own; it only reverses documents.
  - Canceled before payment: the sales order is voided, which releases the reserved stock.
  - Paid and canceled before anything was packed or shipped (Books-only: before Swell delivered anything): the payment is taken off the invoice, which in Zoho deletes a payment that covered only that invoice; then the invoice and the sales order are voided. Zoho ends up as if the order never happened, with the voided documents kept for the record. The money received and refunded in Swell net to zero, so no refund is recorded; merchants who reconcile bank feeds in Zoho match that charge and refund by hand. (Zoho allows neither voiding a sales order that has an invoice nor voiding an invoice that has a payment, and it rejects or ignores payment updates that change the invoices a payment covers.)
  - Shipped and then canceled, or fully refunded without a cancellation: a money-only credit note for the whole invoice (the invoice's lines as sales-account lines plus shipping, so no stock moves) and, once refunded in Swell, a refund of that credit note from the account the payment was deposited to. Goods that physically come back are received in Zoho by the warehouse.
  - Partial refunds are not sent yet.
- **Payment mode** in Zoho: card payments are recorded as credit card, bank transfers as bank transfer, everything else as "others".

### Updates from Zoho (webhooks)

Shipments and stock changes come from Zoho by webhook; the app never polls Zoho for them. Zoho sends them through one workflow rule per module, each with a webhook to this store's `zoho-webhook` function. The Zoho page shows, per module, whether its rule is set up, creates missing ones and updates outdated ones with **Set up in Zoho**, shows when each topic last received a call, and lists calls that could not be processed.

- **Setup from the page.** The app reads Zoho's webhooks and workflow rules (`GET /settings/webhooks`, `/settings/workflows`) and shows, per module, whether a rule with a webhook of this store exists and is active, and whether that webhook is current. **Set up in Zoho** creates what is missing: a webhook (POST, JSON default payload, the headers below) and a workflow rule on create or edit, every time, per module. It also updates outdated webhooks (`PUT /settings/webhooks/<id>`). A webhook left behind by a deleted rule is reused instead of duplicated (Zoho reports a webhook no rule uses with `related_rules: ""`). This needs the `ZohoInventory.settings.CREATE` and `UPDATE` scopes; a connection made before a scope was added is asked to reconnect once.
- **Address and headers.** Every webhook posts to `https://<store>.swell.store/functions/zoho/zoho-webhook`, the store gateway address of the webhook function, which stays the same for the life of the store. It sends three headers: `Authorization: <install public key>` (the gateway needs a public key to find the app, and picks test or live by it), `X-Swell-Topic: shipments|stock`, and `X-Swell-Token: <token>`. The token is a random per-store secret created the first time the page loads, and it survives reconnecting. Calls with another token are refused (401). The gateway drops query parameters from a POST with a body, so nothing is passed in the URL. Changing the organization resets which webhooks have been seen and set up, not the token.
- **Current webhooks.** Zoho's webhook list does not return header values, so the connection records the install key the webhooks were given (`webhook_public_key`) and which webhooks have it (`webhook_current_ids`). A webhook of this store is outdated when its URL is not the function's (the first versions posted to the app page) or it is not recorded with the current key.
- **After a reinstall.** A new install gets a new public key, and the app page a new host, so every webhook goes stale at once. The `product-backfill` cron (every minute) compares the install key with `webhook_public_key`, reads Zoho only when they differ (or once a day, to catch webhooks edited in Zoho) and updates the stale webhooks. A Zoho webhook update takes about two seconds, so each run updates what fits in 5 seconds (two, in practice) and the next run goes on. Stock changes Zoho sent in between were lost, so it then refreshes the stock of every linked item Zoho tracks, 10 at a time, in id order (`stock_catchup`). When the token lacks `settings.UPDATE`, it records `webhook_repair_error: needs_reconnect`, stops trying, and the page asks for a reconnect; connecting clears it. The page also flags the OAuth redirect URI: Zoho only accepts the one registered in its API Console, which still has the old host.
- **Shipments.** A call from the Shipment orders rule naming a sales order that came from Swell brings the Swell order up to date. The app reads the sales order, compares each line's shipped quantity (shipped plus manually fulfilled) with what Swell has delivered, and creates one Swell shipment for the difference. The shipment gets the Zoho shipment's tracking number, carrier and service, the order's shipping address, and a note with the Zoho shipment number. Swell sends its shipment email if that notification is on. Partial shipments work the same way. When a shipment is edited in Zoho later (tracking number added or changed), the Swell shipment made from it gets the new tracking. A call with nothing new, for an order that did not come from Swell, or for a canceled order is ignored. If someone changed the sales order's lines in Zoho so they no longer match the order, the call fails with that reason instead of guessing.
- **Stock.** A call from any module sets the Swell stock of every linked item it mentions, when Zoho tracks that item, to Zoho's available-for-sale stock. Units Swell has sold that Zoho does not count yet are held back first: those are orders from the last 7 days (and since connecting) that are not canceled and whose sales order is not yet confirmed or invoiced in Zoho. Otherwise a stock change arriving between checkout and the sales order would put sold units back on sale. Nothing is held back while order sync is off. Stock changes from the app's own sales orders arrive too, and come out the same.
- **Payload.** Zoho's **Default Payload** is JSON with the record under its module key, e.g. `{"shipment_order": {"shipment_order_id": …, "salesorder_id": …}}`. Form bodies (including the older `payload=${JSONString}` style) are read too.
- **Which stock webhooks to add.** One per module that changes stock: Inventory Adjustment, Purchase Receive, Transfer Order, Sales Return Receive (a sales return moves stock only when received), and Sales Order and Invoice (for sales outside Swell), each with a rule on create and edit.
- **Without the webhooks.** Without shipments, orders shipped in Zoho stay unfulfilled in Swell. Without stock, Swell stock changes only with **Sync products**, so stock received, adjusted or sold outside Swell is out of date in Swell and Swell can oversell.
- **Processing.** The `zoho-webhook` function stores each call in the `webhook-events` collection and answers at once. Zoho's check call, sent when a webhook is saved (`payload=` as a form, `{"payload": ""}` as JSON), marks the topic as receiving but is not stored. Each processed call records what it did in `note`, e.g. `ZT-TEE-RED: Zoho 5, Swell 6 → 5`. The `webhook-event` function processes it. A stock call that touches more items than one run can handle within its time budget passes the rest to a new event. A Zoho rate limit, or another run busy with the same order, makes the function throw, and the platform redelivers the event. The `webhook-maintenance` cron (every 10 minutes, Swell only, no Zoho calls unless there is work) retries calls still unprocessed after 5 minutes, up to 3 times. It also deletes handled calls after 14 days.

### Books-only organizations

Not every Zoho organization has Zoho Inventory. When the connected organization has Books only, the app syncs contacts, items (as non-inventory items) and invoices. Stock and fulfilment sync are off, and the Zoho page in Swell says so.

## Settings

`settings/connection.json` → **Zoho connection**

| Field | Meaning |
|---|---|
| `data_center` | Zoho data center of the merchant's account: `us`, `eu`, `in`, `au`, `jp`, `ca`, `sa`, `uk`. Default `us`. |
| `client_id` | Client ID of the merchant's server-based Zoho API client |
| `client_secret` | Client secret of that client. Changing it requires connecting again. |

`settings/sync.json` → **Sync**

| Field | Meaning |
|---|---|
| `products` | Sync products and variants to Zoho items. Default on. When off, product events are ignored and the catalog sync cannot start. |
| `orders` | Sync orders, customers and payments. Default on. |

The dashboard shows them as **Step 1 · Zoho API client** (data center, client ID and secret side by side) and **Step 2 · What to sync** (two toggles). Swell orders settings sections by label and does not render field descriptions, so the guidance lives in section descriptions, labels and placeholders; the full step-by-step setup, with the redirect URI and a link to the right API Console, is on the Zoho page.

Swell settings are not a secret store: the client secret is stored as a normal setting value, visible to store admins (a masked field is not available: `ui: "password"` fails on push).

## What the app asks Zoho for

The app always requests the same scopes; the merchant does not choose them.

- Zoho Books: `settings` (items, organizations), `contacts`, `invoices` — create, update, read; `invoices` — delete, used only to take a payment off an invoice when a paid order is canceled before shipping
- Zoho Books: `customerpayments` — create, update, read; `creditnotes` — create, update, read
- Zoho Inventory: `settings` (read), `contacts`, `items`, `salesorders`, `invoices` — create, update, read; `invoices` — delete (same reason); `customerpayments` — create, update, read; `creditnotes` — create, update, read; `packages` and `shipmentorders` — read; `settings` — create and update, only to add this store's webhooks and workflow rules and to update the webhooks after a reinstall

Changing this list later means every merchant must connect again.

## How it works

- **The Zoho page** is the app's `frontend/` worker (Hono), reached through the Swell admin proxy at `https://<store>--<install id>--app.swell.store`. The host changes when the app is installed again, so nothing given to Zoho for server calls uses it. Its `/app-api/*` routes require a valid Swell dashboard session: the `_swell_admin_session` cookie is checked against the admin API (`GET <admin>/admin/api/session` with `X-Session`), because the app's own token cannot read dashboard sessions. All `/app-api/*` routes are POST-only and send `Cache-Control: no-store`: the Swell admin proxy caches GET responses without the session cookie in its cache key, so an authenticated GET would be served to anyone requesting the same URL.
- **The OAuth callback** is `GET /oauth/callback` on that same host. A browser redirect from Zoho cannot send Swell API keys, and Swell's function routes require one, so the callback lives on the app page, where the proxy supplies the app's credentials.
- **Security of the callback:** the OAuth `state` is `<store id>.<nonce>`. The nonce is random, stored on the connection record, valid for 10 minutes and accepted once. The client secret is only ever sent to a known Zoho accounts server.
- **Data center:** the consent screen is opened on the configured data center. Zoho reports the account's data center on the redirect (`accounts-server`); tokens are exchanged there, and every later call uses the `api_domain` Zoho returns.
- **Tokens** live in the app collection `apps/zoho/connections` (one record per store), never in settings.
- **Zoho webhooks** post to the public route function `zoho-webhook` through the store gateway (see above). The token is compared in constant time, bodies over 1 MB are refused, and only `content-type`, `x-swell-topic` and `x-swell-token` reach the function.

## Limits

- The merchant has to register their own Zoho API client. There is no shared "Swell" client in Zoho, because Swell apps have no store-independent callback URL to register with Zoho.
- Amounts are sent to Zoho without currency conversion, in the organization's currency. The store and the Zoho organization should use the same currency; the Zoho page warns when they differ (the organization's currency is recorded on connect, the store's comes from `settings/store.currency`, USD when unset). Taxes are not set on items.
- Swell's gateway reserves `/api/*` on `*.swell.store` hosts, which is why the page API lives under `/app-api/*`.
- Zoho limits workflow webhook calls per day by plan (1,000 to 10,000 depending on the plan; the Workflow Rules page shows usage). With the rules above, each Swell order causes about four stock calls (sales order created and confirmed, invoice created and sent) plus one per shipment. Calls over the limit are not sent, and Swell stock then waits for the next call or **Sync products**.

## Development

Requirements: Node 22+, the Swell CLI logged in to the `swell-apps` store, and for the frontend deploy `wrangler login` plus `CLOUDFLARE_ACCOUNT_ID` in the environment.

```bash
npm install
npm run typecheck
npm test                 # vitest in the Workers runtime
swell app push --force   # deploy to the test environment
```

- Shared code is in `functions/lib/`. The frontend worker imports it too.
- **Always push with `--force` after changing `functions/lib/`.** Push skips unchanged top-level files by hash, and the frontend deploy hash does not cover `functions/lib/`, so without `--force` both keep running the old code.
- `swell app push` exits 0 even when a file fails. Read its output, then check `swell inspect models --app=.` and `swell inspect settings --app=.`.
- For the full connect flow on the test store, register a Zoho client whose redirect URI is the test store's callback URL, shown on the Zoho page.

### Layout

| Path | Purpose |
|---|---|
| `settings/connection.json` | Merchant credentials and data center |
| `models/connections.json` | `apps/zoho/connections`: tokens, data center, organization |
| `content/connections.json` | Sidebar entry "Zoho" linking to the frontend page |
| `frontend/public/index.html` | The Zoho page UI |
| `frontend/src/` | Worker: page API, OAuth callback, Swell API client |
| `functions/lib/zoho/` | Zoho data centers, OAuth, state, organizations |
| `functions/lib/connection/` | Connect, callback, organization choice, disconnect |
| `settings/sync.json` | What to sync |
| `models/item-links.json` | `apps/zoho/item-links`: Swell product/variant ↔ Zoho item, with sync status and error |
| `functions/product-sync.ts` | Product and variant events → link, create or update the Zoho item |
| `functions/product-backfill.ts` | Cron, every minute: catalog sync in batches, Zoho webhook update after a reinstall, the stock refresh that follows |
| `functions/lib/zoho/client.ts` | Zoho API client: token refresh, organization id, rate-limit errors |
| `functions/lib/products/` | Sellable units, matching, item creation, stock, catalog sync, page status |
| `models/orders.json` | Order extension: Zoho status, document ids and links, error, retry schedule (`$app.zoho`) |
| `models/contact-links.json` | `apps/zoho/contact-links`: Swell customer ↔ Zoho contact, with known shipping addresses |
| `content/orders.json` | Zoho column on the order list and a Zoho tab on the order page |
| `functions/order-sync.ts` | `order.submitted` / `paid` / `canceled` / `refunded` → sales order, invoice, payment, void, credit note, refund |
| `functions/order-retry.ts` | Cron: retries failed orders |
| `functions/stock-adjusted.ts` | `product.stock_adjusted` → Zoho's level back after a Swell stock change outside orders |
| `functions/order-continue.ts` | `order.updated` while `pending` → the next step of an order that stopped at its time budget |
| `functions/account-sync.ts` | Customer edits → linked Zoho contact |
| `functions/lib/orders/`, `functions/lib/contacts/` | Order documents, taxes, contacts, addresses, retry, page status |
| `models/webhook-events.json` | `apps/zoho/webhook-events`: stored Zoho webhook calls, their outcome and error |
| `models/shipments.json` | Shipment extension: the Zoho shipment a Swell shipment came from (`$app.zoho`) |
| `functions/zoho-webhook.ts` | Public route: Zoho webhook calls → `webhook-events` |
| `functions/webhook-event.ts` | `webhook-event.created` → process a stored call (shipments, stock) |
| `functions/webhook-maintenance.ts` | Cron: retry unprocessed calls, delete old ones |
| `functions/lib/webhooks/` | Endpoint and headers (`endpoint.ts`), payload parsing, token check and storage, stock refresh, shipments, Zoho rule setup (`zoho-setup.ts`), update after a reinstall (`repair.ts`), stock refresh of every item (`catchup.ts`), page status |
| `frontend/public/_headers` | `Cache-Control: no-store` for the page, so the dashboard never shows an old copy after a deploy |
| `test/unit/` | Vitest suites |
| `assets/icon.png` | App icon: the Zoho logo (square corners; the dashboard rounds them) |
| `assets/image.png` | App Store cover image (`cover_image`) |
| `assets/images/*.png` | App Store screenshots, listed in `swell.json` `images` with a title (≤ 40 characters) and caption (≤ 140). Generated 1600×900 scenes rendered at 2x (3200×1800); sample data only |
| `DESCRIPTION.md` | Full App Store description for Marketing (≤ 20,000 characters). CLI 2.9.18 does not read it, so `swell.json` `full_description` keeps a shorter copy (the skill documents a 3,500 limit) |
