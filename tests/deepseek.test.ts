import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryModelsStore, getSupportedThinkingLevels, type Context, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { buildModels, builtinMetadata } from '../src/metadata.ts';
import { selectProtocol, fingerprint } from '../src/discovery.ts';
import { createGateway } from '../src/provider.ts';
import { Store, atomicJson } from '../src/storage.ts';
import type { Discovery } from '../src/types.ts';

const root = 'https://custom-gateway.example.test';
const connection = { id: 'custom-deepseek', name: 'Custom DeepSeek', url: root };
const id = 'deepseek-flash';
const discovery: Discovery = { rows: [{ id }], protocols: { [id]: ['openai-completions'] }, evidence: { [id]: 'endpoint' }, probes: [] };

test('custom DeepSeek prefers declared Chat and supplies only its supported wire dialect, without changing capabilities', () => {
  assert.equal(selectProtocol(id, ['openai-responses', 'openai-completions']), 'openai-completions');
  assert.equal(selectProtocol(id, ['openai-responses']), 'openai-responses', 'preference is not support evidence');
  assert.equal(selectProtocol(id, ['openai-completions'], 'openai-responses'), 'openai-responses', 'explicit protocol remains authoritative');
  const [explicit] = buildModels({ ...connection, protocol: 'openai-responses' }, root, discovery);
  assert.equal(explicit.api, 'openai-responses'); assert.deepEqual(explicit.gateway.protocols, ['openai-completions']);
  assert.equal(explicit.gateway.protocolEvidence, 'user', 'preference does not become support evidence');
  const [unproven] = buildModels({ ...connection, protocol: 'openai-completions' }, root, { ...discovery, protocols: {}, evidence: {} });
  assert.deepEqual(unproven.gateway.protocols, [], 'explicit selection cannot manufacture support evidence');
  const [m] = buildModels(connection, root, discovery);
  assert.equal(m.reasoning, true); assert.equal(m.contextWindow, 272000); assert.equal(m.maxTokens, 65536);
  assert.deepEqual(m.gateway.limits, { contextWindow: { raw: 1000000, effective: 272000, cap: 272000 }, maxTokens: { raw: 272000, effective: 65536, cap: 65536 } });
  assert(getSupportedThinkingLevels(m).includes('max'));
  assert.deepEqual(m.compat, { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true });
  assert.equal((m.compat as any).supportsStrictMode, undefined, 'do not inherit the entire first-party policy');
  const [other] = buildModels(connection, root, { ...discovery, rows: [{ id: 'unrelated-model', reasoning: true }], protocols: { 'unrelated-model': ['openai-completions'] } });
  assert.equal((other.compat as any).thinkingFormat, undefined);
  assert.equal((other.compat as any).supportsDeveloperRole, false);
});

const catalog = { deepseek: { models: { 'deepseek-flash': { name: 'DeepSeek V4.1 Flash 1017', reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }], limit: { context: 1048576, output: 393216 }, modalities: { input: ['text', 'image'], output: ['text'] }, cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } } };

test('reseller namespaces cannot become first-party catalog keys', () => {
  assert.equal(builtinMetadata('deepseek-r1-0528'), undefined, 'a namespaced reseller listing is not a first-party exact match');
  assert.equal(builtinMetadata('deepseek-v3.2'), undefined, 'conflicting exact deployments remain ambiguous');
});

test('DeepSeek version IDs use the exact first-party reference, never a namespaced reseller key collision', () => {
  for (const version of ['deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash']) {
    const [model] = buildModels(connection, root, { ...discovery, rows: [{ id: version }], protocols: { [version]: ['openai-completions'] } });
    const [canonical] = buildModels(connection, root, discovery);
    assert.equal(model.gateway.source.maxTokens, 'pi:deepseek');
    assert.equal(model.maxTokens, canonical.maxTokens); assert(model.maxTokens <= 393216);
    assert.equal(model.contextWindow, canonical.contextWindow); assert.deepEqual(model.input, ['text', 'image']);
    assert(getSupportedThinkingLevels(model).includes('max'));
  }
});

