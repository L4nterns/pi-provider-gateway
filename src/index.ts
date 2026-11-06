import { join } from 'node:path';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { getAgentDir, ModelRuntime, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createGateway, type GatewayHandle } from './provider.ts';
import { connectionId, Store } from './storage.ts';
import { PROTOCOLS, clean, type Connection, type GatewayModel, type Protocol } from './types.ts';
import { interaction } from './ui.ts';

export default async function gatewayExtension(pi: ExtensionAPI) {
  const store = new Store(getAgentDir());
  const handles = new Map<string, GatewayHandle>();
  const connections = new Map<string, Connection>();
  const lifecycle = new AbortController();
  const authHandles = new Set<GatewayHandle>();
  let busy = false;
  const offline = /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? '');
  const defaultConnection: Connection = { id: 'gateway', name: 'Gateway' };
  async function register(c: Connection) {
    handles.get(c.id)?.dispose();
    const h = createGateway(c, store);
    await h.initialize(lifecycle.signal, !offline);
    handles.set(c.id, h); connections.set(c.id, c);
    // Pi 1.5's native /login dialog renders secret prompts as plain Input, including
    // submitted values. Keep native auth persistence, but route secret entry to our masked UI.
    pi.registerProvider({ ...h.provider, auth: { ...h.provider.auth, apiKey: { ...h.provider.auth.apiKey!, login: async () => { throw new Error(`请使用 /gateway login ${c.id} 的遮罩密钥输入框；当前 Pi 原生 /login 会明文回显密钥`); } } } });
    return h;
  }
  const registry = await store.registry();
  for (const c of registry.connections.length ? registry.connections : [defaultConnection]) await register(c);
  pi.on('session_shutdown', () => { lifecycle.abort(); for (const h of handles.values()) h.dispose(); });

  const pick = async (ctx: ExtensionCommandContext, specified?: string): Promise<Connection | undefined> => {
    if (specified) { const c = connections.get(specified); if (!c) throw new Error('找不到该服务'); return c; }
    const ids = [...connections.keys()];
    const id = ids.length === 1 ? ids[0] : await ctx.ui.select('选择服务', ids);
    return id ? connections.get(id) : undefined;
  };
  // Use Pi's public runtime for its canonical auth.json locking and credential writes.
  // No private imports, separate secret store, or hand-written auth.json mutations.
  const authRuntime = async (c: Connection) => {
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(store.dir, 'auth.json'), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
    const h = createGateway(c, store); authHandles.add(h);
    runtime.registerNativeProvider(h.provider);
    await runtime.refresh({ providers: [c.id], allowNetwork: false });
    return runtime;
  };
  const refresh = async (ctx: ExtensionCommandContext, c: Connection) => {
    if (offline) throw new Error('当前为离线模式；未发出网络请求');
    const result = await ctx.modelRegistry.refresh({ providers: [c.id], allowNetwork: true, force: true, signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(60000)]) });
    const error = result.errors.get(c.id); if (error) throw error;
    const info = handles.get(c.id)!.info();
    ctx.ui.notify(`${c.id}：${info.models.length} 个模型${info.unknown.length ? `；${info.unknown.length} 个协议未知，请运行 /gateway detect` : ''}`, 'info');
  };
  async function command(args: string, ctx: ExtensionCommandContext) {
    if (ctx.mode !== 'tui') throw new Error('/gateway 配置菜单需要 Pi 交互终端；已配置的服务在其他模式正常使用');
    const [actionArg, specified, ...extra] = args.trim().split(/\s+/);
    if (extra.length) throw new Error('不要把密钥放入命令参数；使用 /gateway add 的密钥输入框');
    let action = actionArg;
    if (!action) {
      const choices = ['配置 / 登录', '添加服务', '刷新模型', '探测协议', '查看模型信息', '设置协议覆盖', '删除服务'];
      const selected = await ctx.ui.select('Gateway（账号、路由、额度由上游管理）', choices);
      action = ['login', 'add', 'refresh', 'detect', 'info', 'protocol', 'remove'][choices.indexOf(selected ?? '')];
      if (!action) return;
    }
    if (action === 'add') {
      if (offline) throw new Error('离线模式不能添加服务');
      const entered = await ctx.ui.input('服务 ID（不填自动命名；以后用于 /model 和 /login）', `gateway-${connections.size + 1}`);
      if (entered === undefined) return;
      const id = entered.trim() || `gateway-${connections.size + 1}`;
      if (!connectionId(id) || connections.has(id) || (getBuiltinProviders() as readonly string[]).includes(id)) throw new Error('服务 ID 无效或已经存在');
      const c = { id, name: id };
      await register(c);
      try {
        const runtime = await authRuntime(c);
        await runtime.login(id, 'api_key', interaction(ctx, lifecycle.signal));
        const saved = (await store.registry()).connections.find(c => c.id === id)!;
        await register(saved);
      } catch (e) { handles.get(id)?.dispose(); handles.delete(id); connections.delete(id); pi.unregisterProvider(id); throw e; }
      await ctx.modelRegistry.refresh({ providers: [id], allowNetwork: false });
      ctx.ui.notify(`${id} 已保存，可用 /model 选择模型`, 'info'); return;
    }
    const c = await pick(ctx, specified); if (!c) return;
    if (action === 'login' || action === 'detect') {
      if (offline) throw new Error('离线模式不能添加或探测服务');
      if (action === 'detect') {
        // Explicit probe action is implemented by the provider login flow below.
        const handle = handles.get(c.id)!;
        const credential = await (await authRuntime(c)).getAuth(c.id);
        if (!credential?.auth.apiKey) throw new Error('请先配置服务');
        const info = handle.info();
        const model = await ctx.ui.select('选择要验证全部协议的模型（最多 4 次小型请求，可能计费）', info.models.map(m => m.id).concat(info.unknown));
        if (!model) return;
        const { discover, fingerprint, probeProtocol, selectProtocol } = await import('./discovery.ts');
        const root = credential.env?.PI_GATEWAY_URL ?? c.url; if (!root) throw new Error('没有服务地址');
        const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(120000)]);
        const previous = await store.snapshot(c.id, fingerprint(root, credential.auth.apiKey));
        const discovery = await discover(root, credential.auth.apiKey, signal, { previous: previous?.discovery });
        const results = [];
        for (const api of PROTOCOLS) results.push(await probeProtocol(root, credential.auth.apiKey, api, model, signal));
        discovery.protocols[model] = results.filter(r => r.ok).map(r => r.api); discovery.evidence[model] = 'probe'; discovery.probes = results;
        const best = selectProtocol(model, discovery.protocols[model]);
        if (!best) throw new Error('本次探测未成功，原配置保持不变；超时、鉴权或配额错误不等于协议不支持');
        await store.save(c.id, { version: 1, fingerprint: fingerprint(root, credential.auth.apiKey), checkedAt: Date.now(), discovery });
        await register(c); await ctx.modelRegistry.refresh({ providers: [c.id], allowNetwork: false });
        ctx.ui.notify(results.map(r => `${r.api}：${r.ok ? '成功' : r.reason}`).join('\n') + `\n优先使用 ${best}`, 'info'); return;
      }
      const runtime = await authRuntime(c); await runtime.login(c.id, 'api_key', interaction(ctx, lifecycle.signal));
      await register((await store.registry()).connections.find(x => x.id === c.id)!);
      await ctx.modelRegistry.refresh({ providers: [c.id], allowNetwork: false });
      ctx.ui.notify('已保存连接与凭据，可用 /model 选择模型', 'info'); return;
    }
    if (action === 'refresh') { await refresh(ctx, c); return; }
    if (action === 'info') {
      const models = ctx.modelRegistry.getAll().filter(m => m.provider === c.id) as GatewayModel[];
      const id = await ctx.ui.select('模型信息（包含 Pi 原生覆盖后的实际参数）', models.map(m => m.id));
      const m = models.find(m => m.id === id); if (!m) return;
      await ctx.ui.editor('仅查看；关闭即可，不修改配置', JSON.stringify({ id: m.id, api: m.api, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap, compat: m.compat, sources: m.gateway?.source, protocolEvidence: m.gateway?.protocolEvidence, warnings: m.gateway?.warnings, note: 'models.json 用户覆盖最终优先；来源描述的是自动发现层' }, null, 2)); return;
    }
    if (action === 'protocol') {
      const target = await ctx.ui.select('覆盖范围', ['整个服务', ...handles.get(c.id)!.info().models.map(m => m.id), ...handles.get(c.id)!.info().unknown]);
      if (!target) return;
      const api = await ctx.ui.select('协议（自动将删除手动覆盖）', ['自动', ...PROTOCOLS]); if (!api) return;
      const updated = structuredClone(c);
      if (target === '整个服务') { if (api === '自动') delete updated.protocol; else updated.protocol = api as Protocol; }
      else { updated.modelProtocols ??= {}; if (api === '自动') delete updated.modelProtocols[target]; else updated.modelProtocols[target] = api as Protocol; }
      await store.put(updated, c); await register(updated); await ctx.modelRegistry.refresh({ providers: [c.id], allowNetwork: false }); return;
    }
    if (action === 'remove') {
      if (ctx.model?.provider === c.id) throw new Error('请先通过 /model 切换到其他服务，再删除当前服务');
      if (!(await ctx.ui.confirm('删除服务', `删除 ${c.id} 的连接、凭据与扩展缓存？不会删除会话和 models.json 覆盖。`))) return;
      const runtime = await authRuntime(c); await runtime.logout(c.id);
      await store.remove(c); handles.get(c.id)?.dispose(); handles.delete(c.id); connections.delete(c.id); pi.unregisterProvider(c.id); return;
    }
    throw new Error('用法：/gateway [add|login|refresh|detect|info|protocol|remove] [服务ID]');
  }
  pi.registerCommand('gateway', {
    description: '终端内管理兼容网关：连接、协议、模型与能力；不管理上游账号/路由',
    getArgumentCompletions(prefix) {
      const values = ['add', 'login', 'refresh', 'detect', 'info', 'protocol', 'remove'];
      return values.filter(v => v.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (busy) { ctx.ui.notify('已有 Gateway 操作正在进行', 'warning'); return; }
      busy = true;
      try { await ctx.waitForIdle(); await command(args, ctx); }
      catch (e) { ctx.ui.notify(clean(e instanceof Error ? e.message : 'Gateway 操作失败'), 'error'); }
      finally { for (const h of authHandles) h.dispose(); authHandles.clear(); busy = false; }
    },
  });
}
