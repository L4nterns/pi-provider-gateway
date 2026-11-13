import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
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
    status: 200, requests: [] as string[], urls: [] as string[], requestBodies: [] as Row[], inputs: [] as (string | undefined)[], idle: true,
    progress: [] as string[], loader: undefined as any,
    onRequest: undefined as ((method: string, url?: string) => boolean | Promise<boolean>) | undefined,
    selects: [] as (string | undefined)[], secrets: [] as (string | undefined)[], edits: [] as (string | undefined)[], views: [] as string[],
    onEditor: undefined as (() => Promise<void>) | undefined,
    prompts: [] as { message: string; placeholder?: string; choices?: string[] }[],
    notices: [] as { message: string; kind: string }[], secretProviders: [] as string[][],
    onSecret: undefined as (() => Promise<void>) | undefined,
    onSelect: undefined as ((message: string) => Promise<void>) | undefined,
  };
  const server = createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      state.requests.push(req.method!); state.urls.push(req.url!);
      if (req.method === 'POST') state.requestBodies.push(JSON.parse(body));
      if (await state.onRequest?.(req.method!, req.url)) return;
      res.writeHead(state.status, { 'content-type': 'application/json' });
      const response = req.method !== 'POST' ? { data: state.catalog }
        : req.url?.endsWith('/responses') ? { object: 'response', output: [], status: 'completed' }
        : req.url?.endsWith('/messages') ? { type: 'message', content: [] }
        : req.url?.includes(':generateContent') ? { candidates: [{}] } : { choices: [{ message: {} }] };
      res.end(JSON.stringify(response));
    });
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
        state.prompts.push({ message, choices }); await state.onSelect?.(message); const requested = state.selects.shift();
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
  async function probe(error?: RegExp, id: string | null = modelId) {
    state.selects.push('协议诊断', id ? '单个模型' : '全部模型', ...(id ? [id] : []), '开始诊断');
    await run('edit service', error);
  }
  async function update(error?: RegExp) { state.selects.push('同步目录'); await run('edit service', error); }
  return { state, dir, root, store, runtime, registered, ctx, load, run, add, probe, update, command: () => command };
}

test('Gateway has only real actions and keeps risk warnings at the actual operation', async t => {
  const f = await fixture(t);
  await f.add('service');
  const auth = await readFile(join(f.dir, 'auth.json'), 'utf8');
  const requests = f.state.requests.length;
  await f.run('');
  const menu = f.state.prompts.findLast(p => p.message === 'Gateway')!;
  assert.deepEqual(menu.choices!.map(c => c.split('  ')[0]), ['添加服务', '管理服务', '刷新配置', '查看模型', '编辑模型', '删除服务']);
  assert(!menu.choices!.join('').match(/不管理|稳定 ID|返回|可能计费/));
  await f.run('edit service');
  assert.deepEqual(f.state.prompts.at(-1)!.choices!.map(c => c.split('  ')[0]), ['连接配置', '同步目录', '协议诊断']);
  f.state.selects.push('协议诊断', '单个模型', modelId, '取消'); await f.run('edit service');
  assert.equal(f.state.prompts.at(-1)!.choices![0], '取消');
  assert.match(f.state.prompts.at(-1)!.message, /最多 4 次请求，可能计费/);
  assert.equal(f.state.requests.length, requests, 'cancelled diagnostics needs neither a catalog fetch nor a generation probe');
  f.state.selects.push('取消'); await f.run('remove service');
  assert.equal(f.state.prompts.at(-1)!.choices![0], '取消');
  assert.equal(await readFile(join(f.dir, 'auth.json'), 'utf8'), auth);
});

