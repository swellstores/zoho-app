export const WEBHOOK_TOPICS = ['shipments', 'stock'] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export function isWebhookTopic(value: unknown): value is WebhookTopic {
  return (WEBHOOK_TOPICS as readonly unknown[]).includes(value);
}

function parseMaybeJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// Form keys Zoho's docs use for the whole record as JSON (`payload=${JSONString}`).
const WRAPPER_KEYS = ['payload', 'JSONString'];

/**
 * A Zoho workflow webhook body: JSON (the Default Payload), or form data
 * whose values may hold JSON. Always returns an object.
 */
export function parseWebhookBody(body: string): Record<string, any> {
  const json = parseMaybeJson(body);
  if (json && typeof json === 'object' && !Array.isArray(json)) return json as Record<string, any>;

  const result: Record<string, any> = {};
  new URLSearchParams(body).forEach((value, key) => {
    const parsed = parseMaybeJson(value);
    if (WRAPPER_KEYS.includes(key) && parsed && typeof parsed === 'object') Object.assign(result, parsed);
    else result[key] = parsed;
  });
  return result;
}

/** The Zoho module a record came from: the top-level key holding the record, e.g. `inventory_adjustment`. */
export function sourceModule(payload: Record<string, any>): string | null {
  for (const [key, value] of Object.entries(payload)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).some((field) => field.endsWith('_id'))) return key;
    }
  }
  return null;
}

/** The record itself: the value under the module key, or the payload when it is flat. */
export function recordOf(payload: Record<string, any>): Record<string, any> {
  const module = sourceModule(payload);
  return module ? payload[module] : payload;
}

/** Every Zoho item id mentioned in the record's line items, at any depth. */
export function itemIdsIn(payload: unknown): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record.item_id !== undefined && record.item_id !== null && record.item_id !== '') ids.add(String(record.item_id));
      Object.values(record).forEach(walk);
    }
  };
  walk(payload);
  return [...ids];
}
