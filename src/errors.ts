import type { AssistantMessage } from '@earendil-works/pi-ai';

// Only opaque transport failures are normalized. Deterministic failures keep
// their original words so Pi can compact, report quota, or stop retrying.
const GENERIC = /^(?:unknown(?:\s+error)?|unknown:\s*unknown(?:error)?|error|failed|stream\s+(?:error|failed)|no\s+error\s+details|operation\s+failed)(?:\s*[:(].*)?$/i;
const NON_RETRYABLE = [
  /context[_ ]length[_ ]exceeded/i,
  /context\s+window/i,
  /prompt\s+(?:is\s+)?too\s+long/i,
  /request\s+too\s+large/i,
  /maximum\s+(?:context|output|prompt)/i,
  /token\s+limit/i,
  /(?:^|\D)(?:401|402|403|404|413)(?:\D|$)/,
  /unauthori[sz]ed|forbidden|invalid\s+(?:api\s+)?key|authentication|permission\s+denied/i,
  /quota|billing|insufficient\s+(?:quota|balance|credit|funds)|(?:no|zero|low|available)\s+balance|credit\s+(?:exhausted|insufficient)|payment|spend|usage\s+limit/i,
];
const normalizedContext = 'context_length_exceeded: prompt is too long (gateway normalized an opaque upstream error)';

/**
 * Pi retries only errors it recognizes. Gateways behind a relay often collapse
 * a dropped SSE stream to "Unknown error" or an empty message, which Pi then
 * reports as a user-visible interruption without retrying. Normalize only that
 * opaque case; never rewrite a deterministic provider error.
 */
export function normalizeAssistantError(message: AssistantMessage, contextPercent: number | null | undefined): AssistantMessage | undefined {
  if (message.stopReason !== 'error') return undefined;
  const original = (message.errorMessage ?? '').trim();
  if (original && !GENERIC.test(original)) return undefined;
  if (NON_RETRYABLE.some(pattern => pattern.test(original))) return undefined;
  const errorMessage = contextPercent !== null && contextPercent !== undefined && contextPercent >= 90
    ? normalizedContext
    : `Upstream response stream was interrupted (no error details from upstream${original ? `: ${original}` : ''})`;
  return { ...message, errorMessage };
}
