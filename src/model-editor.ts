import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { display, editableOverride, parseOverrides, validateOverrides } from './model-config.ts';
import type { Row } from './types.ts';

const label = (name: string, field: string, draft: Row, automatic: Row) => `${name}  ${display(draft[field] ?? automatic[field])} · ${draft[field] === undefined ? '自动' : '覆盖'}`;
const numberValue = (text: string) => {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) throw new Error('请输入非负数字；留空恢复自动');
  return Number(text);
};

// A draft is not another registry. Every edit, including advanced JSON, reaches
// the same native schema and one conflict-checked models.json save.
export async function editParameters(ctx: ExtensionCommandContext, initial: Row, automatic: Row): Promise<Row | undefined> {
  let draft = structuredClone(initial);
  async function nested(field: 'cost' | 'promptCache') {
    const value = { ...((draft[field] as Row | undefined) ?? {}) };
    const current = (automatic[field] as Row | undefined) ?? {};
    const fields = field === 'cost'
      ? [['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入']]
      : [['short', '短期缓存'], ['long', '长期缓存']];
    for (;;) {
      const options = fields.map(([id, name]) => ({ id, text: label(name, id, value, current) }));
      const selected = await ctx.ui.select(field === 'cost' ? '价格 · USD / 百万 tokens' : '缓存时间 · 秒', options.map(o => o.text));
      const id = options.find(o => o.text === selected)?.id;
      if (!id) break;
      const text = await ctx.ui.input(`${field === 'cost' ? '价格' : '缓存时间'} · ${fields.find(f => f[0] === id)![1]} · 留空恢复自动`, display(value[id] ?? current[id]));
      if (text === undefined) continue;
      const next = { ...value };
      try {
        if (text.trim()) next[id] = numberValue(text); else delete next[id];
        await validateOverrides({ ...draft, [field]: next });
        Object.keys(value).forEach(k => delete value[k]); Object.assign(value, next);
      } catch (e) { ctx.ui.notify(e instanceof Error ? e.message : '参数无效；草稿未改变', 'warning'); }
    }
    if (Object.keys(value).length) draft[field] = value; else delete draft[field];
  }
  for (;;) {
    const fields = [['name', '显示名称'], ['contextWindow', '上下文窗口'], ['maxTokens', '最大输出'], ['input', '输入类型'], ['reasoning', '思考能力']] as const;
    const options = [
      ...fields.map(([id, name]) => ({ id: id as string, text: label(name, id, draft, automatic) })),
      { id: 'cost', text: '价格  输入、输出与缓存，USD / 百万 tokens' },
      { id: 'promptCache', text: '缓存时间  短期与长期，秒' },
      { id: 'json', text: '高级参数  JSON：思考映射、采样、输入限制与兼容性' },
      { id: 'reset', text: '恢复自动  清除本模型的全部参数覆盖；保存后生效' },
      { id: 'save', text: '保存参数  写入 models.json 并应用；Esc 放弃草稿' },
    ];
    const selected = await ctx.ui.select('模型参数 · 草稿未保存', options.map(o => o.text));
    const id = options.find(o => o.text === selected)?.id;
    if (!id) return undefined;
    try {
      if (id === 'save') return await validateOverrides(draft);
      if (id === 'reset') { draft = {}; continue; }
      if (id === 'cost' || id === 'promptCache') { await nested(id); continue; }
      if (id === 'json') {
        const text = await ctx.ui.editor('高级参数 · 原生参数覆盖（{} 恢复自动）', JSON.stringify(draft, null, 2));
        if (text !== undefined) draft = editableOverride(await validateOverrides(parseOverrides(text)));
        continue;
      }
      const next = structuredClone(draft);
      if (id === 'input' || id === 'reasoning') {
        const choices = id === 'input' ? ['自动', '文本', '文本与图片'] : ['自动', '支持思考', '不支持思考'];
        const choice = await ctx.ui.select(id === 'input' ? '输入类型' : '思考能力', choices);
        if (!choice) continue;
        if (choice === '自动') delete next[id];
        else next[id] = id === 'input' ? (choice === '文本' ? ['text'] : ['text', 'image']) : choice === '支持思考';
      } else {
        const text = await ctx.ui.input(`${fields.find(f => f[0] === id)![1]} · 留空恢复自动`, display(draft[id] ?? automatic[id]));
        if (text === undefined) continue;
        if (!text.trim()) delete next[id]; else next[id] = id === 'name' ? text : numberValue(text);
      }
      draft = await validateOverrides(next);
    } catch (e) { ctx.ui.notify(e instanceof Error ? e.message : '参数无效；草稿未改变', 'warning'); }
  }
}
