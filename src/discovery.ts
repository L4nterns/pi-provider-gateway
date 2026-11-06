import { createHash } from 'node:crypto';
import { PROTOCOLS, record, safeId, strings, type Discovery, type ProbeResult, type Protocol, type Row } from './types.ts';

export function normalizeUrl(value: string): string {
  let u: URL;
  try { u = new URL(value.trim()); } catch { throw new Error('请输入有效的 http(s) URL'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('URL 不能含凭据、查询参数或片段');
  if (/[\x00-\x20\x7f]/.test(value.trim())) throw new Error('URL 含非法字符');
  u.pathname = u.pathname.replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|responses(?:\/compact)?|messages|models)$/, '')
    .replace(/\/v1(?:beta)?$/, '');
  return u.href.replace(/\/+$/, '');
}
export function baseFor(root: string, api: Protocol): string {
  const u = normalizeUrl(root);
  return api === 'anthropic-messages' ? u : `${u}/${api === 'google-generative-ai' ? 'v1beta' : 'v1'}`;
}
export const fingerprint = (root: string, key: string): string => createHash('sha256').update(JSON.stringify([normalizeUrl(root), key])).digest('hex');

// Never follow authenticated redirects, print response bodies, or accept unbounded JSON.
export async function requestJson(url: string, init: RequestInit = {}, maxBytes = 4 * 1024 * 1024, probeApi?: Protocol): Promise<unknown> {
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(15000)]);
  let res: Response;
  try { res = await fetch(url, { ...init, signal, redirect: 'error' }); }
  catch { signal.throwIfAborted(); throw new Error('连接失败（或服务返回了重定向）'); }
  try {
    if (!res.ok) throw new HttpError(res.status);
    if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('服务响应过大');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('服务返回空响应');
    const chunks: Uint8Array[] = []; let size = 0;
    const streaming = probeApi && res.headers.get('content-type')?.includes('text/event-stream');
    const decoder = new TextDecoder(); let pending = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('服务响应过大'); }
      if (streaming) {
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = frame.split('\n').filter(s => s.startsWith('data:')).map(s => s.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          let event: unknown; try { event = JSON.parse(data); } catch { continue; }
          const verdict = probeStreamEvent(probeApi!, event);
          if (verdict !== undefined) { await reader.cancel(); return verdict ? probeSuccess(probeApi!) : { error: 'stream-error' }; }
        }
      } else chunks.push(value);
    }
    if (streaming) throw new Error('流中没有有效协议结果');
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('服务没有返回有效 JSON'); }
  } finally { await res.body?.cancel().catch(() => {}); }
}
export class HttpError extends Error { readonly status: number; constructor(status: number) { super(`HTTP ${status}`); this.status = status; } }
export function headers(key: string, api?: Protocol): Record<string, string> {
  // Use one protocol's auth headers at a time: negotiation headers can change catalog shape.
  return { 'content-type': 'application/json',
    ...(api === 'google-generative-ai' ? { 'x-goog-api-key': key } : api === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` }) };
}
export function decodeRows(payload: unknown): Row[] {
  const r = record(payload);
  const rows = Array.isArray(payload) ? payload : r?.data ?? r?.models;
  if (!Array.isArray(rows)) throw new Error('模型目录缺少 data/models 数组');
  const seen = new Set<string>();
  const valid: Row[] = [];
  for (const item of rows) {
    const row = record(item); if (!row) continue;
    const id = row.id ?? row.name;
    if (!safeId(id) || seen.has(id)) continue;
    seen.add(id); valid.push({ ...row, id });
  }
  if (rows.length && !valid.length) throw new Error('目录没有有效模型');
  return valid;
}
async function catalogPages(url: string, auth: Record<string, string>, signal: AbortSignal): Promise<Row[]> {
  const all: Row[] = []; const cursors = new Set<string>(); let page = url;
  for (let i = 0; i < 100; i++) {
    const raw = await requestJson(page, { headers: auth, signal }); const rows = decodeRows(raw); const r = record(raw); all.push(...rows);
    if (all.length > 10000) throw new Error('模型目录超过安全上限');
    const gemini = typeof r?.nextPageToken === 'string' && r.nextPageToken.length > 0;
    if (!gemini && r?.has_more !== true) return decodeRows(all);
    const cursor = gemini ? r!.nextPageToken : r?.last_id ?? rows.at(-1)?.id;
    if (typeof cursor !== 'string' || !cursor.length || cursor.length > 512 || cursors.has(cursor)) throw new Error('模型目录分页无效；未采用不完整目录');
    cursors.add(cursor); const next = new URL(url); next.searchParams.set(gemini ? 'pageToken' : 'after_id', cursor); page = next.href;
  }
  throw new Error('模型目录分页过多');
}
export async function fetchCatalog(root: string, key: string, signal: AbortSignal): Promise<Row[]> {
  const url = normalizeUrl(root);
  // Common OpenAI/Anthropic discovery endpoint. A Gemini-only endpoint is the fallback.
  try {
    return await catalogPages(`${url}/v1/models`, headers(key), signal);
  } catch (e) {
    if (e instanceof HttpError && [401, 403].includes(e.status)) {
      try { return await catalogPages(`${url}/v1/models`, headers(key, 'anthropic-messages'), signal); }
      catch (fallback) { if (!(fallback instanceof HttpError) || ![401, 403, 404, 405].includes(fallback.status)) throw fallback; }
    } else if (!(e instanceof HttpError) || ![404, 405].includes(e.status)) throw e;
    return catalogPages(`${url}/v1beta/models`, headers(key, 'google-generative-ai'), signal);
  }
}
const ENDPOINTS: Record<string, Protocol> = {
  '/v1/responses': 'openai-responses', '/responses': 'openai-responses', 'responses': 'openai-responses', 'openai-response': 'openai-responses',
  '/v1/chat/completions': 'openai-completions', '/chat/completions': 'openai-completions', 'chat': 'openai-completions', 'openai': 'openai-completions',
  '/v1/messages': 'anthropic-messages', '/messages': 'anthropic-messages', 'anthropic': 'anthropic-messages',
  'gemini': 'google-generative-ai', 'generateContent': 'google-generative-ai',
};
export function declaredProtocols(row: Row): Protocol[] {
  const names = [...strings(row.native_endpoints), ...strings(row.supported_endpoint_types), ...strings(row.endpoints)];
  const explicit = typeof row.api === 'string' && PROTOCOLS.includes(row.api as Protocol) ? [row.api as Protocol] : [];
  if (strings(row.supportedGenerationMethods).includes('generateContent')) explicit.push('google-generative-ai');
  return [...new Set([...explicit, ...names.flatMap(s => ENDPOINTS[s.replace(/\/+$/, '')] ?? [])])];
}
export function preference(id: string): Protocol[] {
  // This is preference ONLY among declared/proven protocols, never evidence of support.
  const name = id.toLowerCase();
  if (name.includes('claude')) return ['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'];
  if (name.includes('gemini')) return ['google-generative-ai', 'openai-responses', 'openai-completions', 'anthropic-messages'];
  return ['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai'];
}
export function selectProtocol(id: string, supported: Protocol[], override?: Protocol): Protocol | undefined {
  return override ?? preference(id).find(p => supported.includes(p));
}
export function tinyRequest(root: string, api: Protocol, model: string): { url: string; body: Row } {
  const base = baseFor(root, api);
  if (api === 'openai-responses') return { url: `${base}/responses`, body: { model, input: 'Reply OK.', max_output_tokens: 32, stream: true } };
  if (api === 'anthropic-messages') return { url: `${base}/v1/messages`, body: { model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 32, stream: true } };
  if (api === 'google-generative-ai') return { url: `${base}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`, body: { contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }], generationConfig: { maxOutputTokens: 32 } } };
  const field = /(?:^|\/)(?:gpt-|o[134](?:-|$))/.test(model.toLowerCase()) ? 'max_completion_tokens' : 'max_tokens';
  return { url: `${base}/chat/completions`, body: { model, messages: [{ role: 'user', content: 'Reply OK.' }], [field]: 32, stream: true } };
}
export function validProbeResponse(api: Protocol, raw: unknown): boolean {
  const r = record(raw); if (!r || r.error) return false;
  if (api === 'openai-responses') return r.object === 'response' && !['failed', 'cancelled'].includes(String(r.status)) && Array.isArray(r.output);
  if (api === 'anthropic-messages') return r.type === 'message' && Array.isArray(r.content);
  if (api === 'google-generative-ai') return Array.isArray(r.candidates) && r.candidates.length > 0;
  return Array.isArray(r.choices) && r.choices.some(c => !!record(c)?.message);
}
function probeSuccess(api: Protocol): unknown {
  if (api === 'openai-responses') return { object: 'response', output: [], status: 'completed' };
  if (api === 'anthropic-messages') return { type: 'message', content: [] };
  if (api === 'google-generative-ai') return { candidates: [{}] };
  return { choices: [{ message: {} }] };
}
export function probeStreamEvent(api: Protocol, value: unknown): boolean | undefined {
  const r = record(value); if (!r) return undefined;
  if (r.error || r.type === 'error' || r.type === 'response.failed') return false;
  if (api === 'openai-responses') {
    if (['response.output_text.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(String(r.type)) && typeof r.delta === 'string' && r.delta.length > 0) return true;
    if (['response.completed', 'response.incomplete'].includes(String(r.type))) return validProbeResponse(api, r.response);
  }
  if (api === 'anthropic-messages') {
    const delta = record(r.delta);
    if (r.type === 'content_block_delta' && (typeof delta?.text === 'string' || typeof delta?.thinking === 'string')) return true;
    if (r.type === 'message_delta' && typeof record(r.delta)?.stop_reason === 'string') return true;
  }
  if (api === 'openai-completions' && Array.isArray(r.choices)) {
    for (const c of r.choices) {
      const choice = record(c); const delta = record(choice?.delta);
      if (typeof delta?.content === 'string' && delta.content.length || typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length || Array.isArray(delta?.tool_calls) && delta.tool_calls.length || typeof choice?.finish_reason === 'string') return true;
    }
  }
  if (api === 'google-generative-ai' && validProbeResponse(api, r)) return true;
  return undefined;
}
export async function probeProtocol(root: string, key: string, api: Protocol, model: string, signal: AbortSignal): Promise<ProbeResult> {
  const { url, body } = tinyRequest(root, api, model);
  try {
    const raw = await requestJson(url, { method: 'POST', headers: headers(key, api), body: JSON.stringify(body), signal }, 256 * 1024, api);
    return { api, model, ok: validProbeResponse(api, raw), status: 200, ...(!validProbeResponse(api, raw) ? { reason: '响应不是该协议的成功结果' } : {}) };
  } catch (e) {
    signal.throwIfAborted();
    return { api, model, ok: false, ...(e instanceof HttpError ? { status: e.status } : {}), reason: e instanceof HttpError ? `HTTP ${e.status}（不能据此断定不支持）` : '连接失败或超时（未知）' };
  }
}
export function chatRow(row: Row): boolean {
  const id = String(row.id).toLowerCase();
  const output = strings(record(row.modalities)?.output ?? row.output_modalities);
  if (output.length && !output.includes('text')) return false;
  return !/(?:embedding|rerank|whisper|dall-e|gpt-image|imagen-|^flux[.-]|tts|^sora|image-generation)/.test(id);
}
export async function discover(root: string, key: string, signal: AbortSignal, options: { probe?: boolean; previous?: Discovery } = {}): Promise<Discovery> {
  const rows = (await fetchCatalog(root, key, signal)).filter(chatRow);
  const protocols: Discovery['protocols'] = {}; const evidence: Discovery['evidence'] = {}; const probes: ProbeResult[] = [];
  // Only missing declarations need POST probes. Limit concurrent requests, not model coverage.
  const jobs = rows.map(row => async () => {
    const id = String(row.id); const declared = declaredProtocols(row);
    if (declared.length) { protocols[id] = declared; evidence[id] = 'endpoint'; return; }
    if (options.previous?.protocols[id]?.length && !options.probe) {
      protocols[id] = options.previous.protocols[id]; evidence[id] = options.previous.evidence[id]; return;
    }
    if (!options.probe) return;
    const results: ProbeResult[] = [];
    for (const api of preference(id)) { signal.throwIfAborted(); results.push(await probeProtocol(root, key, api, id, signal)); }
    probes.push(...results); protocols[id] = results.filter(r => r.ok).map(r => r.api); evidence[id] = 'probe';
  });
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => { while (cursor < jobs.length) await jobs[cursor++](); }));
  return { rows, protocols, evidence, probes };
}
