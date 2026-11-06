import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import gatewayExtension from '../src/index.ts';
import { atomicJson, Store } from '../src/storage.ts';
import { fingerprint } from '../src/discovery.ts';
import type { Row } from '../src/types.ts';

const modelId = 'gpt-6.1-sol';
const key = 'FAKE-COMMAND-KEY';
async function fixture(t: TestContext, seed?: (store: Store, root: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-command-'));
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = dir; delete process.env.PI_OFFLINE;
  const store = new Store(dir);
  await atomicJson(join(dir, 'cache/gateway/models-dev.json'), { checkedAt: Date.now(), data: {} });
  const state = {
    catalog: [{ id: modelId, native_endpoints: ['/v1/responses', '/v1/chat/completions'] }] as Row[],
    status: 200, requests: [] as string[], inputs: [] as (string | undefined)[], idle: true,
    progress: [] as string[], loader: undefined as any,
    onRequest: undefined as ((method: string, url?: string) => boolean) | undefined,
    selects: [] as (string | undefined)[], secrets: [] as (string | undefined)[], edits: [] as (string | undefined)[], views: [] as string[],
    onEditor: undefined as (() => Promise<void>) | undefined,
    prompts: [] as { message: string; placeholder?: string; choices?: string[] }[],
    notices: [] as { message: string; kind: string }[], secretProviders: [] as string[][],
    onSecret: undefined as (() => Promise<void>) | undefined,
  };
  const server = createServer((req, res) => {
    state.requests.push(req.method!);
    if (state.onRequest?.(req.method!, req.url)) return;
    res.writeHead(state.status, { 'content-type': 'application/json' });
    const response = req.method !== 'POST' ? { data: state.catalog }
      : req.url?.endsWith('/responses') ? { object: 'response', output: [], status: 'completed' }
      : req.url?.endsWith('/messages') ? { type: 'message', content: [] }
      : req.url?.includes(':generateContent') ? { candidates: [{}] } : { choices: [{ message: {} }] };
    res.end(JSON.stringify(response));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let shutdown = () => {};
  const registered = new Set<string>();
  t.after(async () => {
    shutdown();
    for (const [name, value] of [['PI_CODING_AGENT_DIR', previous.dir], ['PI_OFFLINE', previous.offline]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
    await rm(dir, { recursive: true, force: true });
  });
  await seed?.(store, root);
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  let command: any;
  const pi: any = {
    registerProvider: (p: any) => { registered.add(p.id); runtime.registerNativeProvider(p); },
    unregisterProvider: (id: string) => { registered.delete(id); runtime.unregisterProvider(id); },
    registerCommand: (_id: string, c: any) => { command = c; },
    on: (_event: string, handler: () => void) => { shutdown = handler; },
  };
  const ctx: any = {
    mode: 'tui', isIdle: () => state.idle,
    waitForIdle: async () => { throw new Error('Gateway must not queue silently behind the model'); },
    modelRegistry: { refresh: (o: any) => runtime.refresh(o), getAll: () => runtime.getModels(), getError: () => runtime.getError() },
    ui: {
      input: async (message: string, placeholder?: string) => { state.prompts.push({ message, placeholder }); return state.inputs.shift(); },
      select: async (message: string, choices: string[]) => {
        state.prompts.push({ message, choices }); const requested = state.selects.shift();
        if (requested === undefined) return undefined;
        const choice = choices.find(c => c === requested || c.startsWith(requested + '  '));
        assert(choice, `selection ${requested} missing in ${choices.join(',')}`); return choice;
      },
      confirm: async () => true,
      editor: async (message: string, text: string) => { state.prompts.push({ message, placeholder: text }); await state.onEditor?.(); return state.edits.shift(); },
      notify: (message: string, kind: string) => state.notices.push({ message, kind }),
      custom: async (factory: any, options: any) => {
        if (options?.blocked?.kind === 'auth') {
          state.secretProviders.push([...registered]); await state.onSecret?.(); return state.secrets.shift();
        }
        return new Promise(resolve => {
          let component: any;
          const render = () => { if (component) state.progress.push(...component.render(100)); };
          const tui = { requestRender: render, terminal: { rows: 32 } };
          const keys: Record<string, string> = { 'tui.select.cancel': '\x1b', 'tui.select.up': '\x1b[A', 'tui.select.down': '\x1b[B', 'tui.select.pageDown': '\x1b[6~', 'tui.select.pageUp': '\x1b[5~' };
          component = factory(tui, { fg: (_: string, s: string) => s }, { matches: (s: string, action: string) => keys[action] === s }, (value: unknown) => {
            component.dispose?.(); state.loader = undefined; resolve(value);
          });
          if (options?.blocked?.kind === 'question') {
            const frames = [component.render(100).join('\n')];
            component.handleInput('\r'); component.handleInput('\x07');
            for (let i = 0; i < 5; i++) { component.handleInput('\x1b[6~'); frames.push(component.render(100).join('\n')); }
            state.views.push(frames.join('\n'));
            component.handleInput('\x1b');
          } else { state.loader = component; render(); }
        });
      },
    },
  };
  async function load() {
    shutdown();
    for (const id of registered) runtime.unregisterProvider(id);
    registered.clear();
    await gatewayExtension(pi);
    await runtime.refresh({ allowNetwork: false });
  }
  await load();
  async function run(args: string, error?: RegExp) {
    const start = state.notices.length;
    await command.handler(args, ctx);
    const errors = state.notices.slice(start).filter(n => n.kind === 'error').map(n => n.message).join('\n');
    if (error) assert.match(errors, error); else assert.equal(errors, '');
    assert(!state.notices.map(n => n.message).join('').includes(key));
  }
  async function add(id: string) {
    state.inputs.push(id, root); state.secrets.push(key);
    await run('add');
  }
  async function probe(error?: RegExp) {
    state.inputs.push(''); state.secrets.push(''); state.selects.push('探测协议');
    await run('edit service', error);
  }
  return { state, dir, root, store, runtime, registered, ctx, load, run, add, probe, command: () => command };
}

test('Gateway has only real actions and keeps risk warnings at the actual operation', async t => {
  const f = await fixture(t);
  await f.add('service');
  const auth = await readFile(join(f.dir, 'auth.json'), 'utf8');
  const requests = f.state.requests.length;
  await f.run('');
  const menu = f.state.prompts.findLast(p => p.message === 'Gateway')!;
  assert.deepEqual(menu.choices!.map(c => c.split('  ')[0]), ['添加服务', '编辑服务', '刷新模型', '模型信息', '编辑模型', '删除服务']);
  assert(!menu.choices!.join('').match(/不管理|上游|稳定 ID|返回|协议覆盖|探测协议/));
  f.state.inputs.push(''); f.state.secrets.push(''); f.state.selects.push('取消'); await f.run('edit service', /已取消/);
  assert.match(f.state.prompts.at(-1)!.message, /最多 4 次请求，可能计费/);
  assert.equal(f.state.requests.length, requests + 1, 'editing reads a catalog but cancelled consent sends no probe');
  f.state.selects.push('取消'); await f.run('remove service');
  assert.equal(f.state.prompts.at(-1)!.choices![0], '取消');
  assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), auth);
});

test('empty registry has only Add, no implicit provider, no legacy login command', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.registered], []);
  assert.equal(f.runtime.getProvider('gateway'), undefined);
  await f.run('');
  assert.equal(f.state.prompts[0].message, 'Gateway');
  assert.deepEqual(f.state.prompts[0].choices, ['添加服务  创建服务，填写服务 ID、URL 和 Key']);
  f.state.prompts.length = 0;
  await f.run('edit', /尚未添加服务.*gateway add/);
  await f.run('login', /用法/);
  await f.run('login gateway', /用法/);
  await f.run('add ignored-id', /用法/);
  assert.deepEqual(f.state.prompts, []);
  assert.deepEqual(f.command().getArgumentCompletions('').map((x: { value: string }) => x.value), ['add', 'edit', 'refresh', 'info', 'model', 'remove']);
  await f.run('detect', /用法/); await f.run('protocol', /用法/);
  await assert.rejects(readFile(f.store.registryPath), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')), {});
});

test('first service uses the same Add wizard and registers only after successful native authentication', async t => {
  const f = await fixture(t);
  f.state.selects.push('添加服务'); f.state.inputs.push('my-service', f.root); f.state.secrets.push(key);
  await f.run('');
  assert.deepEqual(f.state.secretProviders, [[]], 'neither a default nor a tentative service is published');
  assert.match(f.state.prompts[1].message, /服务 ID.*必填.*固定/);
  assert.equal(f.state.prompts[2].message, '服务 URL');
  assert.deepEqual([...f.registered], ['my-service']);
  assert.deepEqual((await f.store.registry()).connections, [{ id: 'my-service', name: 'my-service', url: f.root }]);
  assert(f.runtime.getModel('my-service', modelId));
  assert.equal(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8'))['my-service'].key, key);
  await f.load();
  assert.deepEqual([...f.registered], ['my-service']);
  assert(f.runtime.getModel('my-service', modelId));
  f.state.selects.push('删除'); await f.run('remove my-service'); await f.load();
  assert.deepEqual([...f.registered], [], 'removing the last service must not recreate a default');
});

test('terminal workflow: add/edit/info/model/refresh/remove; no key in notifications', async t => {
  const f = await fixture(t);
  await f.add('service');
  await assert.rejects(f.runtime.getProvider('service')!.auth.apiKey!.login!({ prompt: async () => { throw new Error('must not prompt'); }, notify: () => {} } as any), /gateway edit service.*遮罩/);
  f.state.selects.push(modelId); await f.run('info service');
  f.state.selects.push(modelId, '协议', 'openai-completions'); await f.run('model service');
  assert.equal(f.runtime.getModel('service', modelId)?.api, 'openai-completions');
  await f.run('refresh service');
  const promptStart = f.state.prompts.length;
  f.state.selects.push('编辑服务', '保持当前设置'); f.state.inputs.push(''); f.state.secrets.push(''); await f.run('');
  assert(!f.state.prompts.slice(promptStart + 1).some(p => p.message.includes('服务 ID')), 'edit never offers an ID rename');
  assert.equal(f.runtime.getModel('service', modelId)?.api, 'openai-completions');
  assert.equal(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')).service.key, key);
  f.state.selects.push('删除'); await f.run('remove service');
  assert.equal((await f.store.registry()).connections.length, 0);
  assert.equal(f.runtime.getProvider('service'), undefined);
  assert(!JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')).service);
  assert(f.state.requests.every(method => method === 'GET'), 'declared protocols must not trigger paid generation probes');
});

test('service picker contains only persisted services and edit keeps the selected ID', async t => {
  const f = await fixture(t);
  await f.add('one'); await f.add('two');
  f.state.selects.push('编辑服务', 'two', '保持当前设置'); f.state.inputs.push(''); f.state.secrets.push('replacement-key');
  await f.run('');
  assert.deepEqual(f.state.prompts.find(p => p.message === '选择服务 ID')?.choices, ['one', 'two']);
  const auth = JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8'));
  assert.equal(auth.one.key, key); assert.equal(auth.two.key, 'replacement-key');
  await f.load(); assert.deepEqual([...f.registered], ['one', 'two']);
});

test('cancelling or failing Add leaves no provider, registry entry or native credential', async t => {
  for (const stage of ['id', 'url', 'key', 'protocol', 'catalog']) {
    await t.test(stage, async t => {
      const f = await fixture(t);
      if (stage !== 'id') f.state.inputs.push('cancelled');
      if (stage !== 'id' && stage !== 'url') f.state.inputs.push(f.root);
      if (stage === 'protocol' || stage === 'catalog') f.state.secrets.push(key);
      if (stage === 'protocol') { f.state.catalog = [{ id: modelId }]; f.state.selects.push('取消'); }
      if (stage === 'catalog') f.state.status = 401;
      await f.run('add', stage === 'id' ? undefined : stage === 'catalog' ? /HTTP 401/ : /取消/);
      assert.deepEqual([...f.registered], []);
      assert.deepEqual((await f.store.registry()).connections, []);
      assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')), {});
      await f.load(); assert.deepEqual([...f.registered], []);
    });
  }
});

test('Add requires an explicit unique ID, without auto-numbering or login reuse', async t => {
  const f = await fixture(t);
  await atomicJson(join(f.dir, 'auth.json'), { orphan: { type: 'api_key', key: 'orphan-key', env: { PI_GATEWAY_URL: f.root } } });
  for (const id of ['', ' ', 'bad id', 'openai']) {
    f.state.inputs.push(id); await f.run('add');
    assert.match(f.state.notices.at(-1)!.message, /服务 ID.*无效|服务 ID.*已存在/);
  }
  await f.add('one');
  f.state.inputs.push('one'); await f.run('add'); assert.match(f.state.notices.at(-1)!.message, /服务 ID.*已存在/);
  f.state.inputs.push('orphan', f.root); f.state.secrets.push('');
  await f.run('add', /请输入有效 API Key/);
  assert.deepEqual([...f.registered], ['one']);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')).orphan.key, 'orphan-key');
});

test('concurrent Add cannot overwrite a service created by another Pi', async t => {
  const f = await fixture(t);
  const other = { id: 'collision', name: 'Other session', url: f.root, protocol: 'openai-completions' as const };
  f.state.inputs.push('collision', f.root); f.state.secrets.push(key);
  f.state.onSecret = async () => {
    await f.store.put(other, null);
    await atomicJson(join(f.dir, 'auth.json'), { collision: { type: 'api_key', key: 'other-session-key', env: { PI_GATEWAY_URL: f.root } } });
  };
  await f.run('add', /其他会话修改/);
  assert.deepEqual([...f.registered], []);
  assert.deepEqual((await f.store.registry()).connections, [other]);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')).collision.key, 'other-session-key');
});

test('streaming opens the menu immediately; mutations warn without queuing, read-only info still works', async t => {
  const f = await fixture(t);
  await f.add('service'); f.state.idle = false;
  f.state.prompts.length = 0;
  await f.run('');
  assert.equal(f.state.prompts[0].message, 'Gateway');
  const requests = f.state.requests.length;
  for (const action of ['add', 'edit service', 'refresh service', 'model service', 'remove service']) {
    await f.run(action);
    assert.match(f.state.notices.at(-1)!.message, /未执行、未排队/);
  }
  assert.equal(f.state.requests.length, requests);
  f.state.selects.push(modelId); await f.run('info service');
  f.state.idle = true; f.state.selects.push(modelId); await f.run('info service');
  assert(!f.state.notices.some(n => n.message.includes('已有 Gateway 操作')));
});

test('only a real open Gateway dialog holds the command lock, cancellation releases it', async t => {
  const f = await fixture(t);
  let close!: (value: undefined) => void;
  f.ctx.ui.select = () => new Promise(resolve => { close = resolve; });
  const first = f.command().handler('', f.ctx);
  assert.equal(typeof close, 'function', 'the dialog is entered before waiting for any model');
  await f.run(''); assert.match(f.state.notices.at(-1)!.message, /已有 Gateway 操作/);
  close(undefined); await first;
  f.ctx.ui.select = async () => undefined;
  const count = f.state.notices.length;
  await f.run(''); assert.equal(f.state.notices.length, count);
});

test('protocol detection renders native progress for the catalog and each of four protocols', async t => {
  const f = await fixture(t);
  await f.add('service');
  await f.probe();
  const rendered = f.state.progress.join('\n');
  assert.match(rendered, /正在读取模型目录/);
  for (const [index, api] of ['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai'].entries()) {
    assert(rendered.includes(`（${index + 1}/4）：${api}`), rendered);
  }
  assert.match(rendered, /正在解析模型能力/); assert.match(rendered, /「Esc」取消/);
  assert.equal(f.state.requests.filter(m => m === 'POST').length, 4);
  assert.equal(f.state.loader, undefined);
  assert(!rendered.includes(key));
});

test('Escape aborts in-flight protocol detection without saving or leaving a busy operation', async t => {
  const f = await fixture(t);
  await f.add('service');
  const before = await readFile(f.store.cachePath('service'), 'utf8');
  f.state.onRequest = method => {
    if (method !== 'POST') return false;
    f.state.loader.handleInput('\x1b'); return true;
  };
  await f.probe(/已取消 Gateway 操作/);
  assert.equal(f.state.requests.filter(m => m === 'POST').length, 1);
  assert.equal(await readFile(f.store.cachePath('service'), 'utf8'), before);
  assert.equal(f.state.loader, undefined);
  f.state.selects.push(modelId); await f.run('info service');
});

test('failed protocol discovery dismisses the loader and preserves the last valid cache', async t => {
  const f = await fixture(t);
  await f.add('service'); const before = await readFile(f.store.cachePath('service'), 'utf8');
  f.state.status = 503; await f.probe(/HTTP 503/);
  assert.equal(f.state.loader, undefined); assert.equal(await readFile(f.store.cachePath('service'), 'utf8'), before);
  assert.match(f.state.progress.join(''), /正在读取模型目录/);
});

test('invalid ID and URL retry only their current steps; validation errors do not echo credentials', async t => {
  const f = await fixture(t);
  f.state.inputs.push('bad id', 'openai', 'valid', 'not-a-url', 'https://user:private@example.test', f.root);
  f.state.secrets.push(key); await f.run('add');
  assert.deepEqual([...f.registered], ['valid']);
  assert.equal(f.state.secretProviders.length, 1, 'ID/URL correction never prompts or retains an earlier key');
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.prompts.filter(p => p.message.includes('服务 ID')).length, 3);
  assert.equal(f.state.prompts.filter(p => p.message === '服务 URL').length, 3);
  assert(!f.state.notices.some(n => n.message.includes('user:private')));
});

test('add and edit catalog requests have cancellable native progress and preserve all prior state', async t => {
  for (const action of ['add', 'edit']) await t.test(action, async t => {
    const f = await fixture(t);
    if (action === 'edit') await f.add('service');
    const beforeRegistry = await f.store.registry();
    const beforeAuth = await readFile(join(f.dir, 'auth.json'), 'utf8');
    const beforeCache = await readFile(f.store.cachePath('service'), 'utf8').catch(() => undefined);
    f.state.inputs.push(...(action === 'add' ? ['service', f.root] : [''])); f.state.secrets.push(key);
    f.state.onRequest = () => { f.state.loader.handleInput('\x1b'); return true; };
    await f.run(action === 'add' ? 'add' : 'edit service', /已取消 Gateway 操作/);
    assert.match(f.state.progress.join('\n'), /正在读取模型目录与协议声明/);
    assert.equal(f.state.loader, undefined);
    assert.deepEqual(await f.store.registry(), beforeRegistry);
    assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), beforeAuth);
    assert.equal(await readFile(f.store.cachePath('service'), 'utf8').catch(() => undefined), beforeCache);
    f.state.onRequest = undefined;
    if (action === 'add') await f.add('after-cancel');
    else { f.state.selects.push(modelId); await f.run('info service'); }
  });
});

test('batch probes use only the consented catalog, report progress, and cancellation settles all workers', async t => {
  for (const cancel of [false, true]) await t.test(cancel ? 'cancel' : 'success', async t => {
    const f = await fixture(t);
    const nativeFetch = globalThis.fetch; let started = 0;
    t.mock.method(globalThis, 'fetch', (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === 'POST') started++;
      return nativeFetch(...args);
    });
    f.state.catalog = Array.from({ length: cancel ? 8 : 2 }, (_, i) => ({ id: `${modelId}-${i}` }));
    f.state.inputs.push('batch', f.root); f.state.secrets.push(key); f.state.selects.push('探测协议');
    f.state.onRequest = method => {
      if (method === 'GET') { setImmediate(() => f.state.catalog.push({ id: 'not-in-consent' })); return false; }
      if (cancel) { f.state.loader?.handleInput('\x1b'); return true; }
      return false;
    };
    await f.run('add', cancel ? /已取消 Gateway 操作/ : undefined);
    assert.equal(f.state.requests.filter(x => x === 'GET').length, 1, 'catalog is not fetched again after consent');
    const requests = f.state.requests.filter(x => x === 'POST').length;
    if (cancel) {
      assert(requests > 0 && requests <= 3, String(requests));
      assert.deepEqual((await f.store.registry()).connections, []);
      assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')), {});
      const atReturn = started;
      await new Promise(r => setTimeout(r, 40));
      assert.equal(started, atReturn, 'no new fetches start after command returns');
      assert(started <= 3 && f.state.requests.filter(x => x === 'POST').length <= started, 'already-sent requests may still reach the server after cancellation');
    } else {
      assert.equal(requests, 8);
      assert.equal(f.runtime.getModels().filter(m => m.provider === 'batch').length, 2);
      assert.match(f.state.progress.join('\n'), /8\/8/);
    }
    assert.equal(f.state.loader, undefined);
  });
});

