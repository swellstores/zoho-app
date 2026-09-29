import { vi } from "vitest";
import type { AppContext } from "../../functions/lib/swell-client";

export const APP_ID = "zoho";
export const STORE_ID = "swell-apps";
const COLLECTION = "/connections";

/**
 * In-memory stand-in for the app's `connections` collection plus settings,
 * shaped like the calls the connection code makes through the Swell client.
 */
export function createFakeSwell(options: {
  connection?: Record<string, any> | null;
  settings?: Record<string, any>;
  storeSettings?: Record<string, any>;
} = {}) {
  let record: Record<string, any> | null = options.connection ?? null;
  const settings = options.settings ?? {};

  const applyPatch = (patch: Record<string, any>) => {
    const next = { ...record };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && typeof value === "object" && "$set" in value ? value.$set : value;
    }
    record = next;
    return record;
  };

  const swell = {
    get: vi.fn(async (url: string, _query?: unknown) => {
      if (url === COLLECTION) return { results: record ? [record] : [] };
      if (url === "/settings/store") return { id: "store", ...options.storeSettings };
      throw new Error(`unexpected GET ${url}`);
    }),
    post: vi.fn(async (url: string, data: Record<string, any>) => {
      if (url !== COLLECTION) throw new Error(`unexpected POST ${url}`);
      record = { id: "conn_1", ...data };
      return record;
    }),
    put: vi.fn(async (url: string, patch: Record<string, any>) => {
      if (!record || url !== `${COLLECTION}/${record.id}`) throw new Error(`unexpected PUT ${url}`);
      return applyPatch(patch);
    }),
    delete: vi.fn(async (url: string) => {
      throw new Error(`unexpected DELETE ${url}`);
    }),
    settings: vi.fn(async () => settings),
  };

  const ctx: AppContext = { swell, appId: APP_ID, storeId: STORE_ID };
  return { swell, ctx, current: () => record };
}

export const CONFIGURED_SETTINGS = {
  connection: { data_center: "eu", client_id: "1000.CLIENT", client_secret: "shh" },
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
