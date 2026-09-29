// Zoho runs isolated data centers. An OAuth client is registered in one of
// them, so every accounts and API call must go to that DC's hosts.

export interface DataCenter {
  /** Zoho `location` code, as returned on the OAuth redirect */
  location: string;
  accountsServer: string;
  apiDomain: string;
  apiConsole: string;
}

export const DATA_CENTERS: readonly DataCenter[] = [
  { location: 'us', accountsServer: 'https://accounts.zoho.com', apiDomain: 'https://www.zohoapis.com', apiConsole: 'https://api-console.zoho.com' },
  { location: 'eu', accountsServer: 'https://accounts.zoho.eu', apiDomain: 'https://www.zohoapis.eu', apiConsole: 'https://api-console.zoho.eu' },
  { location: 'in', accountsServer: 'https://accounts.zoho.in', apiDomain: 'https://www.zohoapis.in', apiConsole: 'https://api-console.zoho.in' },
  { location: 'au', accountsServer: 'https://accounts.zoho.com.au', apiDomain: 'https://www.zohoapis.com.au', apiConsole: 'https://api-console.zoho.com.au' },
  { location: 'jp', accountsServer: 'https://accounts.zoho.jp', apiDomain: 'https://www.zohoapis.jp', apiConsole: 'https://api-console.zoho.jp' },
  { location: 'ca', accountsServer: 'https://accounts.zohocloud.ca', apiDomain: 'https://www.zohoapis.ca', apiConsole: 'https://api-console.zohocloud.ca' },
  { location: 'sa', accountsServer: 'https://accounts.zoho.sa', apiDomain: 'https://www.zohoapis.sa', apiConsole: 'https://api-console.zoho.sa' },
  { location: 'uk', accountsServer: 'https://accounts.zoho.uk', apiDomain: 'https://www.zohoapis.uk', apiConsole: 'https://api-console.zoho.uk' },
];

function normalizeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function dataCenterByLocation(location: string | undefined): DataCenter | undefined {
  return DATA_CENTERS.find((dc) => dc.location === location);
}

/**
 * Resolves an accounts server URL taken from an untrusted redirect. Only the
 * known Zoho hosts pass, so the client secret is never sent anywhere else.
 */
export function dataCenterByAccountsServer(url: string | undefined): DataCenter | undefined {
  const origin = url ? normalizeOrigin(url) : null;
  return DATA_CENTERS.find((dc) => dc.accountsServer === origin);
}

export function isKnownApiDomain(url: string | undefined): boolean {
  const origin = url ? normalizeOrigin(url) : null;
  return DATA_CENTERS.some((dc) => dc.apiDomain === origin);
}