test('probe results keep evidence separate from model selection and native overrides', async t => {
  const f = await fixture(t);
  await f.add('service');
  f.state.selects.push(modelId, '协议', 'openai-completions'); await f.run('model service');
  await f.probe();
  f.state.selects.push(modelId); await f.run('info service');
  const message = f.state.views.at(-1)!;
  assert.match(message, /自动优选：openai-responses/);
  assert.match(message, /模型指定：openai-completions/);
  assert.match(message, /实际使用：openai-completions/);
  assert.match(message, /价格 · USD \/ 百万 tokens/);
  await f.run('remove service'); assert(f.registered.has('service'));
  const choices = f.state.prompts.at(-1)!.choices!;
  assert.equal(choices[0], '取消'); assert.equal(choices.length, 2);
});

test('partial probe failures keep known support and report native user protocol overrides accurately', async t => {
  const f = await fixture(t, async (store, root) => {
    // Pi's modelOverrides schema intentionally has no api field; a native models
    // upsert is the supported way to replace a model's protocol.
    await atomicJson(join(store.dir, 'models.json'), { providers: { service: { baseUrl: root, models: [{ id: modelId, api: 'anthropic-messages' }] } } });
  });
  await f.add('service');
  f.state.catalog = [{ id: modelId, supported_endpoint_types: ['anthropic'] }];
  f.state.onRequest = (method, url) => { f.state.status = method === 'POST' && url?.endsWith('/responses') ? 503 : 200; return false; };
  await f.probe();
  const saved = JSON.parse(await readFile(f.store.cachePath('service'), 'utf8'));
  assert(saved.discovery.protocols[modelId].includes('openai-responses'), '503 cannot revoke last-good evidence from the previous cache');
  assert(f.state.notices.some(n => n.message.includes('HTTP 503')));
  f.state.selects.push(modelId); await f.run('info service');
  assert.match(f.state.views.at(-1)!, /自动优选：openai-responses/);
  assert.match(f.state.views.at(-1)!, /实际使用：anthropic-messages/);
});