test('persisted built-in provider IDs are rejected rather than shadowing native providers', async t => {
  const builtin = getBuiltinProviders()[0];
  assert(builtin);
  await assert.rejects(fixture(t, async (store, root) => {
    await store.put({ id: builtin, name: builtin, url: root }, null);
    await atomicJson(join(store.dir, 'auth.json'), { [builtin]: { type: 'api_key', key, env: { PI_GATEWAY_URL: root } } });
  }), new RegExp(`服务 ID「${builtin}」与 Pi 内置 provider 冲突`));
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
  f.state.selects.push(modelId, '协议偏好', 'openai-completions'); await f.run('model service');
  assert.equal(f.runtime.getModel('service', modelId)?.api, 'openai-completions');
  await f.run('refresh service');
  const promptStart = f.state.prompts.length;
  f.state.selects.push('管理服务', '连接配置', '保持当前设置'); f.state.inputs.push(''); f.state.secrets.push(''); await f.run('');
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
  f.state.selects.push('管理服务', 'two', '连接配置', '保持当前设置'); f.state.inputs.push(''); f.state.secrets.push('replacement-key');
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

test('protocol diagnosis reuses stored credentials and shows each of four native protocol steps', async t => {
  const f = await fixture(t);
  await f.add('service');
  f.state.progress.length = 0;
  const requestStart = f.state.requests.length, promptStart = f.state.prompts.length;
  await f.probe();
  const rendered = f.state.progress.join('\n');
  assert(!rendered.match(/读取模型目录|公开元数据/));
  assert(!f.state.prompts.slice(promptStart).some(p => p.message.includes('URL') || p.message.includes('API Key')));
  assert(!f.state.requests.slice(requestStart).includes('GET'));
  for (const [index, api] of ['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai'].entries()) {
    assert(rendered.includes(`（${index + 1}/4）：${api}`), rendered);
  }
  assert.match(rendered, /「Esc」取消/);
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

test('failed upstream catalog update dismisses the loader and preserves the last valid cache', async t => {
  const f = await fixture(t);
  await f.add('service'); const before = await readFile(f.store.cachePath('service'), 'utf8');
  f.state.status = 503; await f.update(/HTTP 503/);
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
    if (action === 'edit') f.state.selects.push('连接配置', '保持当前设置');
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
  f.state.selects.push(modelId, '协议偏好', 'openai-completions'); await f.run('model service');
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
  await f.update();
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

test('deletion rechecks the selected connection and credential after confirmation before native logout', async t => {
  for (const change of ['connection', 'credential']) await t.test(change, async t => {
    const f = await fixture(t); await f.add('service');
    const files = [f.store.registryPath, join(f.dir, 'auth.json'), f.store.cachePath('service')];
    let expected: string[] = [];
    f.state.onSelect = async message => {
      if (!message.startsWith('删除「service」')) return;
      if (change === 'connection') {
        const c = (await f.store.registry()).connections[0];
        await f.store.put({ ...c, protocol: 'openai-completions' }, c);
      } else await atomicJson(files[1], { service: { type: 'api_key', key: 'rotated-during-confirmation', env: { PI_GATEWAY_URL: f.root } } });
      expected = await Promise.all(files.map(p => readFile(p, 'utf8')));
    };
    f.state.selects.push('删除');
    await f.command().handler('remove service', f.ctx);
    assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8').catch(() => 'MISSING'))), expected, 'stale consent must not delete any current file or native credential');
    assert(f.state.notices.some(n => n.kind === 'error' && /服务或凭据已改变.*未删除/.test(n.message)));
    assert(f.registered.has('service'));
  });
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
  f.state.selects.push('连接配置'); f.state.inputs.push(f.root); f.state.secrets.push(undefined); await f.run('edit gateway', /取消/);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p, 'utf8'))), before);
  f.state.status = 401; f.state.selects.push('连接配置', '保持当前设置'); f.state.inputs.push(f.root); f.state.secrets.push('bad-key'); await f.run('edit gateway', /HTTP 401/);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p, 'utf8'))), before);
  assert(f.runtime.getModel('gateway', modelId));
  f.state.status = 200; f.state.inputs.push(''); f.state.secrets.push('new-key'); f.state.selects.push('连接配置', '保持当前设置'); await f.run('edit gateway');
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
  f.state.selects.push(modelId, '模型参数', '高级参数', '保存参数');
  f.state.edits.push(JSON.stringify({ contextWindow: 240000, maxTokens: 100000, input: ['text', 'image'], reasoning: true, thinkingLevelMap: { max: 'max' }, compat: { supportsExplicitPromptCacheMode: false }, cost: { input: 1.2 } }));
  await f.run('model service');
  assert.equal(f.runtime.getModel('service', modelId)?.contextWindow, 240000);
  assert.equal(f.runtime.getModel('service', modelId)?.maxTokens, 100000);
  assert.equal(f.runtime.getModel('service', modelId)?.thinkingLevelMap?.max, 'max');
  const bytes = await readFile(join(f.dir, 'models.json'), 'utf8');
  for (const [value, error] of [[undefined, undefined], ['{', /有效 JSON/], ['{"maxTokens":-2}', /格式/], ['{"apiKey":"private-value"}', /只允许模型参数/]] as const) {
    const start = f.state.notices.length;
    f.state.selects.push(modelId, '模型参数', '高级参数'); f.state.edits.push(value); await f.run('model service');
    if (error) assert.match(f.state.notices.slice(start).map(n => n.message).join('\n'), error);
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

test('field editor stages common model metadata, prices and cache values in one native save with no network', async t => {
  const f = await fixture(t); await f.add('service');
  const requests = f.state.requests.length;
  f.state.selects.push(modelId, '模型参数', '显示名称', '上下文窗口', '最大输出', '输入类型', '文本与图片', '思考能力', '支持思考', '价格', '输入', '缓存读取', undefined, '缓存时间', '短期缓存', undefined, '保存参数');
  f.state.inputs.push('My Model', '240000', '8192', '1.5', '0.1', '300');
  await f.run('model service');
  const override = JSON.parse(await readFile(join(f.dir, 'models.json'), 'utf8')).providers.service.modelOverrides[modelId];
  assert.deepEqual(override, { name: 'My Model', contextWindow: 240000, maxTokens: 8192, input: ['text', 'image'], reasoning: true, cost: { input: 1.5, cacheRead: 0.1 }, promptCache: { short: 300 } });
  assert.equal(f.runtime.getModel('service', modelId)?.name, 'My Model');
  assert.equal(f.runtime.getModel('service', modelId)?.contextWindow, 240000);
  assert.equal(f.state.requests.length, requests);
  assert(f.state.prompts.some(p => p.message === '模型参数 · 草稿未保存' && p.choices?.some(c => c.startsWith('上下文窗口  240000 · 覆盖'))));
});

test('field editor cancels drafts, validates bad values and restores auto without overwriting unrelated native fields', async t => {
  const f = await fixture(t); await f.add('service');
  const path = join(f.dir, 'models.json');
  await atomicJson(path, { providers: { service: { modelOverrides: { [modelId]: { contextWindow: 200000, headers: { 'X-Keep': 'synthetic-private-value' } }, other: { maxTokens: 1 } } } } });
  const before = await readFile(path, 'utf8');
  f.state.selects.push(modelId, '模型参数', '上下文窗口'); f.state.inputs.push('250000');
  await f.run('model service'); assert.equal(await readFile(path, 'utf8'), before);
  f.state.selects.push(modelId, '模型参数', '上下文窗口', '最大输出'); f.state.inputs.push('-3', '0');
  await f.run('model service'); assert.equal(await readFile(path, 'utf8'), before);
  assert(f.state.notices.filter(n => n.kind === 'warning').length >= 2);
  f.state.selects.push(modelId, '模型参数', '恢复自动', '保存参数'); await f.run('model service');
  const file = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(file.providers.service.modelOverrides, { [modelId]: { headers: { 'X-Keep': 'synthetic-private-value' } }, other: { maxTokens: 1 } });
  assert(!f.state.prompts.some(p => p.choices?.join('').includes('synthetic-private-value')));
});

test('reset and cleared fields preview native fallback values, not the former live overrides', async t => {
  for (const native of [false, true]) await t.test(native ? 'native model upsert' : 'gateway metadata', async t => {
    const f = await fixture(t); await f.add('service');
    const path = join(f.dir, 'models.json');
    await atomicJson(path, { providers: { service: { ...(native ? { baseUrl: f.root, models: [{ id: modelId, api: 'openai-responses', contextWindow: 91000, cost: { input: 7, output: 8, cacheRead: 1, cacheWrite: 2 } }] } : {}), modelOverrides: { [modelId]: { contextWindow: 200000, cost: { input: 99 } } } } } });
    await f.run('refresh service');
    const automatic = native ? 91000 : 272000;
    const before = await readFile(path, 'utf8'), requests = f.state.requests.length;
    f.state.selects.push(modelId, '模型参数', '恢复自动', '价格', undefined);
    await f.run('model service');
    assert.equal(await readFile(path, 'utf8'), before, 'reset is still a cancellable draft');
    const menus = f.state.prompts.filter(p => p.message === '模型参数 · 草稿未保存');
    assert(menus[0].choices!.includes('上下文窗口  200000 · 覆盖'));
    assert(menus[1].choices!.includes(`上下文窗口  ${automatic} · 自动`));
    assert(!f.state.prompts.findLast(p => p.message.startsWith('价格 ·'))!.choices!.some(c => c.includes('99')));
    f.state.selects.push(modelId, '模型参数', '上下文窗口', '保存参数'); f.state.inputs.push('');
    await f.run('model service');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).providers.service.modelOverrides[modelId].contextWindow, undefined, 'empty input restores this field instead of pinning the placeholder');
    assert.equal(f.runtime.getModel('service', modelId)?.contextWindow, automatic);
    assert.equal(f.state.requests.length, requests);
  });
});

