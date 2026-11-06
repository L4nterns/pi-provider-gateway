import { join } from 'node:path';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { getAgentDir, ModelRuntime, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createGateway, type GatewayHandle } from './provider.ts';
import { connectionId, Store } from './storage.ts';
import { PROTOCOLS, clean, type Connection, type Protocol } from './types.ts';
import { interaction, progress, readOnly } from './ui.ts';
import { editableOverride, modelFile, nativeOverride, parseOverrides, saveOverrides, validateModelPath, validateOverrides } from './model-config.ts';
import { modelDetails } from './model-info.ts';

const ACTIONS = [
  { id: 'add', label: '添加服务', description: '创建服务，填写服务 ID、URL 和 Key' },
  { id: 'edit', label: '编辑服务', description: '修改 URL 或 Key' },
  { id: 'refresh', label: '刷新模型', description: '重新从硬盘读取模型配置' },
  { id: 'info', label: '模型信息', description: '查看模型配置' },
  { id: 'model', label: '编辑模型', description: '修改模型配置' },
  { id: 'remove', label: '删除服务', description: '删除服务及其凭据和缓存' },
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
  for (const c of (await store.registry()).connections) await register(c);
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
    const h = createGateway(c, store, expected, ctx ? (message, signal, work) => progress(ctx, message, signal, work) : undefined); authHandles.add(h);
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
  async function editModel(ctx: ExtensionCommandContext, c: Connection) {
    const handle = handles.get(c.id)!;
    const ids = [...new Set([...ctx.modelRegistry.getAll().filter(m => m.provider === c.id).map(m => m.id), ...handle.info().unknown])];
    if (!ids.length) { ctx.ui.notify('「暂无模型」请先编辑服务，读取模型目录。', 'warning'); return; }
    const id = await ctx.ui.select('编辑模型', ids); if (!id) return;
    const mode = await ctx.ui.select(`编辑模型 · ${id}`, ['模型参数  编辑原生 models.json 覆盖', '协议  自动选择或手动指定']);
    if (!mode) return;
    if (mode.startsWith('协议  ')) {
      const selected = await ctx.ui.select('模型协议 ·「自动」使用服务设置或发现结果', ['自动', ...PROTOCOLS]);
      if (!selected) return;
      const updated = structuredClone(c); updated.modelProtocols ??= {};
      if (selected === '自动') delete updated.modelProtocols[id]; else updated.modelProtocols[id] = selected as Protocol;
      if (!Object.keys(updated.modelProtocols).length) delete updated.modelProtocols;
      await store.put(updated, c); await register(updated, false); await apply(ctx, updated);
    } else {
      const file = await modelFile(store);
      const previous = editableOverride(nativeOverride(file.data, c.id, id));
      const text = await ctx.ui.editor(`编辑模型 · ${id} · 参数覆盖（{} 恢复自动）`, JSON.stringify(previous, null, 2));
      if (text === undefined) return;
      const override = await validateOverrides(parseOverrides(text));
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
        if (connections.has(id) || (getBuiltinProviders() as readonly string[]).includes(id) || (await store.registry()).connections.some(c => c.id === id)) { ctx.ui.notify('「服务 ID 已存在」请换一个 ID。', 'warning'); continue; }
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
      const id = await ctx.ui.select('模型信息', models.map(m => m.id));
      const model = models.find(m => m.id === id); if (!model) return;
      const data = await modelFile(store).then(f => f.data).catch(() => undefined);
      await readOnly(ctx, `模型信息 · ${model.id}`, modelDetails(model, handles.get(c.id)?.info().models.find(m => m.id === id), c, data)); return;
    }
    await store.operation(c.id, async () => {
      const current = (await store.registry()).connections.find(x => x.id === c.id);
      if (JSON.stringify(current) !== JSON.stringify(c)) throw new Error('服务已被其他会话修改，请 /reload 后重试；未修改凭据或配置');
      if (action === 'edit') {
        if (offline) throw new Error('离线模式不能编辑服务');
        const runtime = await authRuntime(c, c, ctx); await runtime.login(c.id, 'api_key', interaction(ctx, lifecycle.signal));
        const saved = (await store.registry()).connections.find(x => x.id === c.id)!;
        await register(saved, false); await apply(ctx, saved);
        ctx.ui.notify('「服务已保存」模型已自动刷新。', 'info');
      } else if (action === 'refresh') await diskRefresh(ctx, c);
      else if (action === 'model') await editModel(ctx, c);
      else if (action === 'remove') {
        if (ctx.model?.provider === c.id) throw new Error('请先通过 /model 切换到其他服务，再删除当前服务');
        const deletion = '删除  连接、凭据与缓存；保留对话和模型覆盖';
        if (await ctx.ui.select(`删除「${c.id}」？`, ['取消', deletion], { signal: lifecycle.signal }) !== deletion) return;
        const runtime = await authRuntime(c); await runtime.logout(c.id);
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
      finally { for (const h of authHandles) h.dispose(); authHandles.clear(); busy = false; }
    },
  });
}
