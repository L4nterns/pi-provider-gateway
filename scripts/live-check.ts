// Explicit, opt-in real gateway smoke test. No secrets or response bodies in output.
// Uses existing auth in memory; all new settings/caches live in a disposable directory.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { InMemoryCredentialStore, InMemoryModelsStore, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { createGateway } from '../src/provider.ts';
import { Store } from '../src/storage.ts';
import { PROTOCOLS } from '../src/types.ts';
import { probeProtocol } from '../src/discovery.ts';

if (!process.argv.includes('--live')) throw new Error('需要显式 --live 才会发出模型请求');
const sourceId = process.env.GATEWAY_TEST_PROVIDER ?? 'Muze-AI';
const modelId = process.env.GATEWAY_TEST_MODEL ?? 'gpt-6.1-sol';
const agentDir = process.env.PI_CODING_AGENT_DIR ?? '/home/node/.pi/agent';
const root = process.env.GATEWAY_TEST_URL ?? 'https://api.muzeai.top';
const all = JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8'));
const key = all[sourceId]?.key;
if (typeof key !== 'string' || !key) throw new Error('现有服务没有可用凭据');
const dir = await mkdtemp(join(tmpdir(), 'pi-gateway-live-'));
let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
const h = createGateway({ id: 'gateway-smoke', name: 'Gateway smoke', url: root }, new Store(dir));
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240000);
const signal = controller.signal;
const checks: Record<string, unknown> = {};
try {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(h.provider.id, async () => ({ type: 'api_key', key, env: { PI_GATEWAY_URL: root } }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  runtime.registerNativeProvider(h.provider);
  await runtime.refresh({ providers: [h.provider.id], allowNetwork: false, signal });
  const refreshed = await runtime.refresh({ providers: [h.provider.id], allowNetwork: true, force: true, signal });
  assert.equal(refreshed.errors.size, 0, '模型发现失败');
  const m = runtime.getModel(h.provider.id, modelId); assert(m, '未发现目标模型');
  checks.catalog = { count: runtime.getModels(h.provider.id).length, api: m.api, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input, levels: getSupportedThinkingLevels(m) };
  if (process.argv.includes('--probe')) {
    const results = [];
    for (const api of PROTOCOLS) results.push(await probeProtocol(root, key, api, modelId, signal));
    checks.protocolProbes = results;
  }
  const text = await runtime.completeSimple(m, { messages: [{ role: 'user', content: 'Reply exactly OK.', timestamp: Date.now() }] }, { reasoning: 'max', maxTokens: 1024, signal });
  assert.equal(text.stopReason, 'stop', '普通聊天失败'); assert(text.content.some(c => c.type === 'text' && c.text.includes('OK')));
  checks.textAndMax = { passed: true, providerThinkingLevel: text.providerThinkingLevel };
  const context = { tools: [{ name: 'gateway_test_echo', description: 'Returns the supplied value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }], messages: [{ role: 'user' as const, content: 'Call gateway_test_echo with value gateway-tool-ok. Do not answer before calling it.', timestamp: Date.now() }] };
  const tool = await runtime.completeSimple(m, context, { reasoning: 'low', maxTokens: 1024, signal });
  const call = tool.content.find(c => c.type === 'toolCall'); assert(call?.type === 'toolCall', '没有工具调用'); assert.equal(call.name, 'gateway_test_echo');
  const after = await runtime.completeSimple(m, { ...context, messages: [...context.messages, tool, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'gateway-tool-ok' }], isError: false, timestamp: Date.now() }] }, { reasoning: 'low', maxTokens: 1024, signal });
  assert.equal(after.stopReason, 'stop'); checks.toolRoundTrip = true;
  function crc(b: Buffer) { let c = 0xffffffff; for (const x of b) { c ^= x; for (let i=0;i<8;i++) c=(c>>>1) ^ (0xedb88320 & -(c&1)); } return (c^0xffffffff)>>>0; }
  function chunk(type: string, data: Buffer) { const t=Buffer.from(type); const n=Buffer.alloc(4);n.writeUInt32BE(data.length);const sum=Buffer.alloc(4);sum.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,sum]); }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(128,0);ihdr.writeUInt32BE(128,4);ihdr[8]=8;ihdr[9]=2;
  const pixels=Buffer.alloc(128*(128*3+1));for(let y=0;y<128;y++)for(let x=0;x<128;x++)pixels[y*385+2+x*3]=255;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
  const image = await runtime.completeSimple(m, { messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the dominant color? Answer one English word.' }, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }], timestamp: Date.now() }] }, { reasoning: 'low', maxTokens: 1024, signal });
  assert.equal(image.stopReason,'stop'); checks.imageObservation = { hasText: image.content.some(c => c.type === 'text'), answer: image.content.filter(c => c.type === 'text').map(c => c.text).join('').replace(/[\x00-\x1f]/g, '').slice(0,120) }; assert(image.content.some(c=>c.type==='text'&&/green/i.test(c.text)), '图像颜色识别失败'); checks.imageInput=true;
  // Genuine Pi session compaction, not merely a cacheRetention:none chat request.
  const sm = SessionManager.inMemory(dir);
  for (let i=0;i<8;i++) {
    sm.appendMessage({role:'user',content:`Synthetic test exchange ${i}: gateway-compact-ok. `+'We verified model discovery, reasoning levels, tool results and safe compatibility metadata. '.repeat(12),timestamp:Date.now()});
    sm.appendMessage({...text,content:[{type:'text',text:`Recorded test checkpoint ${i}; preserve gateway-compact-ok and successful tools/images.`}]});
  }
  sm.appendMessage({ role:'user',content:'Remember the project marker gateway-compact-ok. We are testing provider discovery, tools and image inputs.',timestamp:Date.now() });
  sm.appendMessage(text);
  sm.appendMessage({ role:'user',content:'The previous tests succeeded. Preserve the marker and the fact that tools and images were tested.',timestamp:Date.now() });
  sm.appendMessage(after);
  const settings=SettingsManager.inMemory({ compaction:{enabled:true,reserveTokens:2048,keepRecentTokens:128},retry:{enabled:false},cacheWarming:'off' });
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true});
  await loader.reload();
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:m,thinkingLevel:'max',tools:[],sessionManager:sm,settingsManager:settings,resourceLoader:loader}));
  const compacted=await session.compact('Preserve the marker gateway-compact-ok.');
  assert(compacted.summary.includes('gateway-compact-ok')); checks.realPiCompaction=true;
  const restored=createGateway({id:h.provider.id,name:'Gateway smoke',url:root},new Store(dir));
  await restored.provider.refreshModels!({credential:{type:'api_key',key,env:{PI_GATEWAY_URL:root}},allowNetwork:false,signal,publish:async p=>{p.update?.();return true;}});
  assert(restored.provider.getModels().some(m=>m.id===modelId)); checks.offlineRestore=true;restored.dispose();
  console.log(JSON.stringify({ok:true,checks},null,2));
} catch (e) {
  // Error bodies can contain upstream details. Print only the test assertion / safe stage.
  console.log(JSON.stringify({ok:false,checks,error:e instanceof Error?e.message.replaceAll(key,'[REDACTED]').replace(/[\x00-\x1f]/g,' ').slice(0,220):'实时检查失败'},null,2));process.exitCode=1;
} finally { clearTimeout(timer); controller.abort();session?.dispose();h.dispose();await rm(dir,{recursive:true,force:true}); }
