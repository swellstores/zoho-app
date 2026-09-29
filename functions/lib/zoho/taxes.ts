import { AppError } from '../swell-client';
import type { ZohoClient } from './client';

export interface ZohoTax {
  tax_id: string;
  tax_name: string;
  tax_percentage: number;
  tax_type?: string;
  is_default_tax?: boolean;
}

export async function listTaxes(zoho: ZohoClient): Promise<ZohoTax[]> {
  const body = await zoho.request(zoho.itemsApi, 'GET', '/settings/taxes', { query: { per_page: 200 } });
  return body?.taxes ?? [];
}

/**
 * The Zoho tax whose percentage equals `rate`. Simple taxes win over
 * compound ones, then the organization's default.
 */
export function taxForRate(taxes: ZohoTax[], rate: number): ZohoTax {
  const matches = taxes
    .filter((tax) => Math.abs(Number(tax.tax_percentage) - rate) < 0.0001)
    .sort(
      (a, b) =>
        Number(b.tax_type !== 'compound_tax') - Number(a.tax_type !== 'compound_tax') ||
        Number(Boolean(b.is_default_tax)) - Number(Boolean(a.is_default_tax)),
    );
  if (!matches.length) {
    throw new AppError('missing_tax', `Zoho has no tax with a rate of ${rate}%. Create one in Zoho, then retry the order.`);
  }
  return matches[0];
}
