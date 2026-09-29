import type { Connection } from '../connection/store';
import type { ZohoApi } from './client';

/**
 * Link to a record in the Zoho web app of the connection's data center,
 * e.g. https://inventory.zoho.eu/app/<org>#/salesorders/<id>.
 */
export function zohoWebUrl(connection: Connection, api: ZohoApi, module: string, id: string): string | null {
  if (!connection.accounts_server || !connection.organization_id) return null;
  const host = new URL(connection.accounts_server).host.replace(/^accounts\./, `${api}.`);
  return `https://${host}/app/${connection.organization_id}#/${module}/${id}`;
}
