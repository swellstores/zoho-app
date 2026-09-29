import type { AppContext } from '../swell-client';
import { ZohoRateLimitError, type ZohoClient } from '../zoho/client';
import { stateOf } from './state';
import { OrderBusyError, OrderContinueError, syncOrder } from './sync';

// Chained runs that stopped at their budget. Past this the order is left to
// the retry job, so a run that makes no progress cannot chain forever.
export const MAX_CONTINUATIONS = 6;

/** An order a run stopped at its time budget and that no run holds now. */
export function awaitsContinuation(order: Record<string, any> | null | undefined, appId: string): boolean {
  if (!order?.id || order.draft) return false;
  const state = stateOf(order, appId);
  const chained = state.zoho_continuations ?? 0;
  return state.zoho_status === 'pending' && !state.zoho_claimed_at && chained > 0 && chained <= MAX_CONTINUATIONS;
}

/**
 * Runs the next step of an order that stopped at its time budget. The
 * platform's own redelivery backs off to about 12 minutes after the second
 * try, so the next run starts from the order update that saved the progress.
 * Nothing is thrown: the retry job picks up whatever this leaves.
 */
export async function continueOrder(ctx: AppContext, zoho: ZohoClient, orderId: string): Promise<void> {
  try {
    await syncOrder(ctx, zoho, orderId);
  } catch (error) {
    if (error instanceof OrderContinueError || error instanceof OrderBusyError || error instanceof ZohoRateLimitError) return;
    throw error;
  }
}
