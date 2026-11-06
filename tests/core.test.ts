import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryModelsStore, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { baseFor, decodeRows, declaredProtocols, discover, fingerprint, normalizeUrl, probeProtocol, selectProtocol, validProbeResponse } from '../src/discovery.ts';
import { buildModels } from '../src/metadata.ts';
import { Store, atomicJson, metadataOnly, parseRegistry } from '../src/storage.ts';
import { createGateway } from '../src/provider.ts';
import type { Connection, Discovery, Snapshot } from '../src/types.ts';

const id = 'gpt-6.1-sol';
const row = { id, native_endpoints: ['/v1/responses'], context_length: 272000, max_output_tokens: 128000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }] };
const signal = () => AbortSignal.timeout(10000);
const connection: Connection = { id: 'test-relay', name: 'Test' };
const d: Discovery = { rows: [row], protocols: { [id]: ['openai-responses'] }, evidence: { [id]: 'endpoint' }, probes: [] };
async function directory(t: any) { const dir = await mkdtemp(join(tmpdir(), 'pi-gateway-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function server(t: any, handler: RequestListener) {
  const srv = createServer(handler); await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { srv.closeAllConnections(); srv.close(() => resolve()); }));
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}

test('URL normalization, nested prefixes, API-specific bases and credential rejection', () => {
  assert.equal(normalizeUrl('https://example.test/proxy/v1/responses/'), 'https://example.test/proxy');
  assert.equal(baseFor('https://example.test/proxy/v1', 'anthropic-messages'), 'https://example.test/proxy');
  assert.equal(baseFor('https://example.test', 'google-generative-ai'), 'https://example.test/v1beta');
  for (const url of ['file:///etc/passwd', 'https://key@example.test', 'https://example.test?key=secret', 'https://example.test/#secret']) assert.throws(() => normalizeUrl(url));
});
test('Magpie and NewAPI protocol declarations; preference only among supported protocols', () => {
  assert.deepEqual(declaredProtocols(row), ['openai-responses']);
  const supported = declaredProtocols({ supported_endpoint_types: ['openai','openai-response','anthropic','gemini','unknown'] });
  assert.equal(selectProtocol(id, supported), 'openai-responses');
  assert.equal(selectProtocol('claude-sonnet', supported), 'anthropic-messages');
  assert.equal(selectProtocol('gemini-3', supported), 'google-generative-ai');
  assert.equal(selectProtocol(id, []), undefined);
  assert.equal(selectProtocol(id, ['openai-completions']), 'openai-completions');
});
test('real metadata mapping preserves image/max and never inherits official wire compat', () => {
  const [m] = buildModels(connection, 'https://example.test', d);
  assert.equal(m.contextWindow, 272000); assert.equal(m.maxTokens, 128000); assert.deepEqual(m.input, ['text','image']);
  assert.equal(m.thinkingLevelMap?.max, 'max'); assert.equal(m.thinkingLevelMap?.minimal, null);
  assert(getSupportedThinkingLevels(m).includes('max'));
  assert.deepEqual(m.compat, { supportsExplicitPromptCacheMode: false });
  const [bare] = buildModels(connection, 'https://example.test', { ...d, rows: [{ id }] });
  assert.equal(bare.contextWindow, 272000); assert.equal(bare.thinkingLevelMap?.max, 'max');
  assert.equal(bare.gateway.source.contextWindow, 'pi:openai');
  assert.equal((bare.compat as any).supportsAdditionalTools, undefined);
});
test('upstream false/limits beat catalog; unknown protocols are not guessed', () => {
  const [m] = buildModels(connection, 'https://example.test', { ...d, rows: [{ ...row, reasoning: false, context_length: 64000, max_output_tokens: 99999, input_modalities: ['text'] }] });
  assert.equal(m.reasoning, false); assert.equal(m.thinkingLevelMap, undefined); assert.equal(m.contextWindow, 64000); assert.equal(m.maxTokens, 64000); assert.deepEqual(m.input, ['text']);
  assert.equal(buildModels(connection, 'https://example.test', { ...d, protocols: {} }).length, 0);
});
test('catalog decoder isolates malformed rows, rejects malformed envelopes', () => {
  assert.deepEqual(decodeRows({ data: [{ id: 'a' }, { id: 'a' }, { id: '\x1b[0m' }, null] }), [{ id: 'a' }]);
  assert.throws(() => decodeRows({ error: 'not a catalog' })); assert.throws(() => decodeRows({ data: [{}] })); assert.deepEqual(decodeRows([]), []);
});
test('200 is not proof: rejects error envelopes, HTML, wrong-protocol JSON', () => {
  for (const value of [{ error: 'failed' }, { choices: [] }, '<html>ok</html>', { object: 'response', output: [], status: 'failed' }]) assert.equal(validProbeResponse('openai-responses', value), false);
  assert.equal(validProbeResponse('openai-responses', { object: 'response', output: [], status: 'incomplete' }), true);
});
test('catalog declarations avoid paid probes; explicit probing verifies per-model protocols', async t => {
  let posts = 0;
  const root = await server(t, async (req: any, res: any) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [row] })); return; }
    posts++; assert.equal(req.headers.authorization, req.url === '/v1/responses' || req.url === '/v1/chat/completions' ? 'Bearer fake-key' : undefined);
    if (req.url === '/v1/responses') res.end(JSON.stringify({ object: 'response', output: [], status: 'completed' }));
    else if (req.url === '/v1/chat/completions') res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  const found = await discover(root, 'fake-key', signal()); assert.equal(posts, 0); assert.deepEqual(found.protocols[id], ['openai-responses']);
  assert.equal((await probeProtocol(root, 'fake-key', 'openai-responses', id, signal())).ok, true);
  assert.equal((await probeProtocol(root, 'fake-key', 'anthropic-messages', id, signal())).ok, false);
  assert.equal(posts, 2);
});
test('paginated catalogs stay on the configured endpoint; auth fallbacks preserve protocol metadata', async t => {
  let mode = 'pages';
  const root = await server(t, (req: any, res: any) => {
    res.setHeader('content-type', 'application/json');
    if (mode === 'pages') return res.end(JSON.stringify(req.url.includes('after_id=') ? { data: [{ id: 'b' }], has_more: false } : { data: [{ id: 'a' }], has_more: true, last_id: 'a' }));
    if (!req.url.startsWith('/v1beta/')) { res.statusCode = req.headers['x-api-key'] ? 404 : 401; return res.end('{}'); }
    assert.equal(req.headers['x-goog-api-key'], 'fake-pagination-key');
    res.end(JSON.stringify({ models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }] }));
  });
  const { fetchCatalog } = await import('../src/discovery.ts');
  assert.deepEqual((await fetchCatalog(root, 'fake-pagination-key', signal())).map(r => r.id), ['a', 'b']);
  mode = 'gemini'; const catalog = await discover(root, 'fake-pagination-key', signal());
  assert.deepEqual(catalog.protocols['models/gemini-test'], ['google-generative-ai']);
});
test('stream-only protocol probes inspect actual events and reject 200-stream errors', async t => {
  let mode = 'ok';
  const root = await server(t, (req: any, res: any) => {
    res.setHeader('content-type', 'text/event-stream');
    const event = mode === 'ok' ? { type: 'response.output_text.delta', delta: 'OK' } : { type: 'error', error: { message: 'fake refusal' } };
    res.end(`data: ${JSON.stringify(event)}\n\n`);
  });
  assert.equal((await probeProtocol(root, 'fake-stream-key', 'openai-responses', id, signal())).ok, true);
  mode = 'error'; assert.equal((await probeProtocol(root, 'fake-stream-key', 'openai-responses', id, signal())).ok, false);
});
test('authenticated redirects do not forward credentials to another endpoint', async t => {
  let received = 0;
  const other = await server(t, (_: any, res: any) => { received++; res.end('{}'); });
  const root = await server(t, (_: any, res: any) => { res.writeHead(302, { location: `${other}/v1/responses` }); res.end(); });
  const result = await probeProtocol(root, 'do-not-forward', 'openai-responses', id, signal());
  assert.equal(result.ok, false); assert.equal(received, 0); assert(!JSON.stringify(result).includes('do-not-forward'));
});
test('metadata cache excludes arbitrary credentials/headers/URLs and registry validates IDs', () => {
  const stripped = metadataOnly({ ...row, apiKey: 'SECRET', headers: { Authorization: 'SECRET' }, baseUrl: 'https://attacker.test', capabilities: { reasoning: true, secret: 'SECRET' } });
  assert(!JSON.stringify(stripped).includes('SECRET')); assert(!JSON.stringify(stripped).includes('attacker'));
  assert.throws(() => parseRegistry({ version: 1, connections: [{ id: '../escape', name: 'bad' }] }));
});
test('atomic private registry writes preserve concurrent additions and reject lost updates', async t => {
  const dir = await directory(t); const store = new Store(dir);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.put({ id: `relay-${i}`, name: `Relay ${i}` }, null)));
  assert.equal((await store.registry()).connections.length, 12);
  assert.equal((await stat(store.registryPath)).mode & 0o777, 0o600);
  const c = (await store.registry()).connections[0]; await store.put({ ...c, name: 'Changed' }, c);
  await assert.rejects(store.put({ ...c, name: 'Lost update' }, c));
  await writeFile(store.registryPath, '{broken'); await assert.rejects(store.registry());
  assert.equal(await readFile(store.registryPath, 'utf8'), '{broken');
});
test('Pi native runtime integration: cached startup, user overrides, max, no prompt_cache_options', async t => {
  const dir = await directory(t); const store = new Store(dir); const root = 'https://example.test';
  const credential = { type: 'api_key', key: 'test-key', env: { PI_GATEWAY_URL: root } };
  await atomicJson(join(dir, 'auth.json'), { [connection.id]: credential });
  await store.put({ ...connection, url: root }, null);
  const snapshot: Snapshot = { version: 1, fingerprint: fingerprint(root, credential.key), checkedAt: Date.now(), discovery: d };
  await store.save(connection.id, snapshot);
  await atomicJson(join(dir, 'models.json'), { providers: { [connection.id]: { modelOverrides: { [id]: { contextWindow: 260000, compat: { supportsStrictMode: false } } } } } });
  const h = createGateway({ ...connection, url: root }, store); t.after(() => h.dispose());
  await h.initialize(signal(), false); assert.equal(h.provider.getModels().length, 1);
  const runtime = await ModelRuntime.create({ authPath: join(dir,'auth.json'), modelsPath: join(dir,'models.json'), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  runtime.registerNativeProvider(h.provider); await runtime.refresh({ providers: [connection.id], allowNetwork: false });
  const model = runtime.getModel(connection.id, id)!;
  assert(model, `runtime model missing: ${runtime.getError()}`);
  assert.equal(model.contextWindow, 260000); assert.equal((model.compat as any).supportsStrictMode, false); assert(getSupportedThinkingLevels(model).includes('max'));
  let payload: any;
  const controller = new AbortController();
  const result = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] }, { reasoning: 'max', cacheRetention: 'none', signal: controller.signal, onPayload(p) { payload = p; controller.abort(); } });
  assert(payload); assert.equal(payload.prompt_cache_options, undefined); assert.equal(payload.reasoning.effort, 'max'); assert(['aborted','error'].includes(result.stopReason));
  await atomicJson(join(dir, 'auth.json'), { [connection.id]: { ...credential, key: 'rotated-key' } });
  const changed = createGateway({ ...connection, url: root }, store); t.after(() => changed.dispose()); await changed.initialize(signal(), false); assert.equal(changed.provider.getModels().length, 0);
});
test('refresh failure retains cache, valid empty catalog clears it, cancel does not publish', async t => {
  const dir = await directory(t); const store = new Store(dir); let mode = 'ok'; let gets = 0;
  const root = await server(t, (_: any, res: any) => { gets++; res.setHeader('content-type','application/json'); if (mode === 'fail') { res.statusCode=503; res.end('{}'); } else res.end(JSON.stringify({ data: mode === 'empty' ? [] : [row] })); });
  const cred = { type: 'api_key' as const, key: 'fake-key', env: { PI_GATEWAY_URL: root } };
  await atomicJson(join(dir,'auth.json'), { [connection.id]: cred });
  const h = createGateway({ ...connection, url: root }, store); t.after(() => h.dispose()); await h.initialize(signal(), true);
  let published = 0;
  const refresh = () => h.provider.refreshModels!({ credential: cred, allowNetwork: true, force: true, signal: signal(), publish: async p => { published++; p.update?.(); return true; } });
  mode = 'fail'; await assert.rejects(refresh()); assert.equal(h.info().models.length, 1);
  mode = 'empty'; await refresh(); assert.equal(h.info().models.length, 0); assert.equal(published, 1);
  mode = 'ok'; const aborted = AbortSignal.abort(); await assert.rejects(h.provider.refreshModels!({ credential: cred, allowNetwork: true, force: true, signal: aborted, publish: async () => { throw new Error('must not publish'); } }));
  assert(gets >= 3);
});
