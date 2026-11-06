import { join } from 'node:path';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { getAgentDir, ModelRuntime, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createGateway, type GatewayHandle } from './provider.ts';
import { connectionId, Store } from './storage.ts';
import { PROTOCOLS, clean, type Connection, type GatewayModel, type Protocol } from './types.ts';
import { fingerprint, selectProtocol } from './discovery.ts';
import { interaction, progress } from './ui.ts';

const ACTIONS = [
  { id: 'add', label: '添加服务', description: '创建稳定 ID，填写 URL 和遮罩 Key' },
  { id: 'edit', label: '编辑连接', description: '修改 URL 或 Key，服务 ID 不变' },
  { id: 'refresh', label: '刷新模型', description: '读取目录与能力，不发出生成探测' },
  { id: 'detect', label: '探测协议', description: '验证单个模型，最多 4 次请求，可能计费' },
  { id: 'info', label: '模型信息', description: '查看实际协议、参数、来源与覆盖' },
  { id: 'protocol', label: '协议覆盖', description: '手动指定服务或模型协议，不发出探测' },
  { id: 'remove', label: '删除服务', description: '删除连接、凭据和缓存，保留对话历史' },
] as const;
const actionLabel = (a: typeof ACTIONS[number]) => `${a.label}  ${a.description}`;