test('Edit Model refuses an external file conflict and an invalid whole-file config before writing', async t => {
  const f = await fixture(t); await f.add('service');
  const path = join(f.dir, 'models.json');
  await atomicJson(path, { providers: {} });
  f.state.selects.push(modelId, '模型参数', '高级参数', '保存参数'); f.state.edits.push('{"maxTokens":4000}');
  f.state.onEditor = async () => atomicJson(path, { providers: { service: { modelOverrides: { [modelId]: { maxTokens: 8000 } } } } });
  await f.run('model service', /其他操作者修改/);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).providers.service.modelOverrides[modelId].maxTokens, 8000);
  f.state.onEditor = undefined;
  await atomicJson(path, { providers: { service: { modelOverrides: { [modelId]: { maxTokens: -2 } } }, another: { models: 'invalid' } } });
  const before = await readFile(path, 'utf8');
  f.state.selects.push(modelId, '模型参数', '高级参数', '保存参数'); f.state.edits.push('{"maxTokens":4000}');
  await f.run('model service', /格式/);
  assert.equal(await readFile(path, 'utf8'), before);
  const live = f.runtime.getModel('service', modelId)!;
  await f.run('refresh service', /格式/);
  assert.equal(f.runtime.getModel('service', modelId), live, 'invalid disk refresh leaves current model registry intact');
});

