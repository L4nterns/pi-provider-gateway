import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, cp, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Store, atomicJson } from '../src/storage.ts';
import { fingerprint } from '../src/discovery.ts';

const script = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).stdout.trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test('standalone native Pi separates connection, catalog update and consented model diagnosis', { skip: !script, timeout: 40000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-native-service-'));
  const packageDir = join(dir, 'standalone-package'), agent = join(dir, 'agent');
  const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  const id = 'gpt-6.1-sol', key = 'FAKE-NATIVE-SERVICE-KEY';
  const requests: { method: string; url: string; body: Record<string, unknown> }[] = [];
  let hold = false;
  let stop = async () => {};
  const rows = [id, id + '-other'].map(id => ({ id, native_endpoints: ['/v1/responses'] }));
  const server = createServer((req, res) => {
    let text = ''; req.setEncoding('utf8'); req.on('data', data => text += data);
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, body: text ? JSON.parse(text) : {} });
      if (hold && req.method === 'POST') return;
      res.setHeader('content-type', 'application/json');
      const body = req.method !== 'POST' ? { data: rows }
        : req.url!.endsWith('/responses') ? { object: 'response', output: [], status: 'completed' }
        : req.url!.endsWith('/messages') ? { type: 'message', content: [] }
        : req.url!.includes(':generateContent') ? { candidates: [{}] } : { choices: [{ message: {} }] };
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await stop();
    await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
    await rm(dir, { recursive: true, force: true });
  });
  await cp(resolve('src'), join(packageDir, 'src'), { recursive: true });
  await copyFile(resolve('package.json'), join(packageDir, 'package.json'));
  const version = JSON.parse(await readFile(resolve('node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
  const store = new Store(agent);
  await store.put({ id: 'demo', name: 'demo', url: root }, null);
  await atomicJson(join(agent, 'auth.json'), { demo: { type: 'api_key', key, env: { PI_GATEWAY_URL: root } } });
  await store.save('demo', { version: 1, checkedAt: Date.now(), fingerprint: fingerprint(root, key), discovery: {
    rows, protocols: Object.fromEntries(rows.map(r => [r.id, ['openai-responses']])), evidence: Object.fromEntries(rows.map(r => [r.id, 'endpoint'])), probes: [],
  } });
  await atomicJson(join(agent, 'cache/gateway/models-dev.json'), { checkedAt: Date.now(), data: {} });
  await atomicJson(join(agent, 'models.json'), { providers: { demo: { modelOverrides: { [id]: { compat: { supportsExplicitPromptCacheMode: false } } } } } });
  await atomicJson(join(agent, 'sessions/keep.jsonl'), { synthetic: 'keep-history' });
  await atomicJson(join(agent, 'settings.json'), { quietStartup: true, enableAnalytics: false, lastChangelogVersion: version, defaultProvider: 'demo', defaultModel: id, extensions: ['-builtin:mcp', '-builtin:codemode', '-builtin:tool_search'] });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TERM: 'xterm-256color', PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(dir, 'history'), PI_SKIP_VERSION_CHECK: '1', NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1' };
  delete env.TMUX; delete env.PI_OFFLINE;
  const installed = spawnSync(process.execPath, [cli, 'install', packageDir], { cwd: dir, env: { ...env, PI_OFFLINE: '1' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(installed.status, 0, installed.stderr);
  const protectedFiles = [store.registryPath, join(agent, 'auth.json'), join(agent, 'models.json'), join(agent, 'sessions/keep.jsonl')];
  const before = await Promise.all(protectedFiles.map(file => readFile(file, 'utf8')));
  // This real CLI scenario is online only to the synthetic loopback server.
  // Block every other fetch in the child and count starts, not late arrivals.
  const guard = join(dir, 'loopback-only.mjs'), fetchLog = join(dir, 'fetch-starts.log');
  await writeFile(fetchLog, '');
  await writeFile(guard, `import { appendFileSync } from 'node:fs';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== ${JSON.stringify(root)}) return Promise.reject(new Error('External fetch disabled by test'));
  appendFileSync(${JSON.stringify(fetchLog)}, (init?.method ?? 'GET') + ' ' + url.pathname + '\\n');
  return nativeFetch(input, init);
};\n`);
  const command = `stty rows 35 cols 115; exec ${[process.execPath, '--import', pathToFileURL(guard).href, cli, '--no-skills', '--no-themes', '--no-prompt-templates', '--no-context-files'].map(quote).join(' ')}`;
  const proc = spawn(script, ['--quiet', '--return', '--flush', '--command', command, '/dev/null'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', ended = false;
  const collect = (data: string) => {
    output += data;
    if (data.includes('\x1b[6n')) proc.stdin.write('\x1b[1;1R');
    if (data.includes('\x1b[c')) proc.stdin.write('\x1b[?1;2c');
  };
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', collect); proc.stderr.on('data', collect); proc.stdin.on('error', () => {});
  const exit = new Promise<number | null>(done => proc.on('close', code => { ended = true; done(code); }));
  stop = async () => { if (!ended) { proc.kill('SIGTERM'); await exit; } };
  async function wait(check: () => boolean) {
    for (let i = 0; i < 600 && !check() && !ended; i++) await sleep(20);
    assert(check(), output);
  }
  async function open() {
    const start = output.length; proc.stdin.write('/gateway edit demo\r');
    await wait(() => ['连接配置', '同步目录', '协议诊断'].every(s => output.slice(start).includes(s)));
    assert(!output.slice(start).includes('返回'));
    return start;
  }
  async function selectDiagnosis(all = false) {
    const start = await open(); proc.stdin.write('\x1b[B\x1b[B\r');
    await wait(() => output.slice(start).includes('选择范围'));
    proc.stdin.write(all ? '\x1b[B\r' : '\r');
    if (!all) { await wait(() => output.slice(start).includes('协议诊断 · 选择模型')); proc.stdin.write('\r'); }
    await wait(() => output.slice(start).includes(`最多 ${all ? 8 : 4} 次请求，可能计费`));
    assert(!output.slice(start).includes('服务 URL') && !output.slice(start).includes('API Key'));
    assert(output.slice(start).includes('费用无法撤销'));
    return start;
  }
  await wait(() => output.includes(id) && output.includes('\x1b]0;'));
  assert.equal(requests.length, 0, 'cached startup does not contact the upstream');
  let start = await open(); proc.stdin.write('\r');
  await wait(() => output.slice(start).includes('服务 URL'));
  proc.stdin.write('\x1b'); await sleep(150);
  assert.equal(requests.length, 0, 'cancel connection before changing credentials');
  start = await open(); proc.stdin.write('\x1b[B\r');
  await wait(() => output.slice(start).includes('上游目录已更新'));
  assert.deepEqual(requests.map(r => r.method), ['GET']);
  const updated = await readFile(store.cachePath('demo'), 'utf8');
  await selectDiagnosis(); proc.stdin.write('\r'); await sleep(180); // Cancel is the default.
  assert.equal(requests.length, 1);
  assert.equal(await readFile(store.cachePath('demo'), 'utf8'), updated);
  start = await selectDiagnosis(); proc.stdin.write('\x1b[B\r');
  await wait(() => output.slice(start).includes('协议诊断已完成'));
  assert.equal(requests.filter(r => r.method === 'POST').length, 4);
  assert(requests.filter(r => r.method === 'POST').every(r => r.body.model === id || r.url.includes(`/${id}:generateContent`)));
  assert.equal(requests.filter(r => r.method === 'GET').length, 1, 'diagnosis never fetches a new catalog');
  const diagnosed = await readFile(store.cachePath('demo'), 'utf8');
  start = await selectDiagnosis(true); hold = true; proc.stdin.write('\x1b[B\r');
  await wait(() => requests.filter(r => r.method === 'POST').length > 4);
  await wait(() => output.slice(start).includes('探测 '));
  proc.stdin.write('\x1b');
  await wait(() => output.slice(start).includes('已取消 Gateway 操作'));
  const atReturn = await readFile(fetchLog, 'utf8'); await sleep(120);
  assert.equal(await readFile(fetchLog, 'utf8'), atReturn, 'all workers settle without new fetches after command returns');
  assert(requests.filter(r => r.method === 'POST').length <= 6);
  assert.equal(await readFile(store.cachePath('demo'), 'utf8'), diagnosed);
  start = await open(); proc.stdin.write('\x1b'); await sleep(150); // Busy flag was released.
  assert(!output.slice(start).includes('已有 Gateway 操作'));
  assert.deepEqual(await Promise.all(protectedFiles.map(file => readFile(file, 'utf8'))), before);
  assert(!output.includes(key)); assert(!output.includes('Failed to load extension')); assert(!output.includes('Startup is still in progress'));
  proc.stdin.write('\x04'); await wait(() => ended);
  assert.equal(await exit, 0, output);
});
