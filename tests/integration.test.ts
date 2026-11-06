import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, cp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { Store, atomicJson } from '../src/storage.ts';
import { createGateway } from '../src/provider.ts';
import { fingerprint } from '../src/discovery.ts';
import { secretInput } from '../src/ui.ts';
const id='gpt-6.1-sol';

test('native login persists credentials with Pi locking; extension config/cache contain no key', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gateway-login-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const server=createServer((req,res)=>{ assert.equal(req.headers['anthropic-version'],undefined,'catalog must not accidentally negotiate Anthropic format');res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id,native_endpoints:['/v1/responses']}]})); });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const root=`http://127.0.0.1:${(server.address() as any).port}`;const store=new Store(dir);const c={id:'test-login',name:'Test'};
  const h=createGateway(c,store);t.after(()=>h.dispose());
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStore:new InMemoryModelsStore(),refreshOnCreate:false});
  runtime.registerNativeProvider(h.provider);await runtime.refresh({allowNetwork:false});
  const credential=await runtime.login(c.id,'api_key',{prompt:async p=>p.type==='secret'?'private-fake-key':root,notify:()=>{}});
  assert.equal(credential.type,'api_key');
  assert.equal(JSON.parse(await readFile(join(dir,'auth.json'),'utf8'))[c.id].key,'private-fake-key');
  assert(!(await readFile(store.registryPath,'utf8')).includes('private-fake-key'));
  assert(!(await readFile(store.cachePath(c.id),'utf8')).includes('private-fake-key'));
  assert(runtime.getModel(c.id,id));
});
test('masked secret prompt never renders the key, supports paste/backspace/cancel',async()=>{
  let rendered:string[]=[];
  const ctx:any={mode:'tui',ui:{custom:async(factory:any)=>new Promise(resolve=>{
    const component=factory({requestRender(){}},{fg:(_:string,s:string)=>s},{matches:(s:string,key:string)=>key==='tui.select.confirm'?s==='\r':key==='tui.select.cancel'?s==='\x1b':false},resolve);
    component.handleInput('\x1b[200~sk-FAKE-KEY\x1b[201~');rendered.push(...component.render(30));component.handleInput('\x7f');component.handleInput('Y');rendered.push(...component.render(5));component.handleInput('\r');component.dispose();
  })}};
  assert.equal(await secretInput(ctx,'Key'),'sk-FAKE-KEY');assert(!rendered.join('').includes('sk-FAKE'));assert(rendered.some(s=>s.includes('***')));
  ctx.ui.custom=async(factory:any)=>new Promise(resolve=>{const c=factory({requestRender(){}},{fg:(_:string,s:string)=>s},{matches:(_:string,key:string)=>key==='tui.select.cancel'},resolve);c.handleInput('\x1b');c.dispose();});
  await assert.rejects(secretInput(ctx,'Key'),/取消/);
});
test('actual Pi CLI discovers package and restores model+max offline, without old extension',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gateway-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const root='https://example.test';const store=new Store(dir);const c={id:'test-cli',name:'Test CLI',url:root};
  await store.put(c,null);await atomicJson(join(dir,'auth.json'),{[c.id]:{type:'api_key',key:'fake-cli-key',env:{PI_GATEWAY_URL:root}}});
  await store.save(c.id,{version:1,fingerprint:fingerprint(root,'fake-cli-key'),checkedAt:Date.now(),discovery:{rows:[{id,native_endpoints:['/v1/responses']}],protocols:{[id]:['openai-responses']},evidence:{[id]:'endpoint'},probes:[]}});
  // Test the distributed shape, NOT the source tree whose dev node_modules masks missing imports.
  const packageDir=join(dir,'standalone-package');await cp(resolve('src'),join(packageDir,'src'),{recursive:true});await copyFile(resolve('package.json'),join(packageDir,'package.json'));
  await atomicJson(join(dir,'settings.json'),{extensions:['-builtin:mcp','-builtin:codemode','-builtin:tool_search']});
  const install=spawnSync(process.execPath,[resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'install',packageDir],{cwd:dir,encoding:'utf8',timeout:30000,env:{...process.env,PI_CODING_AGENT_DIR:dir,PI_OFFLINE:'1',NPM_CONFIG_REGISTRY:'http://127.0.0.1:1'}});
  assert.equal(install.status,0,install.stderr);
  const result=spawnSync(process.execPath,[resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--offline','--list-models',id],{cwd:dir,encoding:'utf8',timeout:30000,env:{...process.env,PI_CODING_AGENT_DIR:dir}});
  assert.equal(result.status,0,result.stderr);assert(!result.stderr.includes('Failed to load extension'),result.stderr);assert(result.stdout.includes(id) && result.stdout.includes(c.id),result.stdout + result.stderr);assert(!result.stdout.includes('fake-cli-key'));assert(!result.stderr.includes('fake-cli-key'));
});
