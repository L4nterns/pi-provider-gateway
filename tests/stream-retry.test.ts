import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createGateway } from '../src/provider.ts';
import { Store, atomicJson } from '../src/storage.ts';
import { fingerprint } from '../src/discovery.ts';

const id = 'demo-model';
const key = 'FAKE-STREAM-RETRY-KEY';

/**
 * A real loopback SSE endpoint, a real Pi session, and the real gateway
 * extension. This catches the integration gap that unit tests around
 * normalizeAssistantError cannot: whether the message_end replacement reaches
 * Pi's auto-retry loop with the configured budget.
 */
test('opaque SSE drops are normalized and retried by a real Pi session', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-stream-retry-'));
  const agent = join(dir, 'agent');
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const posts: Array<{ method: string; url: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', data => body += data);
    req.on('end', () => {
      posts.push({ method: req.method ?? '', url: req.url ?? '', body });
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id, native_endpoints: ['/v1/chat/completions'], context_length: 100_000, max_output_tokens: 8192 }] }));
        return;
      }
      // A valid SSE stream that ends in an opaque upstream error, matching the
      // relay behavior that previously surfaced as "Unknown error" and stopped.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: {"id":"chunk","object":"chat.completion.chunk","created":1,"model":${JSON.stringify(id)},"choices":[{"index":0,"delta":{},"finish_reason":null}]}\n\n`);
      res.write('data: {"error":{"message":"Unknown error","type":"upstream_error"}}\n\n');
      res.end();
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let disposeSession: (() => void) | undefined;
  t.after(async () => {
    disposeSession?.();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
    await rm(dir, { recursive: true, force: true });
  });

  const store = new Store(agent);
  await store.put({ id: 'demo', name: 'demo', url: root }, null);
  await atomicJson(join(agent, 'auth.json'), { demo: { type: 'api_key', key, env: { PI_GATEWAY_URL: root } } });
  await store.save('demo', {
    version: 1,
    checkedAt: Date.now(),
    fingerprint: fingerprint(root, key),
    discovery: {
      rows: [{ id, native_endpoints: ['/v1/chat/completions'], context_length: 100_000, max_output_tokens: 8192 }],
      protocols: { [id]: ['openai-completions'] },
      evidence: { [id]: 'endpoint' },
      probes: [],
    },
  });
  await atomicJson(join(agent, 'cache', 'gateway', 'models-dev.json'), { checkedAt: Date.now(), data: {} });
  await atomicJson(join(agent, 'settings.json'), {
    quietStartup: true,
    enableAnalytics: false,
    defaultProvider: 'demo',
    defaultModel: id,
    retry: { enabled: true, maxRetries: 5, baseDelayMs: 1, maxAgentDelayMs: 10, provider: { maxRetries: 0, maxRetryDelayMs: 10 } },
    extensions: ['-builtin:mcp', '-builtin:codemode', '-builtin:tool_search'],
  });

  // The gateway extension resolves its agent directory from the environment,
  // exactly as the installed extension does. Scope it to this test.
  process.env.PI_CODING_AGENT_DIR = agent;
  const settings = SettingsManager.create(dir, agent);
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: agent,
    settingsManager: settings,
    additionalExtensionPaths: [resolve('src/index.ts')],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const gateway = createGateway({ id: 'demo', name: 'demo', url: root }, store);
  await gateway.initialize(AbortSignal.timeout(10_000), false);
  const runtime = await ModelRuntime.create({
    authPath: join(agent, 'auth.json'),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(gateway.provider);
  await runtime.refresh({ providers: ['demo'], allowNetwork: false });
  const model = runtime.getModel('demo', id);
  assert(model);

  const { session, extensionsResult } = await createAgentSession({
    cwd: dir,
    agentDir: agent,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(),
    noTools: 'all',
  });
  disposeSession = () => { session.dispose(); gateway.dispose(); };
  assert.equal(extensionsResult.errors.length, 0);
  await session.bindExtensions({});

  const retryAttempts: number[] = [];
  const assistantErrors: string[] = [];
  session.subscribe(event => {
    if (event.type === 'auto_retry_start') retryAttempts.push(event.attempt);
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.errorMessage) {
      assistantErrors.push(event.message.errorMessage);
    }
  });

  await session.prompt('hello');
  assert.equal(posts.length, 6, 'one initial request plus five configured retries');
  assert.deepEqual(retryAttempts, [1, 2, 3, 4, 5]);
  assert.equal(posts.filter(post => post.method === 'POST').length, 6);
  assert(posts.every(post => post.url === '/v1/chat/completions'));
  assert(assistantErrors.length >= 1);
  assert.match(assistantErrors.at(-1)!, /Upstream response stream was interrupted/);
  assert.match(assistantErrors.at(-1)!, /Unknown error/);
  assert(!JSON.stringify(posts).includes(key), 'the fake key must not appear in requests');
});
