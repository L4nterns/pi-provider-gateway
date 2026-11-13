import { join } from 'node:path';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { getAgentDir, ModelRuntime, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createGateway, storedCredential, type GatewayHandle } from './provider.ts';
import { connectionId, Store } from './storage.ts';
import { PROTOCOLS, clean, type Connection, type Protocol } from './types.ts';
import { interaction, progress, readOnly } from './ui.ts';
import { automaticParameters, editableOverride, modelFile, nativeOverride, saveOverrides, validateModelPath } from './model-config.ts';
import { editParameters } from './model-editor.ts';
import { modelDetails } from './model-info.ts';

const ACTIONS = [
  { id: 'add', label: '添加服务', description: '创建服务，填写服务 ID、URL 和 Key' },
  { id: 'edit', label: '管理服务', description: '连接、模型目录与协议诊断' },
  { id: 'refresh', label: '刷新配置', description: '重新读取本地配置，不访问上游' },
  { id: 'info', label: '查看模型', description: '生效参数、来源与协议' },
  { id: 'model', label: '编辑模型', description: '参数、价格、能力与协议偏好' },
  { id: 'remove', label: '删除服务', description: '删除服务及其凭据和缓存' },
] as const;
const actionLabel = (a: { label: string; description: string }) => `${a.label}  ${a.description}`;
const SERVICE_ACTIONS = [
  { id: 'connection', label: '连接配置', description: 'URL、Key 与服务协议' },
  { id: 'catalog', label: '同步目录', description: '读取上游模型目录，不生成内容' },
  { id: 'diagnose', label: '协议诊断', description: '选择模型并确认后探测，可能计费' },
] as const;