test('stale mutation cannot log out or delete another session updated connection', async t => {
  const f = await fixture(t); await f.add('service');
  const old = (await f.store.registry()).connections[0];
  await f.store.put({ ...old, protocol: 'openai-completions' }, old);
  const authBefore = await readFile(join(f.dir, 'auth.json'), 'utf8');
  const cacheBefore = await readFile(f.store.cachePath('service'), 'utf8');
  await f.run('remove service', /其他会话修改.*未修改凭据/);
  assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), authBefore);
  assert.equal(await readFile(f.store.cachePath('service'), 'utf8'), cacheBefore);
  assert.equal((await f.store.registry()).connections[0].protocol, 'openai-completions');
  assert(f.registered.has('service'));
});

test('refresh aborted results never report success or erase last-good cache', async t => {
  const f = await fixture(t); await f.add('service');
  const before = await readFile(f.store.cachePath('service'), 'utf8');
  f.ctx.modelRegistry.refresh = async () => ({ aborted: true, errors: new Map() });
  await f.run('refresh service', /取消或超时/);
  assert.equal(await readFile(f.store.cachePath('service'), 'utf8'), before);
  assert.equal(f.state.loader, undefined);
});

test('stored gateway ID, native model overrides and history are ordinary data, never migrated or removed', async t => {
  const f = await fixture(t, async (store, root) => {
    await store.put({ id: 'gateway', name: 'Gateway', protocol: 'openai-responses', modelProtocols: { [modelId]: 'openai-responses' } }, null);
    await atomicJson(join(store.dir, 'auth.json'), { gateway: { type: 'api_key', key, env: { PI_GATEWAY_URL: root } } });
    await atomicJson(join(store.dir, 'models.json'), { providers: { gateway: { modelOverrides: { [modelId]: { compat: { supportsExplicitPromptCacheMode: false } } } } } });
    await atomicJson(join(store.dir, 'settings.json'), { theme: 'system' });
    await atomicJson(join(store.dir, 'sessions/synthetic.jsonl'), { synthetic: 'untouched-history' });
    await store.save('gateway', { version: 1, fingerprint: fingerprint(root, key), checkedAt: Date.now(), discovery: { rows: [{ id: modelId }], protocols: { [modelId]: ['openai-responses'] }, evidence: { [modelId]: 'endpoint' }, probes: [] } });
  });
  const paths = [f.store.registryPath, join(f.dir, 'auth.json'), f.store.cachePath('gateway'), ...['models.json', 'settings.json', 'sessions/synthetic.jsonl'].map(p => join(f.dir, p))];
  const before = await Promise.all(paths.map(p => readFile(p, 'utf8')));
  assert.deepEqual([...f.registered], ['gateway']);
  await f.load(); assert.deepEqual(await Promise.all(paths.map(p => readFile(p, 'utf8'))), before);
  f.state.inputs.push(f.root); f.state.secrets.push(undefined); await f.run('edit gateway', /取消/);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p, 'utf8'))), before);
  f.state.status = 401; f.state.inputs.push(f.root); f.state.secrets.push('bad-key'); await f.run('edit gateway', /HTTP 401/);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p, 'utf8'))), before);
  assert(f.runtime.getModel('gateway', modelId));
  f.state.status = 200; f.state.inputs.push(''); f.state.secrets.push('new-key'); f.state.selects.push('保持当前设置'); await f.run('edit gateway');
  assert.deepEqual((await f.store.registry()).connections, JSON.parse(before[0]).connections.map((c: Row) => ({ ...c, url: f.root })));
  assert.equal(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')).gateway.key, 'new-key');
  assert.deepEqual(await Promise.all(paths.slice(3).map(p => readFile(p, 'utf8'))), before.slice(3));
  const model = f.runtime.getModel('gateway', modelId)!;
  assert.equal((model as any).compat.supportsExplicitPromptCacheMode, false);
  assert(model.input.includes('image')); assert.equal(model.thinkingLevelMap?.max, 'max');
});