test('upstream catalog update uses existing credentials, publishes unknown/empty catalogs, and never writes connection data', async t => {
  const f = await fixture(t); await f.add('service');
  const files = [f.store.registryPath, join(f.dir, 'auth.json'), join(f.dir, 'models.json'), join(f.dir, 'sessions/keep.jsonl')];
  await atomicJson(files[2], { providers: { service: { modelOverrides: { [modelId]: { contextWindow: 240000 } } } } });
  await atomicJson(files[3], { synthetic: 'keep-history' });
  const before = await Promise.all(files.map(p => readFile(p, 'utf8')));
  const prompts = f.state.prompts.length, requests = f.state.requests.length, secrets = f.state.secretProviders.length;
  f.state.catalog.push({ id: 'unknown-protocol-model' });
  await f.update();
  assert.deepEqual(f.state.requests.slice(requests), ['GET']);
  assert.equal(f.state.secretProviders.length, secrets);
  assert(!f.state.prompts.slice(prompts).some(p => p.message.includes('URL') || p.message.includes('API Key')));
  assert.equal(f.runtime.getModel('service', modelId)?.contextWindow, 240000);
  assert.equal(f.runtime.getModel('service', 'unknown-protocol-model'), undefined);
  assert.match(f.state.notices.at(-1)!.message, /1 个可用模型，1 个协议待确认/);
  const cached = JSON.parse(await readFile(f.store.cachePath('service'), 'utf8'));
  assert(cached.discovery.rows.some((r: Row) => r.id === 'unknown-protocol-model'));
  f.state.selects.push('协议诊断', '单个模型'); await f.run('edit service');
  assert(f.state.prompts.at(-1)!.choices!.includes('unknown-protocol-model'), 'unknown models are selectable without registering or re-entering credentials');
  f.state.catalog = []; await f.update();
  assert.equal(f.runtime.getModels().filter(m => m.provider === 'service').length, 0);
  assert.deepEqual(JSON.parse(await readFile(f.store.cachePath('service'), 'utf8')).discovery.rows, []);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
});

