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

test('distributed package uses action-only menus and a real read-only model viewer', { skip: !script, timeout: 30000 }, async t => {
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
  for (let i = 0; i < 2; i++) {
    const start = output.length;
    proc.stdin.write('/gateway\r');
    await wait(() => output.slice(start).includes('添加服务') && output.slice(start).includes('删除服务'));
    const frame = output.slice(start);
    assert(!frame.match(/返回|账号、路由|不管理|不发出生成探测|创建稳定 ID/));
    assert(frame.includes('编辑模型'));
    proc.stdin.write('\x1b'); await sleep(150);
  }
  const infoStart = output.length;
  proc.stdin.write('/gateway info demo\r');
  await wait(() => output.slice(infoStart).includes('查看模型') && output.slice(infoStart).includes(id));
  proc.stdin.write('\r');
  await wait(() => output.slice(infoStart).includes('生效参数'));
  const viewerStart = output.length;
  proc.stdin.write('\r\x07'); await sleep(150);
  proc.stdin.write('\x1b[6~');
  await wait(() => output.slice(infoStart).includes('价格'));
  const viewer = output.slice(infoStart);
  assert(!viewer.match(/enter submit|external editor|ctrl\+g|仅查看；关闭即可/));
  assert(viewer.includes('「Esc」返回'));
  assert(!output.slice(viewerStart).includes('Gateway\x1b'), 'Enter and Ctrl-G do not open an editor or close the viewer');
  proc.stdin.write('\x1b'); await sleep(150);
  const editStart = output.length;
  proc.stdin.write('/gateway model demo\r');
  await wait(() => output.slice(editStart).includes('编辑模型') && output.slice(editStart).includes(id));
  proc.stdin.write('\r');
  await wait(() => output.slice(editStart).includes('模型参数'));
  proc.stdin.write('\r');
  await wait(() => output.slice(editStart).includes('上下文窗口') && output.slice(editStart).includes('保存参数'));
  const unchangedStart = output.length;
  proc.stdin.write('\x1b[B\r');
  await wait(() => output.slice(unchangedStart).includes('上下文窗口 · 留空恢复自动'));
  const blankStart = output.length;
  proc.stdin.write('\r');
  await wait(() => output.slice(blankStart).includes('草稿未保存'));
  assert(!output.slice(blankStart).includes('272000 · 覆盖'), 'Enter submits an empty input, not its placeholder');
  const fieldsStart = output.length;
  proc.stdin.write('\x1b[B\r');
  await wait(() => output.slice(fieldsStart).includes('上下文窗口 · 留空恢复自动'));
  proc.stdin.write('240000\r');
  await wait(() => output.slice(fieldsStart).includes('240000 · 覆盖'));
  const advancedStart = output.length;
  proc.stdin.write('\x1b[B'.repeat(7) + '\r');
  await wait(() => output.slice(advancedStart).includes('原生参数覆盖') && output.slice(advancedStart).includes('submit'));
  const submittedStart = output.length;
  proc.stdin.write('\x15\x7f'.repeat(4) + '{"contextWindow":240000,"compat":{"supportsExplicitPromptCacheMode":false}}\r');
  await wait(() => output.slice(submittedStart).includes('草稿未保存'));
  const saveStart = output.length;
  proc.stdin.write('\x1b[B'.repeat(9));
  await wait(() => output.slice(saveStart).includes('保存参数'));
  proc.stdin.write('\r');
  await wait(() => output.slice(editStart).includes('模型已保存'));
  const config = JSON.parse(await readFile(join(agent, 'models.json'), 'utf8'));
  assert.equal(config.providers.demo.modelOverrides[id].contextWindow, 240000);
  assert.equal(config.providers.demo.modelOverrides[id].compat.supportsExplicitPromptCacheMode, false);
  const refreshedStart = output.length;
  proc.stdin.write('/gateway info demo\r');
  await wait(() => output.slice(refreshedStart).includes('查看模型'));
  proc.stdin.write('\r');
  await wait(() => output.slice(refreshedStart).includes('240,000 tokens'));
  assert(!output.slice(refreshedStart).includes('submit'));
  proc.stdin.write('\x1b'); await sleep(150);
  assert(!output.includes('Startup is still in progress'));
  assert(!output.includes('已有 Gateway 操作'));
  assert(!output.includes('Failed to load extension'));
  assert(!output.includes(key));
  assert.deepEqual(await Promise.all([store.registryPath, store.cachePath('demo'), join(agent, 'auth.json')].map(file => readFile(file, 'utf8'))), before);
  proc.stdin.write('\x04');
  await wait(() => ended);
  assert.equal(await exit, 0, output);
});
