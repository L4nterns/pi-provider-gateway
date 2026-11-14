import type { Model, ThinkingLevelMap } from '@earendil-works/pi-ai';

export const PROTOCOLS = ['openai-responses', 'anthropic-messages', 'google-generative-ai', 'openai-completions'] as const;
export type Protocol = typeof PROTOCOLS[number];
export type GatewayOperation = <T>(message: string, signal: AbortSignal, work: (signal: AbortSignal, report: (message: string) => void) => Promise<T>) => Promise<T>;
export type Row = Record<string, unknown>;
export interface AppliedCap { raw: number; effective: number; cap: number }
export type GatewayModel = Model<Protocol> & {
  gateway: {
    binding?: string;
    source: Record<string, string>;
    protocols: Protocol[];
    protocolEvidence: string;
    warnings: string[];
    limits?: { contextWindow?: AppliedCap; maxTokens?: AppliedCap };
  };
};
// Limits are transport policy, not an upstream capability claim. `null` means
// explicitly uncapped; an omitted field inherits the registry policy.
export interface Limits {
  contextWindowCap?: number | null;
  maxTokensCap?: number | null;
}
export type GatewayPolicy = Limits;
export const DEFAULT_LIMITS = { contextWindowCap: 272_000, maxTokensCap: 65_536 } as const;
export interface Connection {
  id: string;
  name: string;
  // No credentials, model lists or upstream routing configuration here.
  url?: string;
  protocol?: Protocol;
  modelProtocols?: Record<string, Protocol>;
  limits?: Limits;
}
export interface Registry { version: 1; connections: Connection[]; policy?: GatewayPolicy }
export interface ProbeResult { api: Protocol; model: string; ok: boolean; status?: number; reason?: string }
export interface Discovery {
  rows: Row[];
  protocols: Record<string, Protocol[]>;
  evidence: Record<string, string>;
  probes: ProbeResult[];
}
export interface Snapshot {
  version: 1;
  fingerprint: string;
  checkedAt: number;
  discovery: Discovery;
}
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortMap = ThinkingLevelMap;
export const own = <T>(object: Record<string, T> | undefined, key: string): T | undefined => object && Object.hasOwn(object, key) ? object[key] : undefined;
export const record = (x: unknown): Row | undefined => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Row : undefined;
export const clean = (x: string): string => x.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 256);
export const safeId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256 && x === x.trim() && clean(x) === x && !['__proto__', 'prototype', 'constructor'].includes(x);
export const positive = (...xs: unknown[]): number | undefined => xs.map(Number).find(x => Number.isSafeInteger(x) && x > 0 && x <= 10_000_000);
export const strings = (x: unknown): string[] => Array.isArray(x) ? x.filter((x): x is string => typeof x === 'string') : [];
const choose = (value: number | null | undefined, fallback: number | null): number | null => value === undefined ? fallback : value;
export function effectiveLimits(connection: Connection = { id: '', name: '' }, policy: GatewayPolicy = {}) {
  return {
    contextWindowCap: choose(connection.limits?.contextWindowCap, choose(policy.contextWindowCap, DEFAULT_LIMITS.contextWindowCap)),
    maxTokensCap: choose(connection.limits?.maxTokensCap, choose(policy.maxTokensCap, DEFAULT_LIMITS.maxTokensCap)),
  };
}