test('connection edits keep service/model protocol controls but never include paid diagnosis', async t => {
  const f = await fixture(t); await f.add('service');
  f.state.selects.push(modelId, '协议偏好', 'anthropic-messages'); await f.run('model service');
  for (const selection of ['openai-completions', '自动']) {
    f.state.inputs.push(''); f.state.secrets.push('replacement-key');
    f.state.selects.push('连接配置', selection); await f.run('edit service');
    const c = (await f.store.registry()).connections[0];
    assert.equal(c.protocol, selection === '自动' ? undefined : selection);
    assert.equal(c.modelProtocols?.[modelId], 'anthropic-messages');
    assert.equal(f.runtime.getModel('service', modelId)?.api, 'anthropic-messages');
  }
  // A changed connection with unknown protocols can be saved, then diagnosed as
  // a separate task. Do not force a paid probe or silently guess an API.
  f.state.catalog = [{ id: 'unknown-protocol-model' }];
  f.state.inputs.push(''); f.state.secrets.push('another-key'); f.state.selects.push('连接配置', '保持当前设置');
  await f.run('edit service');
  assert.equal(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')).service.key, 'another-key');
  assert.equal(f.runtime.getModels().filter(m => m.provider === 'service').length, 0);
  assert.match(f.state.notices.at(-1)!.message, /协议待确认/);
  assert(f.state.requests.every(m => m === 'GET'));
  await f.probe(undefined, 'unknown-protocol-model');
  assert(f.runtime.getModel('service', 'unknown-protocol-model'));
});

test('single-model diagnosis freezes the consented scope, keeps other evidence/catalog age, and preserves native protocol overrides', async t => {
  const f = await fixture(t, async (store, root) => {
    await atomicJson(join(store.dir, 'models.json'), { providers: { service: { baseUrl: root, models: [{ id: modelId, api: 'anthropic-messages' }] } } });
  });
  await f.add('service');
  f.state.catalog.push({ id: 'other-model', native_endpoints: ['/v1/responses'] }, { id: 'unknown-unselected' }); await f.update();
  const cache = JSON.parse(await readFile(f.store.cachePath('service'), 'utf8'));
  cache.checkedAt -= 10000;
  cache.discovery.protocols['other-model'] = ['openai-responses', 'google-generative-ai'];
  cache.discovery.evidence['other-model'] = 'probe';
  cache.discovery.protocols['unknown-unselected'] = []; cache.discovery.evidence['unknown-unselected'] = 'unknown';
  const otherProbe = { model: 'other-model', api: 'google-generative-ai', ok: true, status: 200 };
  cache.discovery.probes = [otherProbe];
  await f.store.save('service', cache);
  const files = [f.store.registryPath, join(f.dir, 'auth.json'), join(f.dir, 'models.json')];
  const before = await Promise.all(files.map(p => readFile(p, 'utf8')));
  const requests = f.state.requests.length, bodies = f.state.requestBodies.length;
  f.state.onSelect = async message => { if (message.includes('最多 4 次请求')) f.state.catalog.push({ id: 'not-in-consent' }); };
  await f.probe();
  assert.deepEqual(f.state.requests.slice(requests), ['POST', 'POST', 'POST', 'POST']);
  assert(f.state.requestBodies.slice(bodies).every(body => body.model === undefined || body.model === modelId));
  assert(f.state.urls.at(-1)!.includes(encodeURIComponent(modelId)));
  const saved = JSON.parse(await readFile(f.store.cachePath('service'), 'utf8'));
  assert.equal(saved.checkedAt, cache.checkedAt, 'diagnosis does not pretend that the upstream catalog was refreshed');
  assert.deepEqual(saved.discovery.rows, cache.discovery.rows);
  assert.deepEqual(saved.discovery.protocols['other-model'], cache.discovery.protocols['other-model']);
  assert.equal(saved.discovery.evidence['other-model'], 'probe');
  assert.deepEqual(saved.discovery.protocols['unknown-unselected'], []);
  assert.equal(saved.discovery.evidence['unknown-unselected'], 'unknown');
  assert.deepEqual(saved.discovery.probes.filter((r: Row) => r.model === 'other-model'), [otherProbe]);
  assert.equal(saved.discovery.probes.filter((r: Row) => r.model === modelId).length, 4);
  assert.equal(f.runtime.getModel('service', modelId)?.api, 'anthropic-messages');
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
});

test('all-model diagnosis is bounded by cached consent; cancellation settles every worker before returning', async t => {
  for (const cancel of [false, true]) await t.test(cancel ? 'cancel' : 'success', async t => {
    const f = await fixture(t); await f.add('service');
    f.state.catalog = Array.from({ length: cancel ? 8 : 2 }, (_, i) => ({ id: `${modelId}-${i}`, native_endpoints: ['/v1/responses'] }));
    await f.update();
    const files = [f.store.registryPath, join(f.dir, 'auth.json'), f.store.cachePath('service')];
    const before = await Promise.all(files.map(p => readFile(p, 'utf8')));
    let started = 0;
    const nativeFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === 'POST') started++;
      return nativeFetch(...args);
    });
    const requests = f.state.requests.length;
    f.state.onSelect = async message => { if (message.includes('最多')) f.state.catalog.push({ id: 'not-in-consent' }); };
    f.state.onRequest = method => { if (method === 'POST' && cancel) { f.state.loader.handleInput('\x1b'); return true; } return false; };
    await f.probe(cancel ? /已取消 Gateway 操作/ : undefined, null);
    const atReturn = started;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(started, atReturn, 'no fetch starts after cancellation/command completion');
    assert(f.state.requests.slice(requests).every(m => m === 'POST'));
    assert.equal(f.state.loader, undefined);
    if (cancel) {
      assert(started > 0 && started <= 3);
      assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
      f.state.selects.push(modelId + '-0'); await f.run('info service');
    } else {
      assert.equal(started, 8);
      assert.match(f.state.progress.join('\n'), /8\/8/);
      assert.deepEqual(await Promise.all(files.slice(0, 2).map(p => readFile(p, 'utf8'))), before.slice(0, 2));
    }
  });
});

