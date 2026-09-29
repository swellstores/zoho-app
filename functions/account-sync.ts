import { loadContactLink, updateContactFromAccount, type SwellAccount } from './lib/contacts/contacts';
import type { AppContext } from './lib/swell-client';
import { createZohoClient } from './lib/zoho/client';

export const config: SwellConfig = {
  description: 'Send customer name, phone, email and address changes to the linked Zoho contact',
  model: {
    events: ['account.updated'],
  },
};

const CONTACT_FIELDS = new Set(['name', 'first_name', 'last_name', 'email', 'phone', 'billing', 'shipping']);

export default async function (req: SwellRequest) {
  const changed = Object.keys(req.data.$event?.data ?? {});
  if (!changed.some((field) => CONTACT_FIELDS.has(field))) return;

  const settings = await req.swell.settings();
  if (settings?.sync?.orders === false) return;

  const ctx: AppContext = { swell: req.swell, appId: req.appId, storeId: req.store.id };
  // Only customers who already have a Zoho contact (created with their first order).
  const link = await loadContactLink(ctx.swell, req.data.id);
  if (!link?.zoho_contact_id) return;

  const zoho = await createZohoClient(ctx);
  if (!zoho) return;
  const account: SwellAccount | null = await ctx.swell.get(`/accounts/${req.data.id}`);
  if (account) await updateContactFromAccount(ctx, zoho, link, account);
}
