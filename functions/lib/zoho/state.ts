// OAuth `state` = "<store id>.<nonce>". The nonce is stored on the connection
// record and accepted once, before it expires.

export const STATE_TTL_MS = 10 * 60 * 1000;

export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildState(storeId: string, nonce: string): string {
  return `${storeId}.${nonce}`;
}

export function parseState(state: string | undefined): { storeId: string; nonce: string } | null {
  if (!state) return null;
  const dot = state.lastIndexOf('.');
  if (dot <= 0 || dot === state.length - 1) return null;
  return { storeId: state.slice(0, dot), nonce: state.slice(dot + 1) };
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