test('Refresh rereads disk overrides and cache offline with no network or credential writes', async t => {
  const f = await fixture(t); await f.add('service');
  const auth = await readFile(join(f.dir, 'auth.json'), 'utf8');
  const registry = await readFile(f.store.registryPath, 'utf8');
  process.env.PI_OFFLINE = '1'; await f.load();
  const cache = JSON.parse(await readFile(f.store.cachePath('service'), 'utf8'));
  cache.discovery.rows.push({ id: 'new-local-model', contextWindow: 123456 });
  cache.discovery.protocols['new-local-model'] = ['openai-completions']; cache.discovery.evidence['new-local-model'] = 'probe';
  await f.store.save('service', cache);
  await atomicJson(join(f.dir, 'models.json'), { providers: { service: { modelOverrides: { [modelId]: { contextWindow: 250000, cost: { input: 2 } } } } } });
  const bytes = await readFile(join(f.dir, 'models.json'), 'utf8');
  const requests = f.state.requests.length;
  await f.run('refresh service');
  assert.equal(f.runtime.getModel('service', modelId)?.contextWindow, 250000);
  assert.equal(f.runtime.getModel('service', modelId)?.cost.input, 2);
  assert.equal(f.runtime.getModel('service', 'new-local-model')?.contextWindow, 123456);
  assert.equal(f.state.requests.length, requests);
  assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), auth);
  assert.equal(await readFile(f.store.registryPath, 'utf8'), registry);
  assert.equal(await readFile(join(f.dir, 'models.json'), 'utf8'), bytes);
  assert.deepEqual(JSON.parse(await readFile(f.store.cachePath('service'), 'utf8')), cache);
  const c = (await f.store.registry()).connections[0];
  await f.store.put({ ...c, modelProtocols: { [modelId]: 'openai-completions' } }, c);
  const editedRegistry = await readFile(f.store.registryPath, 'utf8');
  await f.run('refresh service');
  assert.equal(f.runtime.getModel('service', modelId)?.api, 'openai-completions');
  assert.equal(await readFile(f.store.registryPath, 'utf8'), editedRegistry);
  assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), auth);
  assert.equal(f.state.requests.length, requests);
  const commented = '// edited outside Pi; keep this comment\n' + bytes.replace('250000', '260000');
  await writeFile(join(f.dir, 'models.json'), commented);
  await f.run('refresh service');
  assert.equal(f.runtime.getModel('service', modelId)?.contextWindow, 260000);
  assert.equal(await readFile(join(f.dir, 'models.json'), 'utf8'), commented);
  assert.equal(f.state.requests.length, requests);
});