export default async function gatewayExtension(pi: ExtensionAPI) {
  const store = new Store(getAgentDir());
  const handles = new Map<string, GatewayHandle>();
  const connections = new Map<string, Connection>();
  const lifecycle = new AbortController();
  const authHandles = new Set<GatewayHandle>();
  let busy = false;
  const offline = /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? '');
  async function register(c: Connection) {
    const h = createGateway(c, store);
    try { await h.initialize(lifecycle.signal, !offline); }
    catch (error) { h.dispose(); throw error; }
    handles.get(c.id)?.dispose();
    handles.set(c.id, h); connections.set(c.id, c);
    // Pi 1.5's native /login dialog renders secret prompts as plain Input, including
    // submitted values. Keep native auth persistence, but route secret entry to our masked UI.
    pi.registerProvider({ ...h.provider, auth: { ...h.provider.auth, apiKey: { ...h.provider.auth.apiKey!, login: async () => { throw new Error(`请使用 /gateway edit ${c.id} 的遮罩密钥输入框；当前 Pi 原生 /login 会明文回显密钥`); } } } });
    return h;
  }
  const registry = await store.registry();
  for (const c of registry.connections) await register(c);
  pi.on('session_shutdown', () => { lifecycle.abort(); for (const h of handles.values()) h.dispose(); });

  const pick = async (ctx: ExtensionCommandContext, specified?: string): Promise<Connection | undefined> => {
    if (specified) { const c = connections.get(specified); if (!c) throw new Error('找不到该服务'); return c; }
    const ids = [...connections.keys()];
    if (!ids.length) throw new Error('尚未添加服务，请使用 /gateway add');
    const id = ids.length === 1 ? ids[0] : await ctx.ui.select('选择服务 ID', ids);
    return id ? connections.get(id) : undefined;
  };
  // Use Pi's public runtime for its canonical auth.json locking and credential writes.
  // No private imports, separate secret store, or hand-written auth.json mutations.
  const authRuntime = async (c: Connection, expected: Connection | null = c, ctx?: ExtensionCommandContext) => {
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(store.dir, 'auth.json'), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
    const h = createGateway(c, store, expected, ctx ? (message, signal, work) => progress(ctx, message, signal, work) : undefined); authHandles.add(h);
    runtime.registerNativeProvider(h.provider);
    await runtime.refresh({ providers: [c.id], allowNetwork: false });
    return runtime;
  };
  const refresh = async (ctx: ExtensionCommandContext, c: Connection) => {
    if (offline) throw new Error('当前为离线模式；未发出网络请求');
    await progress(ctx, `正在刷新 ${c.id} 的模型目录…`, lifecycle.signal, async signal => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
      const result = await ctx.modelRegistry.refresh({ providers: [c.id], allowNetwork: true, force: true, signal: deadline });
      const error = result.errors.get(c.id); if (error) throw error;
      deadline.throwIfAborted();
      if (result.aborted) throw new Error('刷新已取消或超时，未确认成功');
    });
    const info = handles.get(c.id)!.info();
    ctx.ui.notify(`${c.id}：${info.models.length} 个模型${info.unknown.length ? `；${info.unknown.length} 个协议未知，请运行 /gateway detect` : ''}`, 'info');
  };
  const protocolState = (ctx: ExtensionCommandContext, c: Connection, id: string) => {
    const known = handles.get(c.id)?.info().models.find(m => m.id === id)?.gateway.protocols ?? [];
    return {
      自动优选: selectProtocol(id, known) ?? '未知',
      模型覆盖: c.modelProtocols?.[id] ?? '无',
      服务覆盖: c.protocol ?? '无',
      实际使用: ctx.modelRegistry.getAll().find(m => m.provider === c.id && m.id === id)?.api ?? '未注册',
      说明: '实际使用包含 models.json 原生覆盖；探测失败不代表协议不支持',
    };
  };
  async function command(args: string, ctx: ExtensionCommandContext) {
    if (ctx.mode !== 'tui') throw new Error('/gateway 配置菜单需要 Pi 交互终端；已配置的服务在其他模式正常使用');
    const [actionArg, specified, ...extra] = args.trim().split(/\s+/);
    if (extra.length) throw new Error('不要把密钥放入命令参数；使用 /gateway add 的密钥输入框');
    let action = actionArg;
    if (!action) {
      const actions = connections.size ? ACTIONS : ACTIONS.filter(a => a.id === 'add');
      const selected = await ctx.ui.select('Gateway — 账号、路由、额度由上游管理', actions.map(actionLabel));
      action = actions.find(a => actionLabel(a) === selected)?.id ?? '';
      if (!action) return;
    }
    if (!ACTIONS.some(a => a.id === action) || (action === 'add' && specified)) {
      throw new Error('用法：/gateway add 或 /gateway [edit|refresh|detect|info|protocol|remove] [服务ID]');
    }
    if (action !== 'info' && !ctx.isIdle()) {
      ctx.ui.notify('模型或工具仍在运行；此操作未执行、未排队。请等待结束后重试，当前请求不受影响。', 'warning');
      return;
    }
    if (action === 'add') {
      if (offline) throw new Error('离线模式不能添加服务');
      let id: string;
      for (;;) {
        const entered = await ctx.ui.input('服务 ID（必填；1–64 位字母/数字/._-，首位字母或数字；创建后不可修改）', 'my-gateway', { signal: lifecycle.signal });
        if (entered === undefined) return;
        id = entered.trim();
        if (!connectionId(id)) { ctx.ui.notify('服务 ID 格式无效；请按提示重新输入，Esc 取消。', 'warning'); continue; }
        if (connections.has(id) || (getBuiltinProviders() as readonly string[]).includes(id) || (await store.registry()).connections.some(c => c.id === id)) {
          ctx.ui.notify('服务 ID 已存在或由 Pi 内置服务使用；请换一个 ID，Esc 取消。', 'warning'); continue;
        }
        break;
      }
      const c: Connection = { id, name: id };
      const runtime = await authRuntime(c, null, ctx);
      await store.operation(id, async () => {
        await runtime.login(id, 'api_key', interaction(ctx, lifecycle.signal));
        const saved = (await store.registry()).connections.find(c => c.id === id)!;
        await register(saved);
        await ctx.modelRegistry.refresh({ providers: [id], allowNetwork: false });
      });
      ctx.ui.notify(`${id} 已保存，可用 /model 选择模型`, 'info'); return;
    }
    const c = await pick(ctx, specified); if (!c) return;
    if (action === 'info') return serviceCommand(action, c, ctx);
    return store.operation(c.id, async () => {
      const current = (await store.registry()).connections.find(x => x.id === c.id);
      if (JSON.stringify(current) !== JSON.stringify(c)) throw new Error('服务已被其他会话修改，请 /reload 后重试；未修改凭据或配置');
      return serviceCommand(action, c, ctx);
    });
  }
  async function serviceCommand(action: string, c: Connection, ctx: ExtensionCommandContext) {
    if (action === 'edit' || action === 'detect') {
      if (offline) throw new Error('离线模式不能编辑或探测服务');
      if (action === 'detect') {
        // This explicit action probes only the selected model after consent.
        const handle = handles.get(c.id)!;
        const credential = await (await authRuntime(c)).getAuth(c.id);
        if (!credential?.auth.apiKey) throw new Error('请先通过 /gateway edit 配置连接与凭据');
        const info = handle.info();
        const model = await ctx.ui.select('选择要验证全部协议的模型（最多 4 次小型请求，可能计费）', info.models.map(m => m.id).concat(info.unknown));
        if (!model) return;
        const { discover, probeProtocol } = await import('./discovery.ts');
        const root = credential.env?.PI_GATEWAY_URL ?? c.url; if (!root) throw new Error('没有服务地址');
        const results = await progress(ctx, `正在读取 ${c.id} 的模型目录…`, lifecycle.signal, async (cancel, report) => {
          const signal = AbortSignal.any([cancel, AbortSignal.timeout(120000)]);
          const previous = await store.snapshot(c.id, fingerprint(root, credential.auth.apiKey!));
          const discovery = await discover(root, credential.auth.apiKey!, signal, { previous: previous?.discovery });
          if (!discovery.rows.some(r => r.id === model)) throw new Error('模型已不在当前目录，未发出生成探测；请先刷新模型');
          const results = [];
          for (const [index, api] of PROTOCOLS.entries()) {
            signal.throwIfAborted();
            report(`探测 ${model}（${index + 1}/${PROTOCOLS.length}）：${api}…`);
            results.push(await probeProtocol(root, credential.auth.apiKey!, api, model, signal));
          }
          const succeeded = results.filter(r => r.ok).map(r => r.api);
          if (!succeeded.length) throw new Error('本次探测未成功，原配置保持不变；超时、鉴权或配额错误不等于协议不支持');
          // Failure/429/503 is unknown, not evidence to erase previously known support.
          discovery.protocols[model] = [...new Set([...(discovery.protocols[model] ?? []), ...succeeded])];
          discovery.evidence[model] = 'probe'; discovery.probes = results;
          signal.throwIfAborted(); report('正在保存探测结果…');
          await store.save(c.id, { version: 1, fingerprint: fingerprint(root, credential.auth.apiKey!), checkedAt: Date.now(), discovery });
          return results;
        });
        await register(c); await ctx.modelRegistry.refresh({ providers: [c.id], allowNetwork: false });
        const state = protocolState(ctx, c, model);
        ctx.ui.notify(results.map(r => `${r.api}：${r.ok ? '成功' : r.reason}`).join('\n') +
          `\n本次探测成功：${results.filter(r => r.ok).map(r => r.api).join('、')}\n自动优选：${state.自动优选}\n模型覆盖：${state.模型覆盖}\n服务覆盖：${state.服务覆盖}\n实际使用：${state.实际使用}（含 Pi 原生覆盖）`, 'info'); return;
      }
      const runtime = await authRuntime(c, c, ctx); await runtime.login(c.id, 'api_key', interaction(ctx, lifecycle.signal));
      await register((await store.registry()).connections.find(x => x.id === c.id)!);
      await ctx.modelRegistry.refresh({ providers: [c.id], allowNetwork: false });
      ctx.ui.notify('已保存连接与凭据，可用 /model 选择模型', 'info'); return;
    }
    if (action === 'refresh') { await refresh(ctx, c); return; }
    if (action === 'info') {
      const models = ctx.modelRegistry.getAll().filter(m => m.provider === c.id) as GatewayModel[];
      const id = await ctx.ui.select('模型信息（包含 Pi 原生覆盖后的实际参数）', models.map(m => m.id));
      const m = models.find(m => m.id === id); if (!m) return;
      await ctx.ui.editor('仅查看；关闭即可，不修改配置', JSON.stringify({ id: m.id, api: m.api, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap, compat: m.compat, sources: m.gateway?.source, protocolEvidence: m.gateway?.protocolEvidence, protocolSelection: protocolState(ctx, c, m.id), warnings: m.gateway?.warnings, note: 'models.json 用户覆盖最终优先；来源描述的是自动发现层' }, null, 2)); return;
    }
    if (action === 'protocol') {
      const target = await ctx.ui.select('覆盖范围', ['整个服务', ...handles.get(c.id)!.info().models.map(m => m.id), ...handles.get(c.id)!.info().unknown]);
      if (!target) return;
      const api = await ctx.ui.select('协议（自动将删除手动覆盖）', ['自动', ...PROTOCOLS]); if (!api) return;
      const updated = structuredClone(c);
      if (target === '整个服务') { if (api === '自动') delete updated.protocol; else updated.protocol = api as Protocol; }
      else { updated.modelProtocols ??= {}; if (api === '自动') delete updated.modelProtocols[target]; else updated.modelProtocols[target] = api as Protocol; }
      await store.put(updated, c); await register(updated); await ctx.modelRegistry.refresh({ providers: [c.id], allowNetwork: false });
      ctx.ui.notify(`${c.id}：已保存${target === '整个服务' ? '服务' : '模型'}协议覆盖；实际使用含 Pi 原生覆盖，请在「模型信息」查看。`, 'info'); return;
    }
    if (action === 'remove') {
      if (ctx.model?.provider === c.id) throw new Error('请先通过 /model 切换到其他服务，再删除当前服务');
      const deletion = `删除  ${c.id} 的连接、凭据与扩展缓存；保留会话和 models.json`;
      if (await ctx.ui.select('删除服务 — 不可撤销', ['取消', deletion], { signal: lifecycle.signal }) !== deletion) return;
      const runtime = await authRuntime(c); await runtime.logout(c.id);
      await store.remove(c); handles.get(c.id)?.dispose(); handles.delete(c.id); connections.delete(c.id); pi.unregisterProvider(c.id); return;
    }
  }
  pi.registerCommand('gateway', {
    description: '终端内管理兼容网关：连接、协议、模型与能力；不管理上游账号/路由',
    getArgumentCompletions(prefix) {
      return ACTIONS.filter(a => a.id.startsWith(prefix)).map(a => ({ value: a.id, label: a.id }));
    },
    async handler(args, ctx) {
      if (busy) { ctx.ui.notify('已有 Gateway 操作正在进行', 'warning'); return; }
      busy = true;
      try { await command(args, ctx); }
      catch (e) { ctx.ui.notify(clean(e instanceof Error ? e.message : 'Gateway 操作失败'), 'error'); }
      finally { for (const h of authHandles) h.dispose(); authHandles.clear(); busy = false; }
    },
  });
}
