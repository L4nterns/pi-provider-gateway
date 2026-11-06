import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, cp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Store, atomicJson } from '../src/storage.ts';
import { fingerprint } from '../src/discovery.ts';

const script = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).stdout.trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test('distributed package opens a concise native Pi menu; Escape and first-item Enter both return without mutations', { skip: !script, timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-native-menu-'));
  const packageDir = join(dir, 'standalone-package'), agent = join(dir, 'agent');
  const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  await cp(resolve('src'), join(packageDir, 'src'), { recursive: true });
  await copyFile(resolve('package.json'), join(packageDir, 'package.json'));
  const version = JSON.parse(await readFile(resolve('node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
  const store = new Store(agent), root = 'https://example.test', id = 'gpt-6.1-sol', key = 'FAKE-NATIVE-MENU-KEY';
  await store.put({ id: 'demo', name: 'demo', url: root }, null);
  await atomicJson(join(agent, 'auth.json'), { demo: { type: 'api_key', key, env: { PI_GATEWAY_URL: root } } });
  await store.save('demo', { version: 1, checkedAt: Date.now(), fingerprint: fingerprint(root, key), discovery: {
    rows: [{ id, native_endpoints: ['/v1/responses'] }], protocols: { [id]: ['openai-responses'] }, evidence: { [id]: 'endpoint' }, probes: [],
  } });
  await atomicJson(join(agent, 'settings.json'), { quietStartup: true, enableAnalytics: false, lastChangelogVersion: version, defaultProvider: 'demo', defaultModel: id, extensions: ['-builtin:mcp', '-builtin:codemode', '-builtin:tool_search'] });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TERM: 'xterm-256color', PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(dir, 'history'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1' };
  delete env.TMUX; // This scenario tests native menus, not the caller's live tmux.
  const installed = spawnSync(process.execPath, [cli, 'install', packageDir], { cwd: dir, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(installed.status, 0, installed.stderr);
  const before = await Promise.all([store.registryPath, store.cachePath('demo'), join(agent, 'auth.json')].map(file => readFile(file, 'utf8')));
  const command = `stty rows 35 cols 110; exec ${[process.execPath, cli, '--offline', '--no-skills', '--no-themes', '--no-prompt-templates', '--no-context-files'].map(quote).join(' ')}`;
  const proc = spawn(script, ['--quiet', '--return', '--flush', '--command', command, '/dev/null'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', ended = false;
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  const collect = (data: string) => {
    output += data;
    if (data.includes('\x1b[6n')) proc.stdin.write('\x1b[1;1R');
    if (data.includes('\x1b[c')) proc.stdin.write('\x1b[?1;2c');
  };
  proc.stdout.on('data', collect); proc.stderr.on('data', collect);
  proc.stdin.on('error', () => {});
  const exit = new Promise<number | null>(resolve => proc.on('close', code => { ended = true; resolve(code); }));
  t.after(async () => { if (!ended) { proc.kill('SIGTERM'); await exit; } await rm(dir, { recursive: true, force: true }); });
  async function wait(check: () => boolean) {
    for (let i = 0; i < 600 && !check() && !ended; i++) await sleep(20);
    assert(check(), output);
  }
  // The footer is painted before startup installs command handlers. The native
  // session title is emitted after extension binding and editor setup finish.
  await wait(() => output.includes('gpt-6.1-sol') && output.includes('\x1b]0;'));
  for (const cancel of ['\x1b', '\r']) {
    const start = output.length;
    proc.stdin.write('/gateway\r');
    await wait(() => output.slice(start).includes('添加服务') && output.slice(start).includes('删除服务'));
    const frame = output.slice(start);
    assert(frame.includes('返回'));
    assert(!frame.match(/账号、路由|不管理|不发出生成探测|创建稳定 ID/));
    proc.stdin.write(cancel); await sleep(150);
  }
  assert(!output.includes('Startup is still in progress'));
  assert(!output.includes('已有 Gateway 操作'));
  assert(!output.includes('Failed to load extension'));
  assert(!output.includes(key));
  assert.deepEqual(await Promise.all([store.registryPath, store.cachePath('demo'), join(agent, 'auth.json')].map(file => readFile(file, 'utf8'))), before);
  proc.stdin.write('\x04');
  await wait(() => ended);
  assert.equal(await exit, 0, output);
});
