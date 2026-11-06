import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { atomicJson, locked, Store } from './storage.ts';
import { record, type Row } from './types.ts';

// Parameter edits live in Pi's native overrides, not in a second model registry.
// Authentication and endpoints are intentionally not offered in this editor.
export const MODEL_FIELDS = ['name', 'reasoning', 'thinkingLevelMap', 'input', 'inputLimits', 'cost', 'promptCache', 'contextWindow', 'maxTokens', 'samplingParams', 'samplingParamsByThinkingLevel', 'compat'] as const;
export async function modelFile(store: Store): Promise<{ raw: string | undefined; data: Row }> {
  const path = join(store.dir, 'models.json');
  let raw: string, file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    const limit = 2 * 1024 * 1024;
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('unsafe');
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > limit) throw new Error('unsafe');
    raw = bytes.subarray(0, size).toString('utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { raw: undefined, data: { providers: {} } };
    throw new Error('无法安全读取 models.json；未修改文件');
  } finally { await file?.close(); }
  let data: Row | undefined;
  try { data = record(JSON.parse(raw)); } catch { /* Native refresh still accepts JSONC. */ }
  if (!data || !record(data.providers)) throw new Error('编辑模型需要标准 JSON 的 models.json；含注释的文件请在外部编辑后选择「刷新模型」。未修改文件');
  return { raw, data };
}
export function nativeOverride(data: Row, service: string, model: string): Row {
  return record(record(record(record(data.providers)?.[service])?.modelOverrides)?.[model]) ?? {};
}
export function editableOverride(value: Row): Row {
  return Object.fromEntries(MODEL_FIELDS.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
}
export async function validateModelPath(path: string, providers: readonly Provider[] = []): Promise<void> {
  const runtime = await ModelRuntime.create({ modelsPath: path, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  // Validation must never call a live provider's refresh function.
  for (const provider of providers) runtime.registerNativeProvider({ ...provider, refreshModels: undefined });
  if (runtime.getError()) throw new Error('模型参数不符合当前 Pi 的 models.json 格式；未写入、未刷新');
}
async function validateDocument(data: Row, providers: readonly Provider[] = []): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-model-validation-'));
  try { const path = join(dir, 'models.json'); await atomicJson(path, data); await validateModelPath(path, providers); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
export async function validateOverrides(value: unknown): Promise<Row> {
  const override = record(value);
  if (!override || Object.keys(override).some(k => !(MODEL_FIELDS as readonly string[]).includes(k))) throw new Error('只允许模型参数；协议使用「协议偏好」设置，URL 和凭据使用「编辑服务 → 连接配置」');
  await validateDocument({ providers: { gatewayValidation: { modelOverrides: { model: override } } } });
  return override;
}
export async function saveOverrides(store: Store, service: string, model: string, expected: string | undefined, override: Row, nativeProviders: readonly Provider[] = []): Promise<void> {
  const path = join(store.dir, 'models.json');
  await locked(path, async () => {
    const file = await modelFile(store);
    if (file.raw !== expected) throw new Error('models.json 已被其他操作者修改，请重新打开菜单；未覆盖');
    const providers = record(file.data.providers)!;
    const provider = record(providers[service]) ?? {};
    const all = { ...(record(provider.modelOverrides) ?? {}) };
    // Preserve even unsupported/credential-bearing existing fields, without ever
    // putting them into the editor. Remove only the editable fields on this model.
    const previous = record(all[model]) ?? {};
    const next = { ...Object.fromEntries(Object.entries(previous).filter(([k]) => !(MODEL_FIELDS as readonly string[]).includes(k))), ...override };
    if (Object.keys(next).length) Object.defineProperty(all, model, { value: next, enumerable: true, configurable: true, writable: true }); else delete all[model];
    if (Object.keys(all).length) provider.modelOverrides = all; else delete provider.modelOverrides;
    if (Object.keys(provider).length) providers[service] = provider; else delete providers[service];
    await validateDocument(file.data, nativeProviders);
    // External editors need not cooperate with our lock. Recheck after validation
    // and before replacement, including edits to unrelated providers.
    if ((await modelFile(store)).raw !== expected) throw new Error('models.json 已被其他操作者修改，请重新打开菜单；未覆盖');
    await atomicJson(path, file.data);
  });
}
export function parseOverrides(text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error('模型参数不是有效 JSON；未写入。请重新编辑'); }
}
export const display = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value) ?? '未设置').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
