import { AppError, type AppContext } from './lib/swell-client';
import { TOKEN_HEADER, TOPIC_HEADER } from './lib/webhooks/endpoint';
import { isWebhookTopic } from './lib/webhooks/payload';
import { receiveWebhook } from './lib/webhooks/receive';

export const config: SwellConfig = {
  description: 'Receive Zoho workflow webhooks for shipments and stock',
  route: {
    public: true,
    methods: ['post'],
    // The public key in Authorization is for the store gateway; the function needs only these.
    headers: ['content-type', 'x-swell-topic', 'x-swell-token'],
  },
};

// Enough for any single Zoho record; a runaway body is refused before it is stored.
const MAX_BODY = 1_000_000;

/**
 * Zoho workflow rules post here through the store gateway (see
 * lib/webhooks/endpoint). The per-store token in X-Swell-Token is what
 * authorizes the call; the body is stored and processed by the webhook-event
 * function, so Zoho gets its answer at once.
 */
export default async function (req: SwellRequest) {
  const topic = req.headers.get(TOPIC_HEADER);
  if (!isWebhookTopic(topic)) throw new SwellError('Unknown webhook', { status: 404 });
  const body = typeof req.rawBody === 'string' ? req.rawBody : '';
  if (body.length > MAX_BODY) throw new SwellError('The webhook body is too large', { status: 413 });

  const ctx: AppContext = { swell: req.swell, appId: req.appId, storeId: req.store.id, publicKey: req.publicKey };
  try {
    const result = await receiveWebhook(ctx, topic, req.headers.get(TOKEN_HEADER) ?? undefined, body, req.headers.get('content-type') ?? undefined);
    console.log(JSON.stringify({ webhook: topic, source: result.source, check: result.check }));
  } catch (error) {
    if (error instanceof AppError) throw new SwellError(error.message, { status: error.status });
    throw error;
  }
  return { ok: true };
}
