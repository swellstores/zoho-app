# Zoho Books & Inventory for Swell

**Keep your Swell store and Zoho in step, automatically.**

The app connects a Swell store to Zoho Books, Zoho Inventory, or both. Products and variants become Zoho items, customers become Zoho contacts, and every order reaches Zoho as a sales order, then an invoice and a payment once it is paid. Cancellations and refunds are reversed in Zoho. In the other direction, Zoho Inventory becomes the place where stock is managed: stock changes and shipments made in Zoho come back to Swell within seconds.

---

## Features

### Connection to Zoho

Connects the store to one Zoho organization through the merchant's own Zoho API client, in any Zoho region (zoho.com, .eu, .in, .com.au, .jp, zohocloud.ca, .sa, .uk). The app detects whether the organization has Zoho Books, Zoho Inventory or both, and warns when the store and the organization use different currencies. **Disconnect** removes the app's access at Zoho.

- **Where you see it:** **Zoho** in the dashboard sidebar (the app's page), and **Apps → Zoho → Settings**.
- **Built with:** the app page (`frontend/`) with its sign-in callback (`/oauth/callback`); credentials in settings `connection`; tokens in the app collection `connections`.

### Products and variants

Every product and variant is linked to a Zoho item: by SKU, or by an exact name when there is no SKU. Items that already exist in Zoho are linked without changes, and the product's Swell stock is set to Zoho's available quantity; missing ones are created for active products (each variant as its own item, named "Product — Variant"). Stock-tracked products become stock items in Zoho Inventory, with Swell's stock as opening stock, valued at the product's regular price. Later changes to a name, SKU or price are sent to Zoho; status changes are not. **Sync products** brings the existing catalog over in the background, with progress and a list of anything Zoho rejected. It does not refresh the stock of items that are already linked. Deleting a product in Swell leaves its Zoho item in place.

- **Where you see it:** the **Products** card on the Zoho page.
- **Built with:** `product-sync` (`product.created`, `.updated`, `.deleted`, and the same for variants), `product-backfill` (cron, every minute: works only while a catalog sync or a stock refresh runs), the app collection `item-links`.

### Customers

A customer becomes a Zoho contact with their first order, matched by email, with their billing and shipping addresses. Later changes to their name, email, phone or default addresses are sent to the contact. Customers who never ordered are not sent.

- **Where you see it:** in Zoho, under Customers.
- **Built with:** order sync (below), `account-sync` (`account.updated`), the app collection `contact-links`.

### Orders, invoices and payments

A placed order becomes a Zoho sales order, which reserves the stock. When the order is paid, an invoice is created from the sales order and the payment is recorded against it. Books-only organizations get the invoice and payment when the order is paid. Line prices, discounts and shipping are included; each line's tax is matched to the Zoho tax with the same rate. An order that can't be sent (for example, Zoho has no tax with that rate) waits with a clear message and is retried automatically.

- **Where you see it:** the **Orders** card on the Zoho page (with **Retry now**), a **Zoho** column in the order list, and a **Zoho** tab on each order with links to its documents in Zoho.
- **Built with:** `order-sync` (`order.submitted`, `order.paid`), `order-continue` (`order.updated`, finishes orders that need more than one run), `order-retry` (cron, every 10 minutes), the content view `content/orders.json`, and the order fields under `$app.zoho`.

### Cancellations and refunds

- Canceled before payment: the sales order is voided and the stock released.
- Canceled after payment, before anything is packed or shipped: the payment is removed and the invoice and sales order voided, as if the order never happened.
- Canceled or fully refunded after anything was packed or shipped: a money-only credit note for the whole invoice is recorded, and its refund when the order is refunded. No stock moves; returned goods count again when the warehouse receives them in Zoho. The sales order is not voided, so unshipped items stay reserved.
- Fully refunded without being canceled: the same credit note and refund, even when nothing has shipped. The sales order stays open with its stock reserved.

- **Where you see it:** the **Zoho** tab on the order.
- **Built with:** `order-sync` (`order.canceled`, `order.refunded`).

### Stock from Zoho

Zoho owns stock. When stock changes in Zoho (adjustments, purchase receives, transfer orders, sales return receives, and sales orders or invoices from other channels), the Swell stock of the items involved is set to Zoho's available-for-sale quantity within seconds. Units Swell has sold that Zoho hasn't recorded yet are held back. Stock changed directly in Swell outside orders (a return put back in stock, a manual adjustment) is set back to Zoho's number.

- **Where you see it:** product stock in Swell, and the **Updates from Zoho** card on the Zoho page.
- **Built with:** Zoho workflow rules with webhooks to the app's `zoho-webhook` function, stored in the app collection `webhook-events` and processed by `webhook-event` (`webhook-event.created`); `webhook-maintenance` (cron, every 10 minutes) retries and cleans them up; `stock-adjusted` (`product.stock_adjusted`) resets Swell-side changes.

### Shipments from Zoho

When an order is shipped in Zoho, the Swell order gets a shipment with the carrier and tracking number, and Swell sends its shipping email if that notification is on. Partial shipments and tracking numbers added later are handled too.

- **Where you see it:** **Fulfillment** on the Swell order.
- **Built with:** a Zoho workflow rule on shipment orders with a webhook to the `zoho-webhook` function, processed by `webhook-event`; the shipment field `$app.zoho.zoho_shipment_id`.

### One-click Zoho rules

The app reads the Zoho organization's workflow rules and shows, per Zoho module, whether the rule that sends updates to Swell is set up, missing, turned off or in need of an update. **Set up in Zoho** creates the missing ones and updates outdated ones; a rule turned off in Zoho has to be turned back on there. Manual setup steps, with the address and headers to use, are there too.

If you install the app again, the rules keep working: within a few minutes the app points them at the new installation by itself, then refreshes Swell stock from Zoho for every linked item Zoho tracks, so changes made in between are not lost.

- **Where you see it:** the **Updates from Zoho** card on the Zoho page.
- **Built with:** the app page, through Zoho's webhook and workflow settings; `product-backfill` (cron, every minute) for the update after a reinstall.

---

## Setup

### What you need

- A Zoho Books or Zoho Inventory organization (or both), and a Zoho user who can create API clients and approve access.
- The same currency in the Swell store and the Zoho organization.
- About 15 minutes.

### Steps

1. **Install the app** from the Swell App Store, then open **Zoho** in the dashboard sidebar.
2. **Create a Zoho API client.** On the Zoho page, copy the **Authorized Redirect URI**. Open the Zoho API Console for your region (the page links to it), choose **Add Client → Server-based Applications**, give it any name and paste the redirect URI. Zoho shows a **Client ID** and a **Client Secret**.
3. **Enter the details** in **Apps → Zoho → Settings** (below) and press **Save settings**.
4. **Connect.** On the Zoho page, press **Connect to Zoho**, sign in and approve access. If the Zoho user has several organizations, pick one.
5. **Sync your catalog** with **Sync products**.
6. **Turn on updates from Zoho** (Zoho Inventory) with **Set up in Zoho**. Every line should show **✓ Set up**.

### Settings

**Step 1 · Zoho API client**

| Setting | What it does |
|---|---|
| Zoho data center | The Zoho region you sign in to. Decides which Zoho sign-in page and API Console are used. |
| Client ID | From your Zoho API client. |
| Client secret | From the same client. Changing it requires connecting again. |

**Step 2 · What to sync**

| Setting | What it does |
|---|---|
| Products, variants and stock | Links products and variants to Zoho items and keeps them updated. Off: product changes are not sent and **Sync products** can't be started; stock updates from Zoho continue, and orders still create Zoho items for lines that have none. |
| Orders, customers and payments | Sends orders, customers, invoices and payments to Zoho. Off: new orders are not sent. |

Both are on by default. Turning one off stops it from then on; nothing already in Zoho is changed.

### What the app asks Zoho for

Read and write access to contacts, items, sales orders, invoices, customer payments and credit notes; read access to settings, packages and shipments; creating webhooks and workflow rules, and updating the webhooks; and removing a payment from an invoice (only to undo a paid order that is canceled before shipping).

---

## Day-to-day use

- **Nothing to do for new products, orders and customers.** They sync on their own.
- **Manage stock in Zoho.** Receive goods, adjust, transfer and process returns there; Swell follows.
- **Ship in Zoho.** The Swell order is marked as shipped, with tracking.
- **Check the Zoho page now and then.** It lists anything that needs attention: products Zoho rejected, orders waiting to be sent, and Zoho rules that are missing or turned off.
- **Fix and retry.** If an order waits, the message says what Zoho needs (most often a tax with the order's rate). Fix it in Zoho and press **Retry now**, or let the automatic retry pick it up.

---

## Limits and known issues

**Not supported yet**

- Partial refunds.
- Bundles and gift cards (they become text lines on orders).
- Swell stock locations (all stock is Zoho's default location).
- Order lines with more than one tax.
- Deleting a stock document in Zoho (an adjustment or receive) does not update Swell until the next change of that item.
- Orders placed while the app is not connected, or while order sync is off, are not sent when placed. If such an order is paid or fully refunded later, it is sent then.
- Amounts are sent without currency conversion.

**Rate limits**

- Zoho's API allows 100 calls a minute per organization and a daily number that depends on the Zoho plan (about 1,000 to 10,000). The catalog sync pauses at a limit and continues by itself; orders are retried.
- Zoho limits workflow webhook calls per day by plan. Each Swell order causes a few stock calls (its sales order and invoice) and one per shipment. Calls over the limit are not sent; Swell stock then catches up with the item's next stock call. **Sync products** does not refresh items that are already linked.
- Swell stops functions after 10 seconds. Orders that need more calls continue in follow-up runs, usually within a minute.

**Environments**

- Each Swell environment (test and live) has its own connection, settings and webhook keys. Connect them to different Zoho organizations: both use the same webhook address, so the environment connected last takes over the other's Zoho rules.
- Installing the app again gives the Zoho page a new address. Before you press **Reconnect**, replace the redirect URI in the Zoho API Console with the new one; the Zoho page shows it and warns you. The Zoho rules are updated by the app itself.
- Every Zoho data center is supported: US, EU, India, Australia, Japan, Canada, Saudi Arabia and UK.
- Tested end to end in the test environment of the swell-apps store, with a Zoho Books + Inventory organization in the EU data center. Books-only organizations are covered by automated tests only.

**Known issues**

- The client secret is visible to store admins in the settings (Swell has no masked setting field).
- The Zoho API client is created by each merchant, because Swell apps have no store-independent sign-in address to register with Zoho.
- Switching to another Zoho organization keeps the links to the first organization's items and contacts, so orders sent afterwards can fail.
- Units held back for unsent orders only cover orders from the last 7 days that were placed since the last connect, so reconnecting stops holding back older ones.

---

## Development

**Requirements:** Node 22+, the Swell CLI logged in to the `swell-apps` store, and for the app page `wrangler login` plus `CLOUDFLARE_ACCOUNT_ID` in the environment.

```bash
npm install
npm run typecheck
npm test                 # Vitest in the Workers runtime
swell app push --force   # deploy to the test environment of swell-apps
swell inspect functions --app=.
```

- **Always push with `--force`** after changing `functions/lib/`: push skips unchanged entry files, so shared code would otherwise stay stale in functions and in the app page.
- `swell app push` exits successfully even when a file fails; read its output and check `swell inspect`.
- The app page (`frontend/`) and the functions share the code in `functions/lib/`.
- For a full connect test, register a Zoho API client whose redirect URI is the one shown on the Zoho page of the test store.

**Where things are:** `functions/` (event, cron, the webhook route and shared code), `frontend/` (the Zoho page), `models/` (app collections and order and shipment fields), `content/` (sidebar entry and order views), `settings/`, `test/unit/`, `assets/` (icon and screenshots). Architecture, design decisions and Zoho quirks are described in [DEVELOPMENT.md](DEVELOPMENT.md).
