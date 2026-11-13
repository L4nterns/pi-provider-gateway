import type { Model, Api } from '@earendil-works/pi-ai';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { baseFor, selectProtocol } from './discovery.ts';
import { LEVELS, clean, own, positive, record, strings, type Connection, type Discovery, type EffortMap, type GatewayModel, type Protocol, type Row } from './types.ts';

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
const normalizedName = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
// Canonical vendor models. A gateway ID is a reference only while it still equals
// the vendor's declared display name, so dated snapshots (-1017) and future
// renames resolve to their own metadata instead of borrowing another version.
const REFERENCES: Record<string, { provider: string; id: string }> = {
  'deepseek-v4.1-flash': { provider: 'deepseek', id: 'deepseek-flash' },
};
let builtinIndex: { providers: Map<string, Map<string, Metadata>>; models: Map<string, Metadata[]> } | undefined;
function catalogRow(catalog: Row, provider: string, id: string): Row | undefined {
  return record(record(record(own(catalog, provider))?.models)?.[id]);
}
function referenceMetadata(key: string, catalog: Row): Metadata | undefined {
  const wanted = normalizedName(key);
  for (const reference of Object.values(REFERENCES)) {
    const original = builtinIndex!.providers.get(reference.provider)?.get(reference.id);
    if (original?.name && normalizedName(original.name) === wanted) return original;
    const row = catalogRow(catalog, reference.provider, reference.id);
    if (typeof row?.name === 'string' && normalizedName(row.name) === wanted) return catalogMetadata(row, reference.provider);
  }
  return undefined;
}
export function builtinMetadata(id: string, catalog: Row = {}): Metadata | undefined {
  if (!builtinIndex) {
    builtinIndex = { providers: new Map(), models: new Map() };
    for (const provider of getBuiltinProviders()) for (const model of getBuiltinModels(provider)) {
      const entry: Metadata = {
        name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        reasoning: model.reasoning, input: [...model.input], thinkingLevelMap: model.thinkingLevelMap && { ...model.thinkingLevelMap },
        cost: structuredClone(model.cost), source: `pi:${provider}`,
      };
      let models = builtinIndex.providers.get(provider);
      if (!models) { models = new Map(); builtinIndex.providers.set(provider, models); }
      models.set(model.id, entry);
      builtinIndex.models.set(model.id, [...(builtinIndex.models.get(model.id) ?? []), entry]);
    }
  }
  const keys = [...new Set([id, normalizedId(id)])];
  for (const key of keys) {
    const reference = referenceMetadata(key, catalog);
    if (reference) return reference;
    const provider = owner(key);
    const exact = provider && builtinIndex.providers.get(provider)?.get(key);
    if (exact) return exact;
  }
  for (const key of keys) {
    const found = builtinIndex.models.get(key);
    if (found?.length === 1) return found[0];
    // Multiple deployments with differing limits must not arbitrarily win by catalog order.
  }
  return undefined;
}
export function effortMap(values: unknown, toggle = false): EffortMap | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const efforts = values.flatMap(x => typeof x === 'string' ? [x] : typeof record(x)?.effort === 'string' ? [String(record(x)!.effort)] : []);
  if (!efforts.length) return undefined;
  const result: EffortMap = {};
  for (const level of LEVELS) {
    if (level === 'off') {
      const mapped = efforts.find(x => ['off', 'none', 'disabled'].includes(x));
      // A declared on/off toggle already proves thinking can be disabled; only an
      // explicit absence of both forms means off is unsupported.
      if (mapped !== undefined) result.off = mapped;
      else if (!toggle) result.off = null;
      continue;
    }
    const mapped = efforts.find(x => x === level || level === 'max' && x === 'ultra');
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
function catalogMetadata(row: Row, provider: string): Metadata {
  const meta = fromRow(row, `models.dev:${provider}`);
  const modalities = record(row.modalities);
  if (Array.isArray(modalities?.input)) meta.input = ['text', ...(strings(modalities.input).includes('image') ? ['image' as const] : [])];
  const opts = Array.isArray(row.reasoning_options) ? row.reasoning_options : [];
  const toggle = opts.some(o => record(o)?.type === 'toggle');
  if (opts.length) meta.thinkingLevelMap = effortMap(record(opts.find(o => record(o)?.type === 'effort'))?.values, toggle);
  const cost = record(row.cost);
  if (cost) {
    const rate = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    meta.cost = { input: rate(cost.input), output: rate(cost.output), cacheRead: rate(cost.cache_read), cacheWrite: rate(cost.cache_write) };
  }
  return meta;
}
export function publicMetadata(id: string, catalog: Row): Metadata | undefined {
  const key = normalizedId(id); const own = owner(key);
  const entries: Metadata[] = [];
  for (const [provider, raw] of Object.entries(catalog)) {
    const models = record(record(raw)?.models); const row = record(models?.[id] ?? models?.[key]);
    if (!row) continue;
    const meta = catalogMetadata(row, provider);
    if (own === provider) return meta;
    entries.push(meta);
  }
  return entries.length === 1 ? entries[0] : undefined;
}
export function buildModels(connection: Connection, root: string, discovery: Discovery, catalog: Row = {}): GatewayModel[] {
  const result: GatewayModel[] = [];
  for (const row of discovery.rows) {
    const id = String(row.id);
    const protocols = own(discovery.protocols, id) ?? [];
    const override = own(connection.modelProtocols, id) ?? connection.protocol;
    const api = selectProtocol(id, protocols, override);
    if (!api) continue; // Unknown is not silently Chat Completions.
    const remote = fromRow(row);
    const builtin = builtinMetadata(id, catalog);
    const external = publicMetadata(id, catalog);
    const sources: Record<string, string> = {};
    const take = <K extends keyof Metadata>(key: K, fallback: NonNullable<Metadata[K]>): NonNullable<Metadata[K]> => {
      for (const m of [remote, builtin, external]) if (m?.[key] !== undefined) { sources[key] = m.source; return m[key] as NonNullable<Metadata[K]>; }
      sources[key] = 'unverified-default'; return fallback;
    };
    const reasoning = take('reasoning', false);
    const map = reasoning ? take('thinkingLevelMap', {}) : undefined;
    const contextWindow = take('contextWindow', 128000);
    const maxTokens = Math.min(take('maxTokens', 16384), contextWindow);
    const apiEvidence = override ? 'user' : own(discovery.evidence, id) ?? 'unknown';
    const warnings: string[] = [];
    const cost = take('cost', zeroCost());
    const name = take('name', id), input = take('input', ['text']);
    if (sources.cost === 'unverified-default') warnings.push('价格未知；Pi 的 0 占位不代表免费');
    else if (sources.cost !== 'endpoint') warnings.push('价格为公共目录参考值，并非网关账单');
    if (Object.entries(sources).some(([k, v]) => k !== 'cost' && v === 'unverified-default')) warnings.push('部分能力没有可靠元数据，使用未验证默认值');
    const model: GatewayModel = {
      id, name, provider: connection.id, api, baseUrl: baseFor(root, api),
      contextWindow, maxTokens, reasoning, input, cost,
      ...(map ? { thinkingLevelMap: map } : {}),
      gateway: { source: sources, protocols, protocolEvidence: apiEvidence, warnings },
    };
    // Deliberately no official compat inheritance. Only verified endpoint policies below.
    if (api === 'openai-responses') model.compat = { supportsExplicitPromptCacheMode: false };
    if (api === 'openai-completions') {
      // A custom gateway ID/URL defeats Pi's first-party URL detection. Use the
      // standard system role and omit optional storage unless the user opts in.
      // DeepSeek needs its explicit thinking switch and reasoning replay fields.
      const deepseek = /^(?:[^/]+\/)?deepseek(?:[/-]|$)/i.test(id);
      model.compat = {
        supportsDeveloperRole: false, supportsStore: false,
        supportsReasoningEffort: reasoning,
        maxTokensField: /(?:^|\/)(?:gpt-|o[134](?:-|$))/.test(id.toLowerCase()) ? 'max_completion_tokens' : 'max_tokens',
        ...(deepseek ? { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true } : {}),
      };
    }
    if (api === 'anthropic-messages' && (map?.max || map?.xhigh)) model.compat = { forceAdaptiveThinking: true };
    result.push(model);
  }
  return result;
}