test('diagnosis cancellation at every selection step is local and preserves all saved bytes', async t => {
  const f = await fixture(t); await f.add('service');
  const files = [f.store.registryPath, join(f.dir, 'auth.json'), f.store.cachePath('service')];
  const before = await Promise.all(files.map(p => readFile(p, 'utf8'))), requests = f.state.requests.length;
  for (const choices of [[], ['协议诊断'], ['协议诊断', '单个模型'], ['协议诊断', '单个模型', modelId], ['协议诊断', '全部模型', '取消']]) {
    f.state.selects.push(...choices); await f.run('edit service');
    assert.equal(f.state.requests.length, requests);
    assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
  }
  const consent = f.state.prompts.at(-1)!;
  assert.equal(consent.choices![0], '取消');
  assert.match(consent.message, /最多 4 次请求，可能计费/);
  assert.match(consent.choices![1], /费用无法撤销/);
});

test('catalog updates and diagnoses reject stale connections or credentials before committing results', async t => {
  for (const task of ['同步目录', '协议诊断']) for (const change of ['connection', 'credential']) await t.test(`${task}/${change}`, async t => {
    const f = await fixture(t); await f.add('service');
    const before = await readFile(f.store.cachePath('service'), 'utf8');
    let changed = false;
    f.state.onRequest = async () => {
      if (!changed) {
        changed = true;
        if (change === 'connection') {
          const c = (await f.store.registry()).connections[0]; await f.store.put({ ...c, protocol: 'openai-completions' }, c);
        } else await atomicJson(join(f.dir, 'auth.json'), { service: { type: 'api_key', key: 'rotated', env: { PI_GATEWAY_URL: f.root } } });
      }
      return false;
    };
    const error = change === 'connection' ? /其他会话修改.*未写入/ : /凭据已改变.*未写入/;
    if (task === '同步目录') await f.update(error); else await f.probe(error);
    assert.equal(await readFile(f.store.cachePath('service'), 'utf8'), before);
    assert.equal(f.state.loader, undefined);
  });
});

test('a credential change after model selection prevents any generation request', async t => {
  const f = await fixture(t); await f.add('service');
  const before = await readFile(f.store.cachePath('service'), 'utf8'), requests = f.state.requests.length;
  f.state.onSelect = async message => {
    if (message.includes('最多')) await atomicJson(join(f.dir, 'auth.json'), { service: { type: 'api_key', key: 'rotated', env: { PI_GATEWAY_URL: f.root } } });
  };
  await f.probe(/目录或凭据已变化/);
  assert.equal(f.state.requests.length, requests);
  assert.equal(await readFile(f.store.cachePath('service'), 'utf8'), before);
});

