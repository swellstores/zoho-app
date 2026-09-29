import { dataCenterByLocation, type DataCenter } from '../zoho/data-centers';
import type { SwellClient } from '../swell-client';
import type { ClientCredentials } from '../zoho/oauth';

export interface ConnectionSettings extends ClientCredentials {
  dataCenter: DataCenter;
}

/** The data center chosen in settings/connection.json, even before credentials are entered. */
export function selectedDataCenter(settings: Record<string, any> | null | undefined): DataCenter {
  return dataCenterByLocation(settings?.connection?.data_center || 'us') ?? dataCenterByLocation('us')!;
}

/** settings/connection.json as credentials; null until the merchant has filled it in. */
export function connectionSettingsFrom(settings: Record<string, any> | null | undefined): ConnectionSettings | null {
  const group = settings?.connection ?? {};
  const clientId = String(group.client_id ?? '').trim();
  const clientSecret = String(group.client_secret ?? '').trim();
  const dataCenter = dataCenterByLocation(group.data_center || 'us');
  if (!clientId || !clientSecret || !dataCenter) return null;
  return { clientId, clientSecret, dataCenter };
}

/** Reads settings/connection.json; null until the merchant has filled it in. */
export async function readConnectionSettings(swell: SwellClient): Promise<ConnectionSettings | null> {
  return connectionSettingsFrom(await swell.settings());
}