test('Edit Model applies native parameters automatically and cancellation/errors do not write', async t => {
  const f = await fixture(t); await f.add('service');
  const auth = await readFile(join(f.dir, 'auth.json'), 'utf8');
  const cache = await readFile(f.store.cachePath('service'), 'utf8');
  const registry = await readFile(f.store.registryPath, 'utf8');
  const requests = f.state.requests.length;
  f.state.selects.push(modelId, '模型参数');
  f.state.edits.push(JSON.stringify({ contextWindow: 240000, maxTokens: 100000, input: ['text', 'image'], reasoning: true, thinkingLevelMap: { max: 'max' }, compat: { supportsExplicitPromptCacheMode: false }, cost: { input: 1.2 } }));
  await f.run('model service');
  assert.equal(f.runtime.getModel('service', modelId)?.contextWindow, 240000);
  assert.equal(f.runtime.getModel('service', modelId)?.maxTokens, 100000);
  assert.equal(f.runtime.getModel('service', modelId)?.thinkingLevelMap?.max, 'max');
  const bytes = await readFile(join(f.dir, 'models.json'), 'utf8');
  for (const [value, error] of [[undefined, undefined], ['{', /有效 JSON/], ['{"maxTokens":-2}', /格式/], ['{"apiKey":"private-value"}', /只允许模型参数/]] as const) {
    f.state.selects.push(modelId, '模型参数'); f.state.edits.push(value); await f.run('model service', error);
    assert.equal(await readFile(join(f.dir, 'models.json'), 'utf8'), bytes);
  }
  f.state.selects.push(modelId); await f.run('info service');
  assert.match(f.state.views.at(-1)!, /上下文：240,000 tokens.*models.json/);
  assert.match(f.state.views.at(-1)!, /输入：1.2.*models.json/);
  assert(!f.state.views.at(-1)!.match(/enter submit|external editor|仅查看；关闭即可/));
  assert.equal(f.state.requests.length, requests, 'model edits and info are local only');
  assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), auth);
  assert.equal(await readFile(f.store.cachePath('service'), 'utf8'), cache);
  assert.equal(await readFile(f.store.registryPath, 'utf8'), registry);
});