export default async function gatewayExtension(pi: ExtensionAPI) {
  const store = new Store(getAgentDir());
  const builtinIds = new Set<string>(getBuiltinProviders());
  const handles = new Map<string, GatewayHandle>();
  const connections = new Map<string, Connection>();
  const lifecycle = new AbortController();
  const temporaryHandles = new Set<GatewayHandle>();
  let busy = false;
  const offline = /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? '');
  async function register(c: Connection, allowNetwork = !offline) {
    const h = createGateway(c, store);
    try { await h.initialize(lifecycle.signal, allowNetwork); }
    catch (error) { h.dispose(); throw error; }
    handles.get(c.id)?.dispose();
    handles.set(c.id, h); connections.set(c.id, c);
    // Pi 1.5's /login echoes secrets. Preserve native persistence, not that input UI.
    pi.registerProvider({ ...h.provider, auth: { ...h.provider.auth, apiKey: { ...h.provider.auth.apiKey!, login: async () => { throw new Error(`请使用 /gateway edit ${c.id} 的遮罩密钥输入框；当前 Pi 原生 /login 会明文回显密钥`); } } } });
    return h;
  }
  const registry = await store.registry();
  // A persisted ID must follow the same collision rule as Add; never shadow a native provider.
  for (const c of registry.connections) if (builtinIds.has(c.id)) throw new Error(`服务 ID「${c.id}」与 Pi 内置 provider 冲突；请编辑 gateway.json 后重新加载`);
  for (const c of registry.connections) await register(c);
  pi.on('session_shutdown', () => { lifecycle.abort(); for (const h of handles.values()) h.dispose(); });

  const pick = async (ctx: ExtensionCommandContext, specified?: string): Promise<Connection | undefined> => {
    if (specified) { const c = connections.get(specified); if (!c) throw new Error('找不到该服务'); return c; }
    const ids = [...connections.keys()];
    if (!ids.length) throw new Error('尚未添加服务，请使用 /gateway add');
    const id = ids.length === 1 ? ids[0] : await ctx.ui.select('选择服务 ID', ids);
    return id ? connections.get(id) : undefined;
  };
  const authRuntime = async (c: Connection, expected: Connection | null = c, ctx?: ExtensionCommandContext) => {
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(store.dir, 'auth.json'), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
    const h = createGateway(c, store, expected, ctx ? (message, signal, work) => progress(ctx, message, signal, work) : undefined); temporaryHandles.add(h);
    runtime.registerNativeProvider(h.provider);
    await runtime.refresh({ providers: [c.id], allowNetwork: false });
    return runtime;
  };
  async function apply(ctx: ExtensionCommandContext, c: Connection) {
    const result = await ctx.modelRegistry.refresh({ providers: [c.id], allowNetwork: false, signal: lifecycle.signal });
    const error = result.errors.get(c.id); if (error) throw error;
    if (result.aborted) throw new Error('刷新已取消或超时，未确认成功');
    if (ctx.modelRegistry.getError()) throw new Error('原生模型配置无效，请检查 models.json；未确认刷新成功');
    if (ctx.model?.provider === c.id) {
      const selected = ctx.modelRegistry.getAll().find(m => m.provider === c.id && m.id === ctx.model!.id);
      if (selected) await pi.setModel(selected);
      else ctx.ui.notify('当前模型已不在目录，请使用「/model」重新选择。', 'warning');
    }
  }
  async function diskRefresh(ctx: ExtensionCommandContext, c: Connection, notify = true) {
    // Pi's parser accepts JSONC. Validate without running credential/header commands.
    await validateModelPath(join(store.dir, 'models.json'), [...handles.values()].map(h => h.provider));
    await register(c, false); // New handle rereads the persisted discovery cache too.
    await apply(ctx, c);
    if (notify) ctx.ui.notify(`「模型已刷新」${ctx.modelRegistry.getAll().filter(m => m.provider === c.id).length} 个模型`, 'info');
  }
  async function editService(ctx: ExtensionCommandContext, c: Connection) {
    const selected = await ctx.ui.select(`管理服务 · ${c.id}`, SERVICE_ACTIONS.map(actionLabel), { signal: lifecycle.signal });
    const task = SERVICE_ACTIONS.find(a => actionLabel(a) === selected)?.id;
    if (!task) return;
    if (offline) throw new Error('离线模式不能修改连接、同步目录或诊断协议；本地「刷新配置」仍可用');
    if (task === 'connection') {
      const runtime = await authRuntime(c, c, ctx);
      await runtime.login(c.id, 'api_key', interaction(ctx, lifecycle.signal));
      const saved = (await store.registry()).connections.find(x => x.id === c.id)!;
      const h = await register(saved, false); await apply(ctx, saved);
      ctx.ui.notify('「连接已保存」模型已自动刷新。', 'info');
      if (h.info().unknown.length) ctx.ui.notify(`「协议待确认」${h.info().unknown.length} 个模型未注册；可选择「协议诊断」或编辑模型的「协议偏好」。`, 'warning');
      return;
    }
    const h = createGateway(c, store); temporaryHandles.add(h);
    await h.initialize(lifecycle.signal, false);
    const network = <T>(message: string, timeout: number, work: (signal: AbortSignal, report: (message: string) => void) => Promise<T>) => progress(ctx, message, AbortSignal.any([lifecycle.signal, AbortSignal.timeout(timeout)]), work);
    if (task === 'catalog') {
      await network('正在读取模型目录与协议声明…', 60000, (signal, report) => h.updateCatalog(signal, report));
      await register(c, false); await apply(ctx, c);
      ctx.ui.notify(`「上游目录已更新」${h.info().models.length} 个可用模型，${h.info().unknown.length} 个协议待确认；未发出生成请求。`, 'info');
      return;
    }
    const ids = [...h.info().models.map(m => m.id), ...h.info().unknown];
    if (!ids.length) { ctx.ui.notify('「暂无模型目录」请先选择「同步目录」。', 'warning'); return; }
    const scope = await ctx.ui.select('协议诊断 · 选择范围', ['单个模型', `全部模型  当前目录的 ${ids.length} 个模型`], { signal: lifecycle.signal });
    if (!scope) return;
    const id = scope === '单个模型' ? await ctx.ui.select('协议诊断 · 选择模型', ids, { signal: lifecycle.signal }) : undefined;
    if (scope === '单个模型' && !id) return;
    const targets = new Set(id ? [id] : ids);
    const consent = '开始诊断  已发送的请求与费用无法撤销';
    if (await ctx.ui.select(`协议诊断 · ${id ?? `全部 ${targets.size} 个模型`} · 最多 ${targets.size * PROTOCOLS.length} 次请求，可能计费`, ['取消', consent], { signal: lifecycle.signal }) !== consent) return;
    const results = await network('正在逐模型探测协议…', 600000, (signal, report) => h.diagnose(targets, signal, report));
    const failed = results.filter(r => !r.ok);
    if (failed.length) ctx.ui.notify(`${failed.length} 次探测未确认支持；已有证据保留。${failed.map(r => `${r.model} / ${r.api}: ${r.reason ?? '未知'}`).join('；')}`, 'warning');
    await register(c, false); await apply(ctx, c);
    ctx.ui.notify('「协议诊断已完成」结果已保存并应用；服务与模型协议指定保持不变。', 'info');
  }
  async function editModel(ctx: ExtensionCommandContext, c: Connection) {
    const handle = handles.get(c.id)!;
    const ids = [...new Set([...ctx.modelRegistry.getAll().filter(m => m.provider === c.id).map(m => m.id), ...handle.info().unknown])];
    if (!ids.length) { ctx.ui.notify('「暂无模型」请先选择「管理服务 → 同步目录」。', 'warning'); return; }
    const id = await ctx.ui.select('编辑模型', ids); if (!id) return;
    const mode = await ctx.ui.select(`编辑模型 · ${id}`, ['模型参数  名称、上下文、输出、价格与能力', '协议偏好  仅此服务内的当前模型']);
    if (!mode) return;
    if (mode.startsWith('协议偏好  ')) {
      const selected = await ctx.ui.select('模型协议 ·「自动」使用服务设置或发现结果', ['自动', ...PROTOCOLS]);
      if (!selected) return;
      const updated = structuredClone(c); updated.modelProtocols ??= {};
      if (selected === '自动') delete updated.modelProtocols[id]; else updated.modelProtocols[id] = selected as Protocol;
      if (!Object.keys(updated.modelProtocols).length) delete updated.modelProtocols;
      await store.put(updated, c); await register(updated, false); await apply(ctx, updated);
    } else {
      const file = await modelFile(store);
      const previous = editableOverride(nativeOverride(file.data, c.id, id));
      const automatic = await automaticParameters(file.data, c.id, id, [...handles.values()].map(h => h.provider));
      const override = await editParameters(ctx, previous, automatic);
      if (override === undefined) return;
      if (JSON.stringify(previous) === JSON.stringify(override)) return;
      if (JSON.stringify((await store.registry()).connections.find(x => x.id === c.id)) !== JSON.stringify(c)) throw new Error('服务已被其他会话修改，请重新打开菜单；未写入模型参数');
      await saveOverrides(store, c.id, id, file.raw, override, [...handles.values()].map(h => h.provider));
      await diskRefresh(ctx, c, false);
    }
    const actual = ctx.modelRegistry.getAll().find(m => m.provider === c.id && m.id === id)?.api ?? '未注册';
    ctx.ui.notify(`「模型已保存」已自动刷新，实际协议：${actual}。`, 'info');
  }
  async function command(args: string, ctx: ExtensionCommandContext) {
    if (ctx.mode !== 'tui') throw new Error('/gateway 配置菜单需要 Pi 交互终端；已配置的服务在其他模式正常使用');
    const [actionArg, specified, ...extra] = args.trim().split(/\s+/);
    if (extra.length) throw new Error('不要把密钥放入命令参数；使用 /gateway add 的密钥输入框');
    let action = actionArg;
    if (!action) {
      const actions = connections.size ? ACTIONS : ACTIONS.filter(a => a.id === 'add');
      const selected = await ctx.ui.select('Gateway', actions.map(actionLabel));
      action = actions.find(a => actionLabel(a) === selected)?.id ?? '';
      if (!action) return;
    }
    if (!ACTIONS.some(a => a.id === action) || (action === 'add' && specified)) throw new Error('用法：/gateway add 或 /gateway [edit|refresh|info|model|remove] [服务ID]');
    if (action !== 'info' && !ctx.isIdle()) { ctx.ui.notify('「暂不可修改」模型或工具运行中；本次未执行、未排队。', 'warning'); return; }
    if (action === 'add') {
      if (offline) throw new Error('离线模式不能添加服务');
      let id: string;
      for (;;) {
        const entered = await ctx.ui.input('服务 ID（必填，创建后固定）', '1–64 位，字母/数字开头，可含 ._-', { signal: lifecycle.signal });
        if (entered === undefined) return;
        id = entered.trim();
        if (!connectionId(id)) { ctx.ui.notify('「服务 ID 无效」需 1–64 位，字母/数字开头，可含 ._-。', 'warning'); continue; }
        if (connections.has(id) || builtinIds.has(id) || (await store.registry()).connections.some(c => c.id === id)) { ctx.ui.notify('「服务 ID 已存在」请换一个 ID。', 'warning'); continue; }
        break;
      }
      const c: Connection = { id, name: id };
      const runtime = await authRuntime(c, null, ctx);
      await store.operation(id, async () => {
        await runtime.login(id, 'api_key', interaction(ctx, lifecycle.signal));
        const saved = (await store.registry()).connections.find(c => c.id === id)!;
        await register(saved, false); await apply(ctx, saved);
      });
      ctx.ui.notify(`「${id}」已保存；使用「/model」选择模型。`, 'info'); return;
    }
    const picked = await pick(ctx, specified); if (!picked) return;
    const c = action === 'refresh' ? (await store.registry()).connections.find(x => x.id === picked.id) : picked;
    if (!c) throw new Error('服务已从磁盘移除，请 /reload 后重试；未写入配置');
    if (action === 'info') {
      const models = ctx.modelRegistry.getAll().filter(m => m.provider === c.id);
      const id = await ctx.ui.select('查看模型', models.map(m => m.id));
      const model = models.find(m => m.id === id); if (!model) return;
      const data = await modelFile(store).then(f => f.data).catch(() => undefined);
      await readOnly(ctx, `查看模型 · ${model.id}`, modelDetails(model, handles.get(c.id)?.info().models.find(m => m.id === id), c, data)); return;
    }
    await store.operation(c.id, async () => {
      const current = (await store.registry()).connections.find(x => x.id === c.id);
      if (JSON.stringify(current) !== JSON.stringify(c)) throw new Error('服务已被其他会话修改，请 /reload 后重试；未修改凭据或配置');
      if (action === 'edit') await editService(ctx, c);
      else if (action === 'refresh') await diskRefresh(ctx, c);
      else if (action === 'model') await editModel(ctx, c);
      else if (action === 'remove') {
        if (ctx.model?.provider === c.id) throw new Error('请先通过 /model 切换到其他服务，再删除当前服务');
        const credential = await storedCredential(store.dir, c.id);
        const deletion = '删除  连接、凭据与缓存；保留对话和模型覆盖';
        if (await ctx.ui.select(`删除「${c.id}」？`, ['取消', deletion], { signal: lifecycle.signal }) !== deletion) return;
        const runtime = await authRuntime(c);
        // External/native writers need not honor the Gateway operation lock.
        // Reject stale consent before logout, not after the credential is gone.
        const latest = (await store.registry()).connections.find(x => x.id === c.id);
        if (JSON.stringify(latest) !== JSON.stringify(c) || JSON.stringify(await storedCredential(store.dir, c.id)) !== JSON.stringify(credential)) throw new Error('服务或凭据已改变，请重新打开菜单；未删除服务、凭据或缓存');
        await runtime.logout(c.id, { signal: lifecycle.signal });
        await store.remove(c); handles.get(c.id)?.dispose(); handles.delete(c.id); connections.delete(c.id); pi.unregisterProvider(c.id);
      }
    });
  }
  pi.registerCommand('gateway', {
    description: '管理网关连接与模型',
    getArgumentCompletions(prefix) { return ACTIONS.filter(a => a.id.startsWith(prefix)).map(a => ({ value: a.id, label: a.id })); },
    async handler(args, ctx) {
      if (busy) { ctx.ui.notify('已有 Gateway 操作正在进行', 'warning'); return; }
      busy = true;
      try { await command(args, ctx); }
      catch (e) { ctx.ui.notify(clean(e instanceof Error ? e.message : 'Gateway 操作失败'), 'error'); }
      finally { for (const h of temporaryHandles) h.dispose(); temporaryHandles.clear(); busy = false; }
    },
  });
}
