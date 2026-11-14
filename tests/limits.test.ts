import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { buildModels, fromRow } from '../src/metadata.ts';
import { modelDetails } from '../src/model-info.ts';
import { metadataOnly, parseRegistry } from '../src/storage.ts';
import type { Connection, Discovery } from '../src/types.ts';

const connection: Connection = { id: 'relay', name: 'Relay' };
const row = { id: 'deepseek-v4.1-flash-1017', context_length: 1_048_576, max_output_tokens: 384_000, native_endpoints: ['/v1/chat/completions'] };
const discovery: Discovery = { rows: [row], protocols: { [row.id]: ['openai-completions'] }, evidence: { [row.id]: 'endpoint' }, probes: [] };

test('default gateway policy caps context and output at the Codex price boundary', () => {
  const [model] = buildModels(connection, 'https://example.test', discovery);
  assert.equal(model.contextWindow, 272_000);
  assert.equal(model.maxTokens, 65_536);
  assert.deepEqual(model.gateway.limits, {
    contextWindow: { raw: 1_048_576, effective: 272_000, cap: 272_000 },
    maxTokens: { raw: 272_000, effective: 65_536, cap: 65_536 },
  });
  assert(model.gateway.warnings.some(w => w.includes('272,000')));
  assert(model.gateway.warnings.some(w => w.includes('65,536')));
  const details = modelDetails(model, model, connection, { providers: {} });
  assert.match(details, /上下文上限：1,048,576 → 272,000（cap 272,000）.*gateway policy/);
  assert.match(details, /输出上限：272,000 → 65,536（cap 65,536）.*gateway policy/);
});

test('policy and per-connection limits are explicit, validated and can be disabled', () => {
  const [raw] = buildModels({ ...connection, limits: { contextWindowCap: null, maxTokensCap: null } }, 'https://example.test', discovery);
  assert.equal(raw.contextWindow, 1_048_576); assert.equal(raw.maxTokens, 384_000); assert.equal(raw.gateway.limits, undefined);
  const [custom] = buildModels(connection, 'https://example.test', discovery, {}, { contextWindowCap: 300_000, maxTokensCap: null });
  assert.equal(custom.contextWindow, 300_000); assert.equal(custom.maxTokens, 300_000);
  const [perService] = buildModels({ ...connection, limits: { contextWindowCap: 200_000 } }, 'https://example.test', discovery, {}, { contextWindowCap: 300_000 });
  assert.equal(perService.contextWindow, 200_000);
  const small = { ...row, id: 'small', context_length: 128_000, max_output_tokens: 16_384 };
  const [unchanged] = buildModels(connection, 'https://example.test', { ...discovery, rows: [small], protocols: { small: ['openai-completions'] } });
  assert.equal(unchanged.contextWindow, 128_000); assert.equal(unchanged.maxTokens, 16_384); assert.equal(unchanged.gateway.limits, undefined);
});

test('endpoint reasoning_options keep the toggle through cache and metadata mapping', () => {
  const options = [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }];
  const preserved = metadataOnly({ id: 'reasoner', reasoning_options: options });
  assert.deepEqual(preserved.reasoning_options, options);
  const meta = fromRow({ id: 'reasoner', reasoning: true, reasoning_options: options });
  assert.equal(meta.thinkingLevelMap?.off, undefined);
  assert.deepEqual(meta.thinkingLevelMap, { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
  const [model] = buildModels(connection, 'https://example.test', { ...discovery, rows: [{ id: 'reasoner', reasoning: true, reasoning_options: options }], protocols: { reasoner: ['openai-completions'] } });
  assert.deepEqual(getSupportedThinkingLevels(model), ['off', 'low', 'high', 'max']);
});

test('registry policy and service limits are parsed without weakening existing validation', () => {
  const parsed = parseRegistry({ version: 1, policy: { contextWindowCap: 300_000, maxTokensCap: null }, connections: [{ id: 'relay', name: 'Relay', limits: { maxTokensCap: 20_000 } }] });
  assert.deepEqual(parsed.policy, { contextWindowCap: 300_000, maxTokensCap: null });
  assert.deepEqual(parsed.connections[0].limits, { maxTokensCap: 20_000 });
  for (const value of [
    { version: 1, policy: { contextWindowCap: 0 }, connections: [] },
    { version: 1, policy: { contextWindowCap: -1 }, connections: [] },
    { version: 1, policy: { unknown: 1 }, connections: [] },
    { version: 1, connections: [{ id: 'relay', name: 'Relay', limits: { maxTokensCap: 1.5 } }] },
  ]) assert.throws(() => parseRegistry(value));
});
