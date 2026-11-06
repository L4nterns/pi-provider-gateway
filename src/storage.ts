import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeUrl } from './discovery.ts';
import { PROTOCOLS, record, type Connection, type Registry, type Row, type Snapshot } from './types.ts';

export async function readJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error(`无法读取配置文件 ${path}（未修改原文件）`); }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const f = await open(tmp, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify(value, null, 2) + '\n'); await f.sync(); } finally { await f.close(); }
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}
// Cross-process read/modify/write; abandoned locks recover only when their owner is dead.
export async function locked<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.gateway-lock`; const start = Date.now();
  for (;;) {
    try {
      const f = await open(lock, 'wx', 0o600); await f.writeFile(String(process.pid)); await f.close(); break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const pid = Number(await readFile(lock, 'utf8')); const age = Date.now() - (await stat(lock)).mtimeMs;
        if (pid > 0) { try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') await rm(lock, { force: true }); } }
        else if (age > 30000) await rm(lock, { force: true });
      } catch { /* Owner may just have released it. */ }
      if (Date.now() - start > 5000) throw new Error('配置正在被另一个 Pi 修改，请稍后重试');
      await sleep(25);
    }
  }
  try { return await fn(); } finally { await rm(lock, { force: true }); }
}
export const connectionId = (x: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x);
export function parseRegistry(value: unknown): Registry {
  if (value === undefined) return { version: 1, connections: [] };
  const root = record(value);
  if (root?.version !== 1 || !Array.isArray(root.connections)) throw new Error('gateway.json 格式不正确（未覆盖）');
  const connections: Connection[] = []; const ids = new Set<string>();
  for (const v of root.connections) {
    const c = record(v);
    if (!c || typeof c.id !== 'string' || !connectionId(c.id) || ids.has(c.id) || typeof c.name !== 'string') throw new Error('无效或重复的服务 ID');
    ids.add(c.id);
    if (c.protocol !== undefined && !PROTOCOLS.includes(c.protocol as never)) throw new Error('无效协议');
    const modelProtocols = record(c.modelProtocols);
    if (c.modelProtocols !== undefined && (!modelProtocols || Object.values(modelProtocols).some(p => !PROTOCOLS.includes(p as never)))) throw new Error('无效的模型协议覆盖');
    connections.push({ id: c.id, name: c.name, ...(typeof c.url === 'string' ? { url: normalizeUrl(c.url) } : {}), ...(c.protocol ? { protocol: c.protocol as Connection['protocol'] } : {}), ...(modelProtocols ? { modelProtocols: modelProtocols as Connection['modelProtocols'] } : {}) });
  }
  return { version: 1, connections };
}
export class Store {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }
  get registryPath() { return join(this.dir, 'gateway.json'); }
  async registry(): Promise<Registry> { return parseRegistry(await readJson(this.registryPath)); }
  async put(c: Connection, expected?: Connection | null): Promise<void> {
    await locked(this.registryPath, async () => {
      const registry = await this.registry(); const old = registry.connections.find(x => x.id === c.id);
      if (expected === null && old || expected && JSON.stringify(old) !== JSON.stringify(expected)) throw new Error('服务已被其他会话修改，请重新打开菜单');
      registry.connections = [...registry.connections.filter(x => x.id !== c.id), c];
      await atomicJson(this.registryPath, registry);
    });
  }
  async remove(c: Connection): Promise<void> {
    await locked(this.registryPath, async () => {
      const registry = await this.registry();
      if (JSON.stringify(registry.connections.find(x => x.id === c.id)) !== JSON.stringify(c)) throw new Error('服务已被其他会话修改');
      registry.connections = registry.connections.filter(x => x.id !== c.id); await atomicJson(this.registryPath, registry);
    });
    await rm(this.cachePath(c.id), { force: true });
  }
  cachePath(id: string) { if (!connectionId(id)) throw new Error('无效服务 ID'); return join(this.dir, 'cache', 'gateway', `${id}.json`); }
  async snapshot(id: string, binding: string): Promise<Snapshot | undefined> {
    let raw: unknown;
    try { raw = await readJson(this.cachePath(id)); } catch { return undefined; }
    const s = record(raw); const d = record(s?.discovery);
    if (s?.version !== 1 || s.fingerprint !== binding || typeof s.checkedAt !== 'number' || !Array.isArray(d?.rows) || !record(d.protocols) || !record(d.evidence)) return undefined;
    // Cache rows are parsed again by the same decoder as live data.
    return s as unknown as Snapshot;
  }
  async save(id: string, value: Snapshot): Promise<void> { await locked(this.cachePath(id), () => atomicJson(this.cachePath(id), value)); }
}
const FIELDS = new Set(['id','name','display_name','contextWindow','context_window','context_length','max_input_tokens','maxTokens','max_tokens','max_output_tokens','max_completion_tokens','inputTokenLimit','outputTokenLimit','input','input_modalities','output_modalities','reasoning','supports_reasoning','thinking','image_input','supports_vision','supported_reasoning_levels','reasoning_levels','thinking_levels','native_endpoints','supported_endpoint_types','supportedGenerationMethods','api','endpoints']);
const NESTED: Record<string, string[]> = { limit: ['context','input','output'], limits: ['context','context_window','max_output_tokens'], modalities: ['input','output'], architecture: ['input_modalities','output_modalities'], capabilities: ['reasoning','vision','supported_reasoning_levels'] };
export function metadataOnly(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (FIELDS.has(k)) out[k] = v;
    else if (NESTED[k] && record(v)) out[k] = Object.fromEntries(Object.entries(v as Row).filter(([key]) => NESTED[k].includes(key)));
  }
  return out;
}
