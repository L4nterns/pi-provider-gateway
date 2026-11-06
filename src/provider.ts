import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProvider, type ProviderStreams, type Model, type ApiKeyCredential, type Provider, type ProviderAuthInteraction, type RefreshModelsContext } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { decodeRows, discover, fingerprint, normalizeUrl, requestJson } from './discovery.ts';
import { buildModels, builtinMetadata } from './metadata.ts';
import { atomicJson, metadataOnly, readJson, Store } from './storage.ts';
import { PROTOCOLS, record, type Connection, type Discovery, type GatewayModel, type Protocol, type Row, type Snapshot } from './types.ts';

const ROOT = 'PI_GATEWAY_URL';
const TTL = 60 * 60 * 1000;
export function credentialRoot(connection: Connection, credential?: ApiKeyCredential): string | undefined {
  const raw = credential?.env?.[ROOT] ?? connection.url;
  return raw ? normalizeUrl(raw) : undefined;
}
export async function storedCredential(dir: string, id: string): Promise<ApiKeyCredential | undefined> {
  try {
    const all = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'));
    const c = all[id];
    return c?.type === 'api_key' && typeof c.key === 'string' ? c : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('无法读取 Pi 凭据文件');
  }
}
function cachedDiscovery(s: Snapshot): Discovery {
  return { ...s.discovery, rows: decodeRows(s.discovery.rows).map(metadataOnly) };
}
export async function loadPublicCatalog(store: Store, signal: AbortSignal, allowNetwork: boolean): Promise<Row> {
  const path = join(store.dir, 'cache', 'gateway', 'models-dev.json');
  let cached: Row | undefined;
  try { cached = record(await readJson(path)); } catch { /* Metadata cache is disposable. */ }
  if (!allowNetwork || cached && typeof cached.checkedAt === 'number' && Date.now() - cached.checkedAt < 86400000) return record(cached?.data) ?? {};
  try {
    const raw = record(await requestJson('https://models.dev/api.json', { signal }, 20 * 1024 * 1024));
    if (!raw) return record(cached?.data) ?? {};
    // Retain only public capability fields, not arbitrary catalog objects.
    const data: Row = {};
    for (const [id, value] of Object.entries(raw)) {
      const models = record(record(value)?.models); if (!models) continue;
      data[id] = { models: Object.fromEntries(Object.entries(models).flatMap(([id, value]) => {
        const m = record(value); if (!m) return [];
        return [[id, Object.fromEntries(['name','reasoning','reasoning_options','limit','modalities','cost'].filter(k => m[k] !== undefined).map(k => [k, m[k]]))]];
      })) };
    }
    signal.throwIfAborted(); await atomicJson(path, { checkedAt: Date.now(), data }); return data;
  } catch { signal.throwIfAborted(); return record(cached?.data) ?? {}; }
}
// Public Pi exports also work without a node_modules directory beside the extension.
// Delegate stream methods only, never first-party authentication/catalog/refresh behavior.
function nativeApis(): Record<Protocol, ProviderStreams> {
  const hosts = new Map(builtinProviders().map(p => [p.id, p]));
  const owners: Record<Protocol, string> = { 'openai-responses': 'openai', 'openai-completions': 'openrouter', 'anthropic-messages': 'anthropic', 'google-generative-ai': 'google' };
  return Object.fromEntries(PROTOCOLS.map(api => {
    const host = hosts.get(owners[api]); if (!host) throw new Error(`当前 Pi 缺少协议实现：${api}`);
    return [api, { stream: host.stream.bind(host), streamSimple: host.streamSimple.bind(host) }];
  })) as Record<Protocol, ProviderStreams>;
}
const protocolApis = nativeApis();
export interface GatewayHandle {
  provider: Provider<Protocol>;
  initialize(signal: AbortSignal, allowNetwork: boolean): Promise<void>;
  login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>;
  dispose(): void;
  info(): { models: readonly GatewayModel[]; unknown: string[]; checkedAt: number };
}
export function createGateway(connection: Connection, store: Store): GatewayHandle {
  let models: GatewayModel[] = [];
  let snapshot: Snapshot | undefined;
  let disposed = false;
  const lifetime = new AbortController();
  const combined = (s: AbortSignal) => AbortSignal.any([s, lifetime.signal]);
  async function mapped(root: string, s: Snapshot, signal: AbortSignal, network: boolean): Promise<GatewayModel[]> {
    const needsPublic = s.discovery.rows.some(r => !builtinMetadata(String(r.id)));
    const catalog = needsPublic ? await loadPublicCatalog(store, signal, network) : {};
    return buildModels(connection, root, cachedDiscovery(s), catalog).map(m => ({ ...m, gateway: { ...m.gateway, binding: s.fingerprint } }));
  }
  async function restore(credential: ApiKeyCredential | undefined, signal: AbortSignal): Promise<string | undefined> {
    const root = credentialRoot(connection, credential);
    if (!root || !credential?.key) { models = []; snapshot = undefined; return undefined; }
    const binding = fingerprint(root, credential.key);
    if (snapshot?.fingerprint !== binding) {
      models = []; snapshot = await store.snapshot(connection.id, binding);
      if (snapshot) models = await mapped(root, snapshot, signal, false);
    }
    return root;
  }
  async function fresh(root: string, key: string, signal: AbortSignal, probe: boolean): Promise<Snapshot> {
    const discovery = await discover(root, key, signal, { probe, previous: snapshot?.fingerprint === fingerprint(root, key) ? snapshot.discovery : undefined });
    return { version: 1, fingerprint: fingerprint(root, key), checkedAt: Date.now(), discovery: { ...discovery, rows: discovery.rows.map(metadataOnly) } };
  }
  const login = async (interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> => {
    if (/^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? '')) throw new Error('离线模式不能验证登录；未发出网络请求');
    const signal = combined(interaction.signal);
    const expectedConnection = (await store.registry()).connections.find(c => c.id === connection.id);
    const old = await storedCredential(store.dir, connection.id);
    const current = credentialRoot(connection, old);
    const entered = await interaction.prompt({ type: 'text', message: '服务 URL（留空保留当前地址）', placeholder: current ?? 'https://api.example.com' });
    const root = normalizeUrl(entered.trim() || current || '');
    if (new URL(root).protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(root).hostname)) {
      const answer = await interaction.prompt({ type: 'select', message: '此地址使用明文 HTTP，密钥可能被窃听。是否继续？', options: [{ id: 'no', label: '取消' }, { id: 'yes', label: '继续' }] });
      if (answer !== 'yes') throw new Error('已取消');
    }
    const key = (await interaction.prompt({ type: 'secret', message: old?.key && root === current ? 'API Key（留空保留当前密钥）' : 'API Key' })).trim() || (root === current ? old?.key : undefined);
    if (!key || /[\x00-\x20\x7f]/.test(key)) throw new Error('请输入有效 API Key');
    interaction.notify({ type: 'progress', message: '正在读取模型目录与协议声明…' });
    let s = await fresh(root, key, signal, false);
    const unknown = s.discovery.rows.filter(r => !s.discovery.protocols[String(r.id)]?.length && !connection.protocol && !connection.modelProtocols?.[String(r.id)]);
    if (unknown.length) {
      const answer = await interaction.prompt({ type: 'select', message: `${unknown.length} 个模型未声明协议。探测最多发出 ${unknown.length * PROTOCOLS.length} 次小型请求，可能计费；只在此处探测并缓存。`, options: [{ id: 'probe', label: '自动探测支持的协议' }, ...PROTOCOLS.map(id => ({ id, label: `不探测，统一使用 ${id}` })), { id: 'cancel', label: '取消' }] });
      if (answer === 'cancel') throw new Error('已取消');
      if (answer === 'probe') {
        interaction.notify({ type: 'progress', message: '正在逐模型探测协议…' });
        s = await fresh(root, key, signal, true);
      } else if (PROTOCOLS.includes(answer as Protocol)) connection = { ...connection, protocol: answer as Protocol };
      else throw new Error('无效协议选择');
    }
    const nextModels = await mapped(root, s, signal, true);
    if (s.discovery.rows.length && !nextModels.length) throw new Error('尚未找到可用协议，未替换现有配置');
    signal.throwIfAborted();
    // Verify/persist non-secret connection before native Models.login commits the credential.
    await store.put({ ...connection, url: root }, expectedConnection ?? null);
    await store.save(connection.id, s);
    connection = { ...connection, url: root }; snapshot = s; models = nextModels;
    return { type: 'api_key', key, env: { [ROOT]: root } };
  };
  const base = createProvider<Protocol>({
    id: connection.id, name: connection.name, models: [],
    auth: { apiKey: {
      name: connection.name,
      login,
      async check({ credential }) { return credential?.key && credentialRoot(connection, credential) ? { type: 'api_key', source: 'Pi auth.json' } : undefined; },
      async resolve({ credential }) {
        const root = credentialRoot(connection, credential);
        return credential?.key && root ? { auth: { apiKey: credential.key }, env: { [ROOT]: root }, source: 'Pi auth.json' } : undefined;
      },
    } },
    api: protocolApis,
  });
  function validated<T extends Model<Protocol>>(model: T, options?: { apiKey?: string; env?: Record<string, string> }): T {
    const root = options?.env?.[ROOT] ?? connection.url;
    const binding = 'gateway' in model ? record(model.gateway)?.binding : undefined;
    if (disposed || !root || !options?.apiKey || binding !== fingerprint(root, options.apiKey)) throw new Error('服务地址或凭据已改变，请刷新模型后重试');
    // URLs are derived locally; never use URL/auth supplied by a remote model row.
    return model;
  }
  const provider: Provider<Protocol> = {
    ...base,
    getModels: () => models,
    getAllModels: () => models,
    async refreshModels(context: RefreshModelsContext) {
      const signal = combined(context.signal);
      const credential = context.credential?.type === 'api_key' ? context.credential : undefined;
      const root = await restore(credential, signal);
      const publish = async (next: GatewayModel[]) => context.publish({ update: () => { if (!disposed) models = next; } });
      if (!root || !credential?.key) { await publish([]); return; }
      if (!context.allowNetwork || snapshot && !context.force && Date.now() - snapshot.checkedAt < TTL) { await publish(models); return; }
      const s = await fresh(root, credential.key, signal, false);
      const next = await mapped(root, s, signal, true);
      signal.throwIfAborted();
      if (!(await publish(next)) || disposed) return;
      await store.save(connection.id, s); snapshot = s;
    },
    stream: (model, context, options) => base.stream(validated(model, options), context, options),
    streamSimple: (model, context, options) => base.streamSimple(validated(model, options), context, options),
  };
  return {
    provider, login,
    async initialize(signal, allowNetwork) {
      const credential = await storedCredential(store.dir, connection.id); const root = await restore(credential, signal);
      if (!root || !credential?.key || snapshot || !allowNetwork) return;
      try { const s = await fresh(root, credential.key, combined(signal), false); models = await mapped(root, s, signal, true); await store.save(connection.id, s); snapshot = s; }
      catch { signal.throwIfAborted(); /* First use can retry from /gateway refresh. */ }
    },
    dispose() { disposed = true; lifetime.abort(); },
    info: () => ({ models, unknown: snapshot?.discovery.rows.map(r => String(r.id)).filter(id => !models.some(m => m.id === id)) ?? [], checkedAt: snapshot?.checkedAt ?? 0 }),
  };
}