test('missing cache or credentials requires an explicit repair task, never implicit fetch/login', async t => {
  const f = await fixture(t); await f.add('service');
  const requests = f.state.requests.length, prompts = f.state.prompts.length, secrets = f.state.secretProviders.length;
  const live = f.runtime.getModel('service', modelId);
  await rm(f.store.cachePath('service'));
  f.state.selects.push('协议诊断'); await f.run('edit service');
  assert.match(f.state.notices.at(-1)!.message, /暂无模型目录.*同步目录/);
  await atomicJson(join(f.dir, 'auth.json'), {});
  await f.update(/缺少 URL 或凭据.*连接配置/);
  assert.equal(f.state.requests.length, requests);
  assert.equal(f.state.secretProviders.length, secrets);
  assert(!f.state.prompts.slice(prompts).some(p => p.message.includes('API Key') || p.message.includes('服务 URL')));
  assert.equal(f.runtime.getModel('service', modelId), live);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'auth.json'), 'utf8')), {});
  await assert.rejects(readFile(f.store.cachePath('service')), { code: 'ENOENT' });
});

test('upstream update cancellation and offline service tasks never auto-login or damage the live registry', async t => {
  const f = await fixture(t); await f.add('service');
  const files = [f.store.registryPath, join(f.dir, 'auth.json'), f.store.cachePath('service')];
  const before = await Promise.all(files.map(p => readFile(p, 'utf8')));
  const live = f.runtime.getModel('service', modelId);
  f.state.onRequest = () => { f.state.loader.handleInput('\x1b'); return true; };
  await f.update(/已取消 Gateway 操作/);
  assert.equal(f.runtime.getModel('service', modelId), live);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
  process.env.PI_OFFLINE = '1'; await f.load();
  const requests = f.state.requests.length, prompts = f.state.secretProviders.length;
  for (const task of ['连接配置', '同步目录', '协议诊断']) {
    f.state.selects.push(task); await f.run('edit service', /离线模式.*本地.*刷新配置/);
  }
  await f.run('refresh service');
  assert.equal(f.state.requests.length, requests);
  assert.equal(f.state.secretProviders.length, prompts);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
});

test('Edit Service starts no work until a task is chosen; all failed diagnostics preserve saved state', async t => {
  const f = await fixture(t); await f.add('service');
  const files = [f.store.registryPath, f.store.cachePath('service'), join(f.dir, 'auth.json')];
  const before = await Promise.all(files.map(p => readFile(p, 'utf8')));
  const requests = f.state.requests.length;
  await f.run('edit service');
  assert.equal(f.state.prompts.at(-1)!.choices!.length, 3);
  assert.equal(f.state.requests.length, requests);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
  f.state.onRequest = method => { f.state.status = method === 'POST' ? 503 : 200; return false; };
  await f.probe(/本次探测未成功/);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, 'utf8'))), before);
  f.state.selects.push(modelId); await f.run('info service');
  assert.match(f.state.views.at(-1)!, /实际使用：openai-responses/);
});

test('connection validation cannot overwrite credentials changed while its request is in flight', async t => {
  const f = await fixture(t); await f.add('service');
  const registry = await readFile(f.store.registryPath, 'utf8'), cache = await readFile(f.store.cachePath('service'), 'utf8');
  const authPath = join(f.dir, 'auth.json');
  f.state.onRequest = async () => {
    await atomicJson(authPath, { service: { type: 'api_key', key: 'rotated-during-validation', env: { PI_GATEWAY_URL: f.root } } });
    return false;
  };
  f.state.inputs.push(''); f.state.secrets.push(''); f.state.selects.push('连接配置', '保持当前设置');
  await f.run('edit service', /凭据已改变.*未写入/);
  assert.equal(JSON.parse(await readFile(authPath, 'utf8')).service.key, 'rotated-during-validation');
  assert.equal(await readFile(f.store.registryPath, 'utf8'), registry);
  assert.equal(await readFile(f.store.cachePath('service'), 'utf8'), cache);
});
