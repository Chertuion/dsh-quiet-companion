import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionRuntime } from './runtime.mjs';

const frame={data:Buffer.from('synthetic-vision-fixture').toString('base64'),mimeType:'image/png'};
async function fixture(t,{block=false,noUsage=false}={}) {
  const directory=await mkdtemp(join(tmpdir(),'quiet-runtime-'));
  let clock=1_000_000, selection={provider:'default-fixture',model:'vision'};
  const calls=[],admissions=[],messages=[],listeners=new Map();
  const llm={resolveModelInfo:async(provider,id)=>({provider,id,inputModalities:['text','image']}),
    async *stream(request) {
      calls.push(request);
      if(block) await new Promise(resolve=>request.signal.addEventListener('abort',resolve,{once:true}));
      if(request.signal.aborted) return;
      yield {type:'text-delta',index:0,text:JSON.stringify({speak:true,text:`模型回应${calls.length}`,mood:'idle'})};
      if(!noUsage) yield {type:'usage',usage:{inputTokens:10,outputTokens:4,cacheReadTokens:3,totalTokens:17}};
      yield {type:'finish',reason:{kind:'stop'}};
    }};
  const services={llm,agentDefaultModel:{currentSelection:()=>({...selection})},
    attachments:{admitPromptContent:async parts=>{
      admissions.push(parts);
      return parts.map(()=>({type:'image',attachment:{attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',width:8,height:8,bytes:42}}));
    }},agents:{list:()=>[]}};
  const ctx={get:key=>services[key],on(event,listener){
    const bucket=listeners.get(event)||new Set(); bucket.add(listener); listeners.set(event,bucket); return ()=>bucket.delete(listener);
  }};
  const runtime=new CompanionRuntime(ctx,{send:message=>messages.push(message),stateDir:directory,now:()=>clock});
  await runtime.ready;
  t.after(async()=>{await runtime.dispose(); await rm(directory,{recursive:true,force:true});});
  const drain=async()=>{for(let i=0;i<4;i++) {await Promise.resolve(); await Promise.allSettled([...runtime.requests]);}};
  return {runtime,calls,admissions,messages,drain,services,
    advance:amount=>{clock+=amount;},select:value=>{selection=value;},
    enable:()=>runtime.handle({type:'settings',observationEnabled:true,screenEnabled:true,
      consentPair:'default-fixture\u001fvision',memoryEnabled:false}),
    observe:(extra={})=>runtime.handle({type:'observation',app:'Synthetic Player',bundleId:'test.player',idleSeconds:0,
      timestamp:clock,screen:frame,visualFingerprint:'a'.repeat(64),visualChange:0,...extra}),
  };
}

test('default Harness model drives real generation path and vision admission, not fixed replies',async t=>{
  const f=await fixture(t); await f.enable(); await f.observe(); await f.drain();
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].provider,'default-fixture');
  assert.equal(f.calls[0].model,'vision'); assert.equal(f.admissions.length,1);
  assert.equal(f.calls[0].messages[0].content.some(item=>item.type==='image'),true);
  assert.equal(JSON.stringify(f.calls).includes(frame.data),false);
  assert.equal(f.messages.some(item=>item.type==='speech'&&item.text==='模型回应1'),true);
  assert.equal(f.runtime.ledger.dailyUsage().totalTokens,17,'Host cache tokens are disjoint from uncached input');
  await f.runtime.handle({type:'chat',text:'你怎么看这段？'}); await f.drain();
  assert.equal(f.calls.length,2); assert.equal(f.messages.some(item=>item.type==='speech'&&item.text==='模型回应2'),true);
});
test('stable picture and elapsed time alone do not produce another API call',async t=>{
  const f=await fixture(t); await f.enable(); await f.observe(); await f.drain();
  const count=f.calls.length, settingMessages=f.messages.filter(item=>item.type==='settings').length;
  f.advance(180_000); await f.observe(); await f.drain();
  assert.equal(f.calls.length,count);
  assert.equal(f.messages.filter(item=>item.type==='settings').length,settingMessages,'unchanged default must not reset native capture');
});
test('default model changes revoke screen/audio consent before any new image admission',async t=>{
  const f=await fixture(t); await f.enable(); await f.observe(); await f.drain();
  const admitted=f.admissions.length;
  f.select({provider:'default-fixture',model:'new-default'}); f.advance(180_000);
  await f.observe({visualFingerprint:'b'.repeat(64),visualChange:0.9}); await f.drain();
  assert.equal(f.runtime.settings.screenEnabled,false); assert.equal(f.runtime.settings.videoAudioEnabled,false);
  assert.equal(f.runtime.frames.length,0); assert.equal(f.admissions.length,admitted);
  assert.equal(f.runtime.settings.model,'new-default');
});
test('pause aborts an in-flight model and suppresses late speech',async t=>{
  const f=await fixture(t,{block:true}); await f.enable(); await f.observe();
  for(let i=0;i<30&&f.calls.length===0;i++) await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(f.calls.length,1);
  await f.runtime.handle({type:'settings',observationEnabled:false}); await f.drain();
  assert.equal(f.calls[0].signal.aborted,true);
  assert.equal(f.messages.some(item=>item.type==='speech'),false);
  assert.equal(f.runtime.frames.length,0);
});
test('native frames without an explicit fingerprint still trigger on actual visual change',async t=>{
  const f=await fixture(t); await f.enable(); await f.observe({visualFingerprint:undefined}); await f.drain();
  f.advance(180_000);
  await f.observe({visualFingerprint:undefined,visualChange:0.4,
    screen:{...frame,data:Buffer.from('new-synthetic-scene').toString('base64')}}); await f.drain();
  assert.equal(f.calls.length,2);
});
test('requests with unreported usage remain unknown in ledger coverage',async t=>{
  const f=await fixture(t,{noUsage:true}); await f.runtime.handle({type:'chat',text:'你好'});
  const usage=f.runtime.ledger.dailyUsage();
  assert.equal(usage.calls,1); assert.equal(usage.reportedCalls,0);
  assert.equal(usage.totalTokens,null); assert.equal(usage.usageComplete,false);
});
test('route resolution races cannot overlap explicit model requests',async t=>{
  const f=await fixture(t);
  let unlock; const gate=new Promise(resolve=>{unlock=resolve;});
  const resolver=f.services.llm.resolveModelInfo;
  let blocked=true;
  f.services.llm.resolveModelInfo=async(...args)=>{if(blocked) await gate; return resolver(...args);};
  let active=0,maxActive=0;
  const stream=f.services.llm.stream;
  f.services.llm.stream=async function*(request) {
    active++; maxActive=Math.max(maxActive,active);
    try { await new Promise(resolve=>setTimeout(resolve,5)); yield*stream.call(this,request); }
    finally {active--;}
  };
  const one=f.runtime.handle({type:'chat',text:'第一句'}),two=f.runtime.handle({type:'chat',text:'第二句'});
  blocked=false; unlock(); await Promise.all([one,two]); await f.drain();
  assert.equal(maxActive,1);
});
test('identical ASR segments are deduplicated and expired dialogue cannot trigger analysis',async t=>{
  const f=await fixture(t); await f.enable();
  await f.runtime.handle({type:'settings',videoAudioEnabled:true,audioConsentPair:'default-fixture\u001fvision'});
  await f.observe(); await f.drain();
  const transcript={type:'transcript',source:'system-audio',onDevice:true,text:'这是一段合成对白'};
  await f.runtime.handle(transcript); await f.drain();
  const count=f.calls.length,content=f.runtime.transcript;
  f.advance(1000); await f.runtime.handle(transcript); await f.drain();
  assert.equal(f.runtime.transcript,content);
  assert.equal(f.calls.length,count);
  f.advance(90_000); f.runtime.evaluate(); await f.drain();
  assert.equal(f.runtime.transcript,'');
  assert.equal(f.calls.length,count);
});
test('one-shot frame expiry clears raw frames even when no more observations arrive',async t=>{
  const f=await fixture(t);
  t.mock.timers.enable({apis:['setTimeout']});
  await f.enable(); await f.observe(); await f.drain();
  assert.equal(f.runtime.frames.length,1);
  f.advance(45_001); t.mock.timers.tick(45_001);
  assert.equal(f.runtime.frames.length,0);
});
