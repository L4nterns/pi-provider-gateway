import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { normalizeAssistantError } from '../src/errors.ts';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function message(errorMessage: string | undefined, stopReason: AssistantMessage['stopReason'] = 'error'): AssistantMessage {
  return { role: 'assistant', provider: 'relay', model: 'model', api: 'openai-completions', timestamp: Date.now(), content: [], stopReason, usage, ...(errorMessage === undefined ? {} : { errorMessage }) };
}

test('opaque gateway stream failures become retryable without inventing another error', () => {
  for (const text of ['Unknown error', 'unknown error', 'Unknown: UnknownError', 'Unknown error: socket closed', '', 'failed', 'stream error']) {
    const result = normalizeAssistantError(message(text), 10);
    assert(result, text);
    assert.match(result.errorMessage!, /stream was interrupted/i);
    if (text) assert(result.errorMessage!.includes(text));
  }
});

test('opaque failures near the context limit become compaction signals instead of retries', () => {
  const result = normalizeAssistantError(message('Unknown error'), 90);
  assert.equal(result?.errorMessage, 'context_length_exceeded: prompt is too long (gateway normalized an opaque upstream error)');
  assert.equal(normalizeAssistantError(message('Unknown error'), 89)?.errorMessage?.startsWith('Upstream response stream was interrupted'), true);
});

test('deterministic failures, explicit retryable failures and aborts keep their original semantics', () => {
  for (const text of [
    '401 Unauthorized', 'Unknown error: 401', '403 forbidden', '413 request too large', 'prompt is too long: 300000 tokens > 272000 maximum',
    'insufficient_quota', 'billing hard limit reached', 'invalid api key', 'context_length_exceeded',
  ]) assert.equal(normalizeAssistantError(message(text), 10), undefined, text);
  assert.equal(normalizeAssistantError(message('429 rate limit'), 10), undefined);
  assert.equal(normalizeAssistantError(message('Unknown error', 'aborted'), 10), undefined);
  assert.equal(normalizeAssistantError(message('stream was interrupted'), 10), undefined);
});
