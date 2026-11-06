import type { Model, ThinkingLevelMap } from '@earendil-works/pi-ai';

export const PROTOCOLS = ['openai-responses', 'anthropic-messages', 'google-generative-ai', 'openai-completions'] as const;
export type Protocol = typeof PROTOCOLS[number];
export type Row = Record<string, unknown>;
export type GatewayModel = Model<Protocol> & {
  gateway: { binding?: string; source: Record<string, string>; protocols: Protocol[]; protocolEvidence: string; warnings: string[] };
};
export interface Connection {
  id: string;
  name: string;
  // No credentials, model lists or upstream routing configuration here.
  url?: string;
  protocol?: Protocol;
  modelProtocols?: Record<string, Protocol>;
}
export interface Registry { version: 1; connections: Connection[] }
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
export const record = (x: unknown): Row | undefined => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Row : undefined;
export const clean = (x: string): string => x.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 256);
export const safeId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256 && x === x.trim() && clean(x) === x && !['__proto__', 'prototype', 'constructor'].includes(x);
export const positive = (...xs: unknown[]): number | undefined => xs.map(Number).find(x => Number.isSafeInteger(x) && x > 0 && x <= 10_000_000);
export const strings = (x: unknown): string[] => Array.isArray(x) ? x.filter((x): x is string => typeof x === 'string') : [];