test('Edit Model refuses an external file conflict and an invalid whole-file config before writing', async t => {
  const f = await fixture(t); await f.add('service');
  const path = join(f.dir, 'models.json');
  await atomicJson(path, { providers: {} });
  f.state.selects.push(modelId, '模型参数'); f.state.edits.push('{"maxTokens":4000}');
  f.state.onEditor = async () => atomicJson(path, { providers: { service: { modelOverrides: { [modelId]: { maxTokens: 8000 } } } } });
  await f.run('model service', /其他操作者修改/);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).providers.service.modelOverrides[modelId].maxTokens, 8000);
  f.state.onEditor = undefined;
  await atomicJson(path, { providers: { service: { modelOverrides: { [modelId]: { maxTokens: -2 } } }, another: { models: 'invalid' } } });
  const before = await readFile(path, 'utf8');
  f.state.selects.push(modelId, '模型参数'); f.state.edits.push('{"maxTokens":4000}');
  await f.run('model service', /格式/);
  assert.equal(await readFile(path, 'utf8'), before);
  const live = f.runtime.getModel('service', modelId)!;
  await f.run('refresh service', /格式/);
  assert.equal(f.runtime.getModel('service', modelId), live, 'invalid disk refresh leaves current model registry intact');
});

test('Edit Service defaults to cancel before probes; all failed probes preserve all saved state', async t => {
  const f = await fixture(t); await f.add('service');
  const files = [f.store.registryPath, f.store.cachePath('service'), join(f.dir, 'auth.json')];
  const before = await Promise.all(files.map(p => readFile(p, 'utf8')));
  f.state.inputs.push(''); f.state.secrets.push('');
  await f.run('edit service', /已取消/);
  assert.equal(f.state.prompts.at(-1)!.choices![0], '取消');
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
  f.state.onRequest = method => { f.state.status = method === 'POST' ? 503 : 200; return false; };
  await f.probe(/本次探测未成功/);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
  f.state.selects.push(modelId); await f.run('info service');
  assert.match(f.state.views.at(-1)!, /实际使用：openai-responses/);
});
