export interface ZohoOrganization {
  organization_id: string;
  name: string;
  books: boolean;
  inventory: boolean;
  /** Currency the organization keeps its books in, e.g. PLN */
  currency_code?: string;
}

export type ZohoProduct = 'books' | 'inventory';

/** Why a product's organization list could not be read. */
export interface OrganizationLookupProblem {
  product: ZohoProduct;
  status: number;
  code?: number | string;
  message: string;
}

const PRODUCT_PATHS: Record<ZohoProduct, string> = {
  books: '/books/v3/organizations',
  inventory: '/inventory/v1/organizations',
};

async function fetchOrganizations(
  apiDomain: string,
  product: ZohoProduct,
  accessToken: string,
): Promise<{ organizations: Array<{ organization_id: string; name: string; currency_code?: string }> } | { problem: OrganizationLookupProblem }> {
  let response: Response;
  try {
    response = await fetch(`${apiDomain}${PRODUCT_PATHS[product]}`, {
      headers: { authorization: `Zoho-oauthtoken ${accessToken}` },
    });
  } catch (error) {
    return { problem: { product, status: 0, message: (error as Error).message } };
  }
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // reported below
  }
  if (!response.ok || body?.code !== 0 || !Array.isArray(body?.organizations)) {
    return {
      problem: {
        product,
        status: response.status,
        code: body?.code,
        message: String(body?.message ?? text.slice(0, 200) ?? 'no response body'),
      },
    };
  }
  return { organizations: body.organizations };
}

/**
 * Lists the organizations the connected user can reach, flagging which
 * products each one has. A product whose list cannot be read counts as
 * absent; the reason is returned so it can be shown to the merchant.
 */
export async function listOrganizations(
  apiDomain: string,
  accessToken: string,
): Promise<{ organizations: ZohoOrganization[]; problems: OrganizationLookupProblem[] }> {
  const products: ZohoProduct[] = ['books', 'inventory'];
  const results = await Promise.all(products.map((p) => fetchOrganizations(apiDomain, p, accessToken)));

  const byId = new Map<string, ZohoOrganization>();
  const problems: OrganizationLookupProblem[] = [];
  results.forEach((result, i) => {
    const product = products[i];
    if ('problem' in result) {
      problems.push(result.problem);
      return;
    }
    for (const org of result.organizations) {
      const id = String(org.organization_id);
      const entry = byId.get(id) ?? {
        organization_id: id,
        name: org.name,
        books: false,
        inventory: false,
        ...(org.currency_code ? { currency_code: org.currency_code } : {}),
      };
      entry[product] = true;
      byId.set(id, entry);
    }
  });

  return { organizations: [...byId.values()], problems };
}

const PRODUCT_NAMES: Record<ZohoProduct, string> = { books: 'Zoho Books', inventory: 'Zoho Inventory' };

export function describeProblems(problems: OrganizationLookupProblem[]): string {
  return problems
    .map((p) => `${PRODUCT_NAMES[p.product]}: ${p.message}${p.code !== undefined ? ` (code ${p.code})` : ''}`)
    .join('; ');
}