test('dated DeepSeek snapshots resolve only while the vendor names that exact version', () => {
  for (const version of ['deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash-1017']) {
    const [model] = buildModels(connection, root, { ...discovery, rows: [{ id: version }], protocols: { [version]: ['openai-completions'] } }, catalog);
    assert.equal(model.id, version, 'reference metadata never rewrites the requested ID');
    assert.equal(model.contextWindow, 272000); assert.equal(model.maxTokens, 65536);
    assert.equal(model.reasoning, true); assert.deepEqual(model.input, ['text', 'image']);
    assert.deepEqual(model.thinkingLevelMap, { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
    assert.equal(model.gateway.source.contextWindow, 'models.dev:deepseek');
    assert.equal((model.compat as any).supportsReasoningEffort, true);
    assert(getSupportedThinkingLevels(model).join() === 'off,low,high,max', 'toggle keeps off and exposes low/high/max');
  }
  // A snapshot the vendor does not name must not inherit the current limits.
  const unknown = 'deepseek-v4.1-flash-1102';
  const [fallback] = buildModels(connection, root, { ...discovery, rows: [{ id: unknown }], protocols: { [unknown]: ['openai-completions'] } }, catalog);
  assert.equal(fallback.contextWindow, 128000); assert.equal(fallback.maxTokens, 16384); assert.equal(fallback.reasoning, false);
  assert.equal(fallback.gateway.source.contextWindow, 'unverified-default');
});

test('native Pi sends system instructions, DeepSeek thinking and complete reasoning replay through a custom URL; user compat still wins', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-deepseek-wire-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir), key = 'fake-deepseek-wire-key';
  await store.put(connection, null);
  await atomicJson(join(dir, 'auth.json'), { [connection.id]: { type: 'api_key', key, env: { PI_GATEWAY_URL: root } } });
  const versions = { ...discovery, rows: [{ id }, { id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4.1-flash-1017' }], protocols: { ...discovery.protocols, 'deepseek-v4.1-flash': ['openai-completions' as const], 'deepseek-v4.1-flash-1017': ['openai-completions' as const] } };
  await store.save(connection.id, { version: 1, fingerprint: fingerprint(root, key), checkedAt: Date.now(), discovery: versions });
  await atomicJson(join(dir, 'cache', 'gateway', 'models-dev.json'), { checkedAt: Date.now(), data: catalog });
  const handle = createGateway(connection, store); t.after(() => handle.dispose()); await handle.initialize(AbortSignal.timeout(10000), false);
  const modelPath = join(dir, 'models.json');
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: modelPath, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(handle.provider); await runtime.refresh({ providers: [connection.id], allowNetwork: false });
  const m = runtime.getModel(connection.id, id)!;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant: AssistantMessage = { role: 'assistant', provider: connection.id, model: id, api: 'openai-completions', timestamp: Date.now(), content: [{ type: 'toolCall', id: 'call_test', name: 'echo', arguments: { value: 'OK' } }], stopReason: 'toolUse', usage };
  const context: Context = { messages: [
    { role: 'system', content: 'Follow the test instructions.', toolsAdded: [{ name: 'echo', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } } } }], timestamp: Date.now() },
    { role: 'user', content: 'Echo OK.', timestamp: Date.now() }, assistant,
    { role: 'toolResult', toolCallId: 'call_test', toolName: 'echo', content: [{ type: 'text', text: 'OK' }], isError: false, timestamp: Date.now() },
  ] };
  const level = (reasoning: 'off' | 'low' | 'max') => reasoning === 'off' ? undefined : reasoning;
  async function payload(model: typeof m, reasoning: 'off' | 'low' | 'max') {
    const controller = new AbortController(); let sent: any;
    const result = await runtime.completeSimple(model, context, { reasoning: level(reasoning), signal: controller.signal, onPayload(p) { sent = p; controller.abort(); } });
    assert(sent); assert(['aborted', 'error'].includes(result.stopReason)); return sent;
  }
  for (const selected of [m, runtime.getModel(connection.id, 'deepseek-v4.1-flash')!, runtime.getModel(connection.id, 'deepseek-v4.1-flash-1017')!]) for (const level of ['low', 'max'] as const) {
    const p = await payload(selected, level);
    assert.equal(p.model, selected.id, 'reference metadata never changes the requested ID');
    assert.equal(p.messages[0].role, 'system'); assert(!p.messages.some((message: any) => message.role === 'developer'));
    assert.deepEqual(p.thinking, { type: 'enabled' }); assert.equal(p.reasoning_effort, level);
    assert.equal(p.messages.find((message: any) => message.role === 'assistant').reasoning_content, '');
    assert.equal(p.messages.at(-1).role, 'tool'); assert(p.tools.some((tool: any) => tool.function.name === 'echo'));
    assert.equal(p.store, undefined); assert.equal(p.max_completion_tokens, undefined); assert.equal(p.max_tokens, selected.maxTokens); assert(p.max_tokens <= 65536);
  }
  const dated = runtime.getModel(connection.id, 'deepseek-v4.1-flash-1017')!;
  assert.equal(dated.maxTokens, 65536, 'gateway policy caps output unless the user explicitly overrides it');
  const disabled = await payload(dated, 'off');
  assert.deepEqual(disabled.thinking, { type: 'disabled' });
  assert.equal(disabled.reasoning_effort, undefined);
  await atomicJson(modelPath, { providers: { [connection.id]: { modelOverrides: { [id]: { compat: { supportsDeveloperRole: true, supportsStore: true, thinkingFormat: 'openai' } } } } } });
  await runtime.refresh({ providers: [connection.id], allowNetwork: false });
  const overridden = await payload(runtime.getModel(connection.id, id)!, 'low');
  assert.equal(overridden.messages[0].role, 'developer'); assert.equal(overridden.store, false); assert.equal(overridden.thinking, undefined);
});
