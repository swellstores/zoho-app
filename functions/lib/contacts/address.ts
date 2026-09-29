export interface SwellAddress {
  name?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
}

export interface ZohoAddress {
  attention?: string;
  address?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
}

function fullName(address: SwellAddress): string | undefined {
  const joined = [address.first_name, address.last_name].filter(Boolean).join(' ');
  return address.name || joined || undefined;
}

export function toZohoAddress(address: SwellAddress | null | undefined): ZohoAddress | undefined {
  if (!address || !(address.address1 || address.city || address.zip || address.country)) return undefined;
  const result: ZohoAddress = {
    attention: fullName(address),
    address: address.address1,
    street2: address.address2,
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country,
    phone: address.phone,
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value)) as ZohoAddress;
}

/** Stable key for "is this the same address", ignoring case and spacing. */
export function addressFingerprint(address: ZohoAddress): string {
  return (['attention', 'address', 'street2', 'city', 'state', 'zip', 'country'] as const)
    .map((key) => (address[key] ?? '').toString().trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}
