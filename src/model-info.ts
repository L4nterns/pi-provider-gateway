import type { Model, Api } from '@earendil-works/pi-ai';
import type { Connection, GatewayModel, Row } from './types.ts';
import { display, nativeOverride } from './model-config.ts';
import { own, record } from './types.ts';
import { selectProtocol } from './discovery.ts';

export function modelDetails(model: Model<Api>, base: GatewayModel | undefined, connection: Connection, data?: Row): string {
  const provider = record(record(data?.providers)?.[connection.id]);
  const definition = Array.isArray(provider?.models) ? provider.models.find(m => record(m)?.id === model.id) as Row | undefined : undefined;
  const override = data ? nativeOverride(data, connection.id, model.id) : {};
  const sources = base?.gateway.source ?? {};
  const matches = (actual: unknown, configured: unknown): boolean => {
    const object = record(configured);
    return object ? !!record(actual) && Object.entries(object).every(([k, v]) => matches(record(actual)![k], v)) : JSON.stringify(actual) === JSON.stringify(configured);
  };
  const configured = (field: string) => override[field] ?? definition?.[field];
  const native = (field: string) => configured(field) !== undefined;
  const source = (field: string) => {
    if (!data) return '来源未确认';
    if (native(field)) return matches((model as unknown as Row)[field], configured(field)) ? 'models.json' : '磁盘修改待刷新';
    if (definition) return 'Pi 原生模型默认';
    return sources[field] ?? (field === 'compat' ? 'Gateway 端点策略' : '当前 Pi 配置');
  };
  const field = (label: string, key: string, value: unknown) => `  ${label}：${display(value)}  [${source(key)}]`;
  const lines = [
    `服务：${display(connection.id)}`, `模型：${display(model.id)}`, '', '生效参数',
    field('名称', 'name', model.name),
    field('上下文', 'contextWindow', `${model.contextWindow.toLocaleString('en-US')} tokens`),
    field('最大输出', 'maxTokens', `${model.maxTokens.toLocaleString('en-US')} tokens`),
    field('输入', 'input', model.input.join('、')),
    field('推理', 'reasoning', model.reasoning ? '支持' : '不支持'),
  ];
  if (base?.gateway.limits?.contextWindow) {
    const cap = base.gateway.limits.contextWindow;
    lines.push(`  上下文上限：${cap.raw.toLocaleString('en-US')} → ${cap.effective.toLocaleString('en-US')}（cap ${cap.cap.toLocaleString('en-US')}）  [gateway policy]`);
  }
  if (base?.gateway.limits?.maxTokens) {
    const cap = base.gateway.limits.maxTokens;
    lines.push(`  输出上限：${cap.raw.toLocaleString('en-US')} → ${cap.effective.toLocaleString('en-US')}（cap ${cap.cap.toLocaleString('en-US')}）  [gateway policy]`);
  }
  for (const key of ['thinkingLevelMap', 'inputLimits', 'promptCache', 'samplingParams', 'samplingParamsByThinkingLevel', 'compat'] as const) {
    if (model[key] !== undefined) lines.push(field(key, key, model[key]));
  }
  lines.push('', '协议', `  实际使用：${display(model.api)}`, `  自动优选：${selectProtocol(model.id, base?.gateway.protocols ?? []) ?? '未知'}`,
    `  模型指定：${own(connection.modelProtocols, model.id) ?? '自动'}`, `  服务指定：${connection.protocol ?? '自动'}`,
    `  发现证据：${base?.gateway.protocolEvidence ?? '未知'}`);
  if (definition?.api) lines.push('  models.json 有模型协议替换；它优先于 Gateway 选择');
  const cost = model.cost;
  const nativeCost = { ...record(definition?.cost), ...record(override.cost) };
  const rates = [['输入', 'input'], ['输出', 'output'], ['缓存读取', 'cacheRead'], ['缓存写入', 'cacheWrite']] as const;
  const unknownCost = !!data && (!!definition || sources.cost === 'unverified-default');
  lines.push('', '价格 · USD / 百万 tokens');
  for (const [label, key] of rates) {
    const from = !data ? '来源未确认' : nativeCost[key] !== undefined ? matches(cost[key], nativeCost[key]) ? 'models.json' : '磁盘修改待刷新' : definition ? 'Pi 原生模型默认' : sources.cost ?? '当前 Pi 配置';
    lines.push(`  ${label}：${unknownCost && nativeCost[key] === undefined ? '未知（Pi 以 0 占位，不代表免费）' : cost[key]}  [${from}]`);
  }
  if (cost.tiers?.length) lines.push(`  阶梯价格：${display(cost.tiers)}`);
  if (data && rates.some(([, key]) => nativeCost[key] === undefined) && !unknownCost && !definition && sources.cost !== 'endpoint') lines.push('  公共目录参考价，不是该网关的实际账单');
  const unverified = !data || definition ? [] : Object.entries(sources).filter(([k, v]) => k !== 'cost' && v === 'unverified-default' && !native(k)).map(([k]) => k);
  if (unverified.length) lines.push('', `未验证默认值：${unverified.join('、')}`);
  if (!data) lines.push('', '未能解析原生覆盖来源；上方参数仍是当前 Pi 生效值');
  return lines.join('\n');
}
