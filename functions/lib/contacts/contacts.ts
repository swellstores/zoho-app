import type { AppContext, SwellClient } from '../swell-client';
import type { ZohoClient } from '../zoho/client';
import { addressFingerprint, toZohoAddress, type SwellAddress, type ZohoAddress } from './address';

export interface SwellAccount {
  id: string;
  email: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  billing?: SwellAddress;
  shipping?: SwellAddress;
}

export interface ContactLink {
  id: string;
  account_id: string;
  email?: string;
  zoho_contact_id?: string | null;
  addresses?: Array<{ fingerprint: string; address_id: string }>;
  status?: 'synced' | 'error';
  error?: string | null;
}

// Bare name: this app's collection, no permission needed.
const COLLECTION = '/contact-links';

export async function loadContactLink(swell: SwellClient, accountId: string): Promise<ContactLink | undefined> {
  const list = await swell.get(COLLECTION, { where: { account_id: accountId }, limit: 1 });
  return list?.results?.[0];
}

async function saveContactLink(
  swell: SwellClient,
  existing: ContactLink | undefined,
  data: Omit<Partial<ContactLink>, 'id' | 'addresses'> & { addresses?: unknown },
): Promise<ContactLink> {
  const record = { ...data, date_synced: new Date().toISOString() };
  return existing ? swell.put(`${COLLECTION}/${existing.id}`, record) : swell.post(COLLECTION, record);
}

function nameOf(account: SwellAccount, fallback?: SwellAddress): string {
  const joined = [account.first_name, account.last_name].filter(Boolean).join(' ');
  const fromAddress = fallback && [fallback.first_name, fallback.last_name].filter(Boolean).join(' ');
  return account.name || joined || fallback?.name || fromAddress || account.email;
}

function contactPerson(account: SwellAccount) {
  return {
    first_name: account.first_name || account.name || '',
    last_name: account.last_name || '',
    email: account.email,
    ...(account.phone ? { phone: account.phone } : {}),
  };
}

async function findContactByEmail(zoho: ZohoClient, email: string): Promise<Record<string, any> | null> {
  const body = await zoho.request(zoho.itemsApi, 'GET', '/contacts', { query: { email } });
  const wanted = email.trim().toLowerCase();
  const matches = (body?.contacts ?? []).filter(
    (contact: Record<string, any>) => String(contact.email ?? '').trim().toLowerCase() === wanted,
  );
  return matches[0] ?? null;
}

/**
 * The Zoho contact for a customer: already linked, found by email (linked
 * without changes), or created from the customer and this order's addresses.
 */
export async function ensureContact(
  ctx: AppContext,
  zoho: ZohoClient,
  account: SwellAccount,
  addresses: { billing?: SwellAddress; shipping?: SwellAddress },
): Promise<ContactLink> {
  const link = await loadContactLink(ctx.swell, account.id);
  if (link?.zoho_contact_id) return link;

  const existing = await findContactByEmail(zoho, account.email);
  if (existing) {
    return saveContactLink(ctx.swell, link, {
      account_id: account.id,
      email: account.email,
      zoho_contact_id: String(existing.contact_id),
      status: 'synced',
      error: null,
    });
  }

  const billing = toZohoAddress(addresses.billing ?? account.billing);
  const shipping = toZohoAddress(addresses.shipping ?? account.shipping);
  const created = await zoho.request(zoho.itemsApi, 'POST', '/contacts', {
    body: {
      contact_name: nameOf(account, addresses.billing),
      contact_type: 'customer',
      ...(addresses.billing?.company ? { company_name: addresses.billing.company } : {}),
      ...(billing ? { billing_address: billing } : {}),
      ...(shipping ? { shipping_address: shipping } : {}),
      contact_persons: [{ ...contactPerson(account), is_primary_contact: true }],
    },
  });
  const contact = created?.contact ?? {};
  const shippingId = contact.shipping_address?.address_id;
  return saveContactLink(ctx.swell, link, {
    account_id: account.id,
    email: account.email,
    zoho_contact_id: String(contact.contact_id),
    addresses: shipping && shippingId ? { $set: [{ fingerprint: addressFingerprint(shipping), address_id: String(shippingId) }] } : undefined,
    status: 'synced',
    error: null,
  });
}

/**
 * Id of the order's shipping address on the Zoho contact, adding it as an
 * extra address the first time it is used.
 */
export async function shippingAddressId(
  ctx: AppContext,
  zoho: ZohoClient,
  link: ContactLink,
  address: ZohoAddress | undefined,
): Promise<string | undefined> {
  if (!address || !link.zoho_contact_id) return undefined;
  const fingerprint = addressFingerprint(address);
  const known = link.addresses?.find((entry) => entry.fingerprint === fingerprint);
  if (known) return known.address_id;

  const body = await zoho.request(zoho.itemsApi, 'POST', `/contacts/${link.zoho_contact_id}/address`, { body: address });
  const addressId = body?.address_info?.address_id ?? body?.address?.address_id ?? body?.address_id;
  if (!addressId) return undefined;
  const addresses = [...(link.addresses ?? []), { fingerprint, address_id: String(addressId) }];
  await saveContactLink(ctx.swell, link, { addresses: { $set: addresses } });
  link.addresses = addresses;
  return String(addressId);
}

/** Sends a customer's name, email, phone and default addresses to the linked Zoho contact. */
export async function updateContactFromAccount(
  ctx: AppContext,
  zoho: ZohoClient,
  link: ContactLink,
  account: SwellAccount,
): Promise<void> {
  const current = await zoho.request(zoho.itemsApi, 'GET', `/contacts/${link.zoho_contact_id}`);
  const primary = (current?.contact?.contact_persons ?? []).find((p: Record<string, any>) => p.is_primary_contact);
  const billing = toZohoAddress(account.billing);
  const shipping = toZohoAddress(account.shipping);
  await zoho.request(zoho.itemsApi, 'PUT', `/contacts/${link.zoho_contact_id}`, {
    body: {
      contact_name: nameOf(account),
      ...(billing ? { billing_address: billing } : {}),
      ...(shipping ? { shipping_address: shipping } : {}),
      contact_persons: [
        {
          ...(primary?.contact_person_id ? { contact_person_id: primary.contact_person_id } : {}),
          ...contactPerson(account),
          is_primary_contact: true,
        },
      ],
    },
  });
  await saveContactLink(ctx.swell, link, { email: account.email, status: 'synced', error: null });
}
