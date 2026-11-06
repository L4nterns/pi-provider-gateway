import type { Model, Api } from '@earendil-works/pi-ai';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { baseFor, selectProtocol } from './discovery.ts';
import { LEVELS, clean, positive, record, strings, type Connection, type Discovery, type EffortMap, type GatewayModel, type Protocol, type Row } from './types.ts';

export interface Metadata {
  name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean;
  input?: ('text' | 'image')[]; thinkingLevelMap?: EffortMap;
  cost?: Model<Api>['cost']; source: string;
}
const zeroCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function owner(id: string): string | undefined {
  const name = id.toLowerCase();
  if (/^(?:gpt-|o[134](?:-|$))/.test(name)) return 'openai';
  if (name.startsWith('claude')) return 'anthropic';
  if (name.startsWith('gemini')) return 'google';
  if (name.startsWith('deepseek')) return 'deepseek';
  if (name.startsWith('grok')) return 'xai';
  return undefined;
}
const normalizedId = (id: string) => id.replace(/^models\//, '').replace(/^[^/]+\//, '').replace(/:free$/, '');
let builtinIndex: Map<string, Metadata[]> | undefined;
export function builtinMetadata(id: string): Metadata | undefined {
  if (!builtinIndex) {
    builtinIndex = new Map();
    for (const provider of getBuiltinProviders()) for (const model of getBuiltinModels(provider)) {
      const entry: Metadata = {
        name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        reasoning: model.reasoning, input: [...model.input], thinkingLevelMap: model.thinkingLevelMap && { ...model.thinkingLevelMap },
        cost: structuredClone(model.cost), source: `pi:${provider}`,
      };
      const key = `${provider}/${model.id}`;
      builtinIndex.set(key, [entry]);
      builtinIndex.set(model.id, [...(builtinIndex.get(model.id) ?? []), entry]);
    }
  }
  for (const key of [...new Set([id, normalizedId(id)])]) {
    const own = owner(key);
    const exact = own && builtinIndex.get(`${own}/${key}`)?.[0];
    if (exact) return exact;
    const found = builtinIndex.get(key);
    if (found?.length === 1) return found[0];
    // Multiple deployments with differing limits must not arbitrarily win by catalog order.
  }
  return undefined;
}
export function effortMap(values: unknown): EffortMap | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const efforts = values.flatMap(x => typeof x === 'string' ? [x] : typeof record(x)?.effort === 'string' ? [String(record(x)!.effort)] : []);
  if (!efforts.length) return undefined;
  const result: EffortMap = {};
  for (const level of LEVELS) {
    const mapped = level === 'off' ? efforts.find(x => ['off', 'none', 'disabled'].includes(x)) : efforts.find(x => x === level || level === 'max' && x === 'ultra');
    result[level] = mapped ?? null;
  }
  return result;
}
function bool(...xs: unknown[]): boolean | undefined { return xs.find((x): x is boolean => typeof x === 'boolean'); }
export function fromRow(row: Row, source = 'endpoint'): Metadata {
  const limit = record(row.limit) ?? {}; const limits = record(row.limits) ?? {}; const cap = record(row.capabilities) ?? {};
  const modalities = record(row.modalities) ?? {}; const architecture = record(row.architecture) ?? {};
  const kinds = strings(row.input ?? row.input_modalities ?? modalities.input ?? architecture.input_modalities);
  const vision = bool(row.image_input, row.supports_vision, cap.vision);
  const thinkingLevelMap = effortMap(row.supported_reasoning_levels ?? row.reasoning_levels ?? row.thinking_levels ?? cap.supported_reasoning_levels);
  const reasoning = bool(row.reasoning, row.supports_reasoning, cap.reasoning, row.thinking) ?? (thinkingLevelMap ? true : undefined);
  return {
    source,
    name: typeof (row.display_name ?? row.name) === 'string' ? clean(String(row.display_name ?? row.name)) : undefined,
    contextWindow: positive(row.contextWindow, row.context_window, row.context_length, row.max_input_tokens, row.inputTokenLimit, limit.context, limits.context_window, limits.context),
    maxTokens: positive(row.maxTokens, row.max_output_tokens, row.max_completion_tokens, row.max_tokens, row.outputTokenLimit, limit.output, limits.max_output_tokens),
    reasoning, thinkingLevelMap,
    input: kinds.length ? ['text', ...(kinds.includes('image') ? ['image' as const] : [])] : vision !== undefined ? ['text', ...(vision ? ['image' as const] : [])] : undefined,
  };
}
// Public metadata may supply capabilities, never endpoint URLs, auth, or wire compat.
export function publicMetadata(id: string, catalog: Row): Metadata | undefined {
  const key = normalizedId(id); const own = owner(key);
  const entries: Metadata[] = [];
  for (const [provider, raw] of Object.entries(catalog)) {
    const models = record(record(raw)?.models); const row = record(models?.[id] ?? models?.[key]);
    if (!row) continue;
    const meta = fromRow(row, `models.dev:${provider}`);
    const modalities = record(row.modalities);
    if (Array.isArray(modalities?.input)) meta.input = ['text', ...(strings(modalities.input).includes('image') ? ['image' as const] : [])];
    const opts = Array.isArray(row.reasoning_options) ? row.reasoning_options : [];
    meta.thinkingLevelMap = effortMap(record(opts.find(o => record(o)?.type === 'effort'))?.values);
    const cost = record(row.cost);
    if (cost) {
      const rate = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
      meta.cost = { input: rate(cost.input), output: rate(cost.output), cacheRead: rate(cost.cache_read), cacheWrite: rate(cost.cache_write) };
    }
    if (own === provider) return meta;
    entries.push(meta);
  }
  return entries.length === 1 ? entries[0] : undefined;
}
export function buildModels(connection: Connection, root: string, discovery: Discovery, catalog: Row = {}): GatewayModel[] {
  const result: GatewayModel[] = [];
  for (const row of discovery.rows) {
    const id = String(row.id);
    const api = selectProtocol(id, discovery.protocols[id] ?? [], connection.modelProtocols?.[id] ?? connection.protocol);
    if (!api) continue; // Unknown is not silently Chat Completions.
    const remote = fromRow(row);
    const builtin = builtinMetadata(id);
    const external = publicMetadata(id, catalog);
    const sources: Record<string, string> = {};
    const take = <K extends keyof Metadata>(key: K, fallback: NonNullable<Metadata[K]>): NonNullable<Metadata[K]> => {
      for (const m of [remote, builtin, external]) if (m?.[key] !== undefined) { sources[key] = m.source; return m[key] as NonNullable<Metadata[K]>; }
      sources[key] = 'unverified-default'; return fallback;
    };
    const reasoning = take('reasoning', false);
    const map = reasoning ? take('thinkingLevelMap', { off: null }) : undefined;
    const contextWindow = take('contextWindow', 128000);
    const maxTokens = Math.min(take('maxTokens', 16384), contextWindow);
    const apiEvidence = connection.modelProtocols?.[id] || connection.protocol ? 'user' : discovery.evidence[id] ?? 'unknown';
    const warnings: string[] = [];
    const cost = take('cost', zeroCost());
    if (sources.cost !== 'endpoint') warnings.push('价格为公共目录估算或未知，并非网关账单');
    if (Object.values(sources).includes('unverified-default')) warnings.push('部分能力没有可靠元数据，使用未验证默认值');
    const model: GatewayModel = {
      id, name: take('name', id), provider: connection.id, api, baseUrl: baseFor(root, api),
      contextWindow, maxTokens, reasoning, input: take('input', ['text']), cost,
      ...(map ? { thinkingLevelMap: map } : {}),
      gateway: { source: sources, protocols: discovery.protocols[id] ?? [api], protocolEvidence: apiEvidence, warnings },
    };
    // Deliberately no official compat inheritance. Only verified endpoint policies below.
    if (api === 'openai-responses') model.compat = { supportsExplicitPromptCacheMode: false };
    if (api === 'openai-completions') model.compat = { supportsReasoningEffort: reasoning, maxTokensField: /(?:^|\/)(?:gpt-|o[134](?:-|$))/.test(id.toLowerCase()) ? 'max_completion_tokens' : 'max_tokens' };
    if (api === 'anthropic-messages' && (map?.max || map?.xhigh)) model.compat = { forceAdaptiveThinking: true };
    result.push(model);
  }
  return result;
}
