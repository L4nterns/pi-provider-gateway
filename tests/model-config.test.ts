import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, atomicJson } from '../src/storage.ts';
import { editableOverride, modelFile, saveOverrides, validateOverrides } from '../src/model-config.ts';
import { modelDetails } from '../src/model-info.ts';
import { buildModels } from '../src/metadata.ts';

const id = 'unverified-test-model';
const connection = { id: 'service', name: 'service' };
const base = () => buildModels(connection, 'https://example.test', { rows: [{ id }], protocols: { [id]: ['openai-responses'] }, evidence: { [id]: 'endpoint' }, probes: [] })[0];

test('model parameter editing uses native validation, preserves unrelated fields and rejects stale writes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-model-file-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir), path = join(dir, 'models.json');
  const original = { $schema: 'https://pi.dev/schemas/models.schema.json', providers: {
    service: { headers: { 'x-secret': 'FAKE-PRIVATE-HEADER' }, modelOverrides: { [id]: { contextWindow: 100, compat: { supportsExplicitPromptCacheMode: false }, headers: { 'x-model-secret': 'FAKE-MODEL-HEADER' } }, other: { maxTokens: 4000 } } },
    other: { baseUrl: 'https://example.test', models: [{ id: 'other', api: 'openai-completions' }], apiKey: 'FAKE-OTHER-CREDENTIAL' },
  } };
  await atomicJson(path, original);
  const before = await modelFile(store);
  const editable = editableOverride((original.providers.service.modelOverrides as any)[id]);
  assert.deepEqual(editable, { contextWindow: 100, compat: { supportsExplicitPromptCacheMode: false } });
  assert(!JSON.stringify(editable).includes('HEADER'));
  const replacement = await validateOverrides({ contextWindow: 272000, input: ['text', 'image'], reasoning: true, thinkingLevelMap: { max: 'max' }, compat: { supportsExplicitPromptCacheMode: false } });
  await saveOverrides(store, 'service', id, before.raw, replacement);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.providers.other, original.providers.other);
  assert.deepEqual(saved.providers.service.headers, original.providers.service.headers);
  assert.deepEqual(saved.providers.service.modelOverrides.other, original.providers.service.modelOverrides.other);
  assert.deepEqual(saved.providers.service.modelOverrides[id], { ...replacement, headers: { 'x-model-secret': 'FAKE-MODEL-HEADER' } });
  const exact = await readFile(path, 'utf8');
  await assert.rejects(saveOverrides(store, 'service', id, before.raw, {}), /其他操作者修改/);
  assert.equal(await readFile(path, 'utf8'), exact);
  await saveOverrides(store, 'service', id, exact, {});
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).providers.service.modelOverrides[id], { headers: { 'x-model-secret': 'FAKE-MODEL-HEADER' } });
  for (const bad of [{ contextWindow: -1 }, { reasoning: 'yes' }, { input: ['audio'] }, { api: 'openai-completions' }, { headers: { key: 'private' } }, []]) await assert.rejects(validateOverrides(bad));
});

test('malformed, commented and symlink model files are not rewritten by the parameter editor', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-model-file-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir), path = join(dir, 'models.json');
  for (const bytes of ['{"providers":', '// keep comments\n{"providers": {}}']) {
    await writeFile(path, bytes); await assert.rejects(modelFile(store), /未修改文件/); assert.equal(await readFile(path, 'utf8'), bytes);
  }
  await rm(path); const target = join(dir, 'private'); await atomicJson(target, { providers: {} }); await symlink(target, path);
  await assert.rejects(modelFile(store), /安全读取/);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { providers: {} });
  await rm(path); await link(target, path);
  await assert.rejects(modelFile(store), /安全读取/);
  await rm(path); await writeFile(path, ' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(modelFile(store), /安全读取/);
});

test('read-only model information shows prices and distinguishes unknown, reference and native values', () => {
  const model = base();
  const unknown = modelDetails(model, model, connection, { providers: {} });
  assert.match(unknown, /实际使用：openai-responses/);
  assert.match(unknown, /上下文：128,000 tokens.*unverified-default/);
  assert.match(unknown, /价格 · USD \/ 百万 tokens/);
  assert.equal(unknown.split('未知（Pi 以 0 占位，不代表免费）').length - 1, 4);
  assert(!unknown.includes('公共目录参考价'));
  assert(!unknown.includes('headers') && !unknown.includes('baseUrl'));
  const native = { contextWindow: 270000, reasoning: true, input: ['text', 'image'] as ('text' | 'image')[], cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 } };
  const effective = { ...model, ...native };
  const output = modelDetails(effective, model, connection, { providers: { service: { modelOverrides: { [id]: native } } } });
  assert.match(output, /上下文：270,000 tokens.*models.json/);
  assert.match(output, /输入：1.*models.json/); assert.match(output, /输出：4.*models.json/);
  assert(!output.includes('不代表免费')); assert(!output.includes('公共目录参考价'));
  const warnings = output.split('未验证默认值：')[1];
  assert(!warnings?.includes('contextWindow')); assert(!warnings?.includes('reasoning')); assert(!warnings?.includes('input'));
  const known = buildModels(connection, 'https://example.test', { rows: [{ id: 'gpt-6.1-sol' }], protocols: { 'gpt-6.1-sol': ['openai-responses'] }, evidence: { 'gpt-6.1-sol': 'endpoint' }, probes: [] })[0];
  const reference = modelDetails(known, known, connection, { providers: {} });
  assert(reference.includes('公共目录参考价'));
  assert(reference.includes('价格 · USD / 百万 tokens'));
  assert(reference.includes('"max":"max"'));
  const pending = modelDetails(model, model, connection, { providers: { service: { modelOverrides: { [id]: { contextWindow: 250000 } } } } });
  assert.match(pending, /上下文：128,000 tokens.*磁盘修改待刷新/);
  const nativeDefaults = modelDetails(model, model, connection, { providers: { service: { models: [{ id, api: 'openai-responses' }] } } });
  assert.match(nativeDefaults, /上下文：128,000 tokens.*Pi 原生模型默认/);
  assert.match(nativeDefaults, /未知（Pi 以 0 占位，不代表免费）/);
  const partialPrice = modelDetails({ ...model, cost: { ...model.cost, input: 1 } }, model, connection, { providers: { service: { models: [{ id, api: 'openai-responses', cost: { input: 1 } }] } } });
  assert.match(partialPrice, /输入：1.*models.json/);
  assert.equal(partialPrice.split('未知（Pi 以 0 占位，不代表免费）').length - 1, 3);
});
