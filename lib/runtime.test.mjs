import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionRuntime } from './runtime.mjs';
import { clearHelperTransientState } from './helper-restart.mjs';

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
      const prompt=request.messages[0].content.find(part=>part.type==='text').text;
      const conversation=JSON.parse(prompt.slice(prompt.indexOf('\n')+1)).mode==='direct-conversation';
      yield {type:'text-delta',index:0,text:conversation?JSON.stringify({speak:true,text:`模型回应${calls.length}`,mood:'idle'}):
        `模型回应${calls.length}`};
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
    emitSession:(session,event)=>{for(const listener of listeners.get('session/event')||[]) listener(session,event);},
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

test('queued old-helper settings and native facts cannot cross the ready boundary or restore a cancelled audio request',async t=>{
  const f=await fixture(t);await f.enable();
  await f.runtime.handle({type:'settings',observationEnabled:false,videoAudioEnabled:false,audioConsentPair:''});
  const settings=structuredClone(f.runtime.settings),ready=f.runtime.ready;
  let release,current=true;f.runtime.ready=new Promise(resolve=>{release=resolve;});
  const staleSettings=f.runtime.handle({type:'settings',screenEnabled:false,consentPair:'',
    videoAudioEnabled:true,audioConsentPair:'default-fixture\u001fvision'},{isCurrent:()=>current});
  const staleStatus=f.runtime.handle({type:'native-status',screenAuthorized:true,audioEnabled:true,
    audioConsentPending:true},{isCurrent:()=>current});
  current=false;clearHelperTransientState(f.runtime);release();
  await Promise.all([staleSettings,staleStatus]);f.runtime.ready=ready;
  assert.deepEqual(f.runtime.settings,settings);
  assert.equal(f.runtime.native.audioEnabled,false);assert.equal(f.runtime.native.audioConsentPending,false);
  assert.equal(f.runtime.native.screenAuthorized,undefined);assert.equal(f.runtime.native.screenPermissionState,'unavailable');
  await f.runtime.handle({type:'native-status',screenAuthorized:false,screenEnabled:false},{isCurrent:()=>true});
  assert.equal(f.runtime.native.screenAuthorized,false,'a current helper still reports a real denied preflight');
  assert.equal(f.runtime.settings.screenEnabled,true,'a status report is not a forged user off action');
  await f.runtime.handle({type:'settings',screenEnabled:false},{isCurrent:()=>true});
  assert.equal(f.runtime.settings.screenEnabled,false,'a current settings change remains authoritative');
});

test('old observations waiting on route resolution cannot refill cleared frames or trigger inference after restart',async t=>{
  const f=await fixture(t);await f.enable();
  let release,enter,current=true;const entered=new Promise(resolve=>{enter=resolve;});
  const gate=new Promise(resolve=>{release=resolve;}),refresh=f.runtime.refreshRoute;
  f.runtime.refreshRoute=async()=>{enter();await gate;return f.runtime.route;};
  const stale=f.runtime.handle({type:'observation',app:'Synthetic old source',bundleId:'test.old',timestamp:1000000,
    screen:frame,visualFingerprint:'a'.repeat(64),visualChange:1},{isCurrent:()=>current});
  await entered;current=false;clearHelperTransientState(f.runtime);release();await stale;
  f.runtime.refreshRoute=refresh;await f.drain();
  assert.deepEqual(f.runtime.frames,[]);assert.equal(f.runtime.latest,null);
  assert.equal(f.admissions.length,0);assert.equal(f.calls.length,0);
  assert.equal(f.runtime.settings.observationEnabled,true,'transport teardown does not toggle the saved choice');
});

test('old native chat waiting for route resolution cannot create a new paid request after transport replacement',async t=>{
  const f=await fixture(t);
  let release,enter,current=true;const entered=new Promise(resolve=>{enter=resolve;});
  const gate=new Promise(resolve=>{release=resolve;}),refresh=f.runtime.refreshRoute;
  f.runtime.refreshRoute=async()=>{enter();await gate;return f.runtime.route;};
  const stale=f.runtime.handle({type:'chat',text:'Synthetic old chat'},{isCurrent:()=>current});
  await entered;current=false;clearHelperTransientState(f.runtime);release();await stale;
  f.runtime.refreshRoute=refresh;await f.drain();
  assert.equal(f.calls.length,0);assert.equal(f.runtime.request,null);
  assert.equal(f.messages.some(message=>message.type==='speech'),false);
});

test('old native chat waiting on local memory cannot launch inference or publish a late failure after restart',async t=>{
  const f=await fixture(t);
  let release,enter,current=true;const entered=new Promise(resolve=>{enter=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  f.runtime.memory.retrieve=async()=>{enter();await gate;return [];};
  const stale=f.runtime.handle({type:'chat',text:'Synthetic old chat'},{isCurrent:()=>current});
  await entered;current=false;clearHelperTransientState(f.runtime);release();await stale;await f.drain();
  assert.equal(f.calls.length,0);assert.equal(f.runtime.request,null);
  assert.equal(f.messages.some(message=>message.type==='speech'),false);
  assert.equal(f.messages.some(message=>message.type==='notice'&&message.reason==='aborted'),false);
});

test('helper teardown also cancels automatic analysis still preparing its route before an abort controller exists',async t=>{
  const f=await fixture(t);await f.enable();
  let release,enter,refreshes=0;const entered=new Promise(resolve=>{enter=resolve;});
  const gate=new Promise(resolve=>{release=resolve;}),refresh=f.runtime.refreshRoute;
  f.runtime.refreshRoute=async()=>{
    if(++refreshes>1) {enter();await gate;}
    return f.runtime.route;
  };
  await f.observe();await entered;
  clearHelperTransientState(f.runtime);release();await f.drain();f.runtime.refreshRoute=refresh;
  assert.equal(f.calls.length,0);assert.equal(f.admissions.length,0);assert.equal(f.runtime.request,null);
  assert.equal(f.runtime.latest,null);assert.deepEqual(f.runtime.frames,[]);
  assert.equal(f.runtime.settings.observationEnabled,true);
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

test('ordinary settings preserve authorized recent frames and matching metadata for manual image admission',async t=>{
  const f=await fixture(t);await f.enable();await f.observe();await f.drain();
  const originalFrame=f.runtime.frames[0],originalLatest={...f.runtime.latest},admitted=f.admissions.length;
  f.advance(1000);
  for(const patch of [{quietApps:['QC-SCREEN-SYNTHETIC']},{dailyTokenBudget:200000},
    {voiceEnabled:true},{memoryEnabled:false},{growthPanelVisible:true},{reduceMotion:true}]) {
    await f.runtime.handle({type:'settings',...patch});
    assert.equal(f.runtime.frames[0],originalFrame);assert.deepEqual(f.runtime.latest,originalLatest);
  }
  await f.runtime.handle({type:'chat',text:'请根据已经附带的画面回答。'});await f.drain();
  assert.equal(f.admissions.length,admitted+1);
  assert.ok(f.calls.at(-1).messages[0].content.some(part=>part.type==='image'));
  assert.equal(f.runtime.frames[0].timestamp,originalFrame.timestamp);
});

test('pause, snooze, screen opt-out, withdrawn consent and routing changes clear frames and latest before manual generation',async t=>{
  const patches=[{observationEnabled:false},{snoozeUntil:1_060_000},{screenEnabled:false},{consentPair:''},
    {provider:'different-provider'},{model:'different-model'},{useDefaultModel:false}];
  for(const patch of patches) {
    const f=await fixture(t);await f.enable();await f.observe();await f.drain();
    const admitted=f.admissions.length;
    await f.runtime.handle({type:'settings',...patch});
    assert.equal(f.runtime.frames.length,0,JSON.stringify(patch));assert.equal(f.runtime.latest,null);
    await f.runtime.handle({type:'chat',text:'请根据当前可用信息回答。'});await f.drain();
    assert.equal(f.admissions.length,admitted);
    assert.equal(f.calls.at(-1).messages[0].content.some(part=>part.type==='image'),false);
  }
  const f=await fixture(t);await f.enable();await f.observe();await f.drain();
  const admitted=f.admissions.length;f.select({provider:'default-fixture',model:'changed-live-route'});
  await f.runtime.refreshRoute();
  assert.equal(f.runtime.frames.length,0);assert.equal(f.runtime.latest,null);
  await f.runtime.handle({type:'chat',text:'切换默认模型后回答。'});await f.drain();
  assert.equal(f.admissions.length,admitted);
});

test('an ordinary settings write cannot extend the original 45-second frame lifetime',async t=>{
  const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  await f.enable();await f.observe();await f.drain();
  const originalTimestamp=f.runtime.frames[0].timestamp,admitted=f.admissions.length;
  f.advance(44_000);t.mock.timers.tick(44_000);
  await f.runtime.handle({type:'settings',quietApps:['QC-SCREEN-SYNTHETIC']});
  assert.equal(f.runtime.frames[0].timestamp,originalTimestamp);
  f.advance(1001);t.mock.timers.tick(1001);
  assert.equal(f.runtime.frames.length,0);
  await f.runtime.handle({type:'chat',text:'过期之后还有附图吗？'});await f.drain();
  assert.equal(f.admissions.length,admitted);
  assert.equal(f.calls.at(-1).messages[0].content.some(part=>part.type==='image'),false);
});

test('ordinary settings still cancel an in-flight model request while retaining its authorized frame',async t=>{
  const f=await fixture(t,{block:true});await f.enable();await f.observe();
  for(let i=0;i<30&&f.calls.length===0;i++) await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(f.calls.length,1);const originalFrame=f.runtime.frames[0];
  await f.runtime.handle({type:'settings',quietApps:['QC-SCREEN-SYNTHETIC']});await f.drain();
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.runtime.frames[0],originalFrame);
  assert.equal(f.messages.some(message=>message.type==='speech'),false);
});
test('real Host usage events create snacks once; a local offered meal consumes inventory without extra model calls',async t=>{
  const f=await fixture(t);
  const session={id:'synthetic-agent-session'},event={seq:5,type:'assistant/message',data:{turn:1,step:0,
    usage:{inputTokens:1400,outputTokens:300,cacheReadTokens:300,cacheWriteTokens:0,totalTokens:2000}}};
  f.emitSession(session,event);f.emitSession(session,event);
  const before=(await f.runtime.snapshot()).growth;
  assert.equal(before.snackCount,1);assert.equal(before.stats.agentTokens,2000);assert.equal(f.calls.length,0);
  assert.ok(f.messages.some(m=>m.type==='growth'&&m.event?.type==='snack-spawned'));
  await f.runtime.handle({type:'snack-offer',id:before.snacks[0].id});
  const after=(await f.runtime.snapshot()).growth;
  assert.equal(after.snackCount,0);assert.equal(after.stats.eatenSnacks,1);
  assert.ok(after.experience>=20);assert.equal(f.calls.length,0);
  assert.ok(f.messages.some(m=>m.type==='growth'&&m.event?.type==='snack-eaten'));
});
test('growth rewards stay independent of screen observation, and disabling rewards does not mint backlog',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',snackRewardsEnabled:false});
  const session={id:'synthetic-agent-session'};
  f.emitSession(session,{seq:1,type:'assistant/message',data:{turn:1,step:0,usage:{totalTokens:2000}}});
  assert.equal(f.runtime.growth.snapshot().snackCount,0);
  await f.runtime.handle({type:'settings',snackRewardsEnabled:true});
  f.emitSession(session,{seq:2,type:'assistant/message',data:{turn:1,step:1,usage:{totalTokens:2000}}});
  assert.equal(f.runtime.growth.snapshot().snackCount,1);assert.equal(f.runtime.settings.observationEnabled,false);
});
test('default-model snack choices can defer or eat available food without extra inference',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',memoryEnabled:false});
  f.emitSession({id:'synthetic-agent-session'},{seq:1,type:'assistant/message',data:{turn:1,step:0,usage:{totalTokens:2000}}});
  let choice='wait',count=0;
  f.services.llm.stream=async function*(request) {
    count++;
    yield {type:'text-delta',index:0,text:JSON.stringify({speak:true,text:'我先看看桌边的零食。',mood:'idle',snackAction:choice})};
    yield {type:'usage',usage:{totalTokens:17}};yield {type:'finish',reason:{kind:'stop'}};
  };
  await f.runtime.handle({type:'chat',text:'你想现在吃吗？'});
  f.advance(5000);f.runtime.careStep();assert.equal(f.runtime.growth.snapshot().snackCount,1);
  choice='eat';await f.runtime.handle({type:'chat',text:'你自己决定就好。'});
  assert.equal(f.runtime.growth.snapshot().snackCount,0);assert.equal(count,2);
});

test('an automatic silent control can choose a real meal and settle usage without speech or an extra request',async t=>{
  const f=await fixture(t);let requests=0;
  f.emitSession({id:'automatic-silent-food'},{seq:1,type:'assistant/message',data:{turn:1,step:0,usage:{totalTokens:2000}}});
  f.advance(5000);f.runtime.careStep();assert.equal(f.runtime.growth.snapshot().snackCount,1);
  f.services.llm.stream=async function*() {
    requests++;
    yield {type:'text-delta',index:0,text:'[[QC:idle:eat]]\n[[QC_SILENT]]'};
    yield {type:'usage',usage:{inputTokens:10,outputTokens:7,totalTokens:17}};
    yield {type:'finish',reason:{kind:'stop'}};
  };
  await f.enable();await f.observe();await f.drain();
  assert.equal(requests,1);assert.equal(f.runtime.growth.snapshot().snackCount,0);
  assert.equal(f.runtime.growth.snapshot().stats.eatenSnacks,1);
  assert.equal(f.runtime.ledger.dailyUsage().totalTokens,17);
  assert.equal(f.messages.some(message=>message.type==='speech'),false);
  assert.equal(JSON.stringify(f.messages).includes('[[QC_SILENT]]'),false);
  assert.ok(f.messages.some(message=>message.type==='growth'&&message.event?.type==='snack-eaten'));
});

test('automatic plain text and an explicit none header never infer food intentions from their spoken words',async t=>{
  const f=await fixture(t);let requests=0,reply='我想先吃一口零食。';
  f.emitSession({id:'automatic-no-guessed-food'},{seq:1,type:'assistant/message',data:{turn:1,step:0,usage:{totalTokens:2000}}});
  f.advance(5000);
  f.services.llm.stream=async function*() {
    requests++;
    yield {type:'text-delta',index:0,text:reply};
    yield {type:'usage',usage:{totalTokens:17}};yield {type:'finish',reason:{kind:'stop'}};
  };
  await f.enable();await f.observe();await f.drain();
  assert.equal(f.messages.findLast(message=>message.type==='speech').text,reply);
  assert.equal(f.messages.findLast(message=>message.type==='speech').mood,'idle');
  assert.equal(f.runtime.modelMealUntil,0);assert.equal(f.runtime.mealHoldUntil,0);
  assert.equal(f.runtime.growth.snapshot().snackCount,1);
  reply='[[QC:shy:none]]\r\n这次我先等一等。';f.advance(180_000);
  await f.observe({visualFingerprint:'b'.repeat(64),visualChange:.8});await f.drain();
  assert.equal(requests,2);assert.equal(f.runtime.ledger.dailyUsage().totalTokens,34);
  const speech=f.messages.findLast(message=>message.type==='speech');
  assert.equal(speech.text,'这次我先等一等。');assert.equal(speech.mood,'shy');
  assert.equal(f.runtime.modelMealUntil,0);assert.equal(f.runtime.mealHoldUntil,0);
  assert.equal(f.runtime.growth.snapshot().snackCount,1);
});
test('a fresh snack keeps one valid model eat intent until its animation delay ends',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',memoryEnabled:false});
  f.emitSession({id:'fresh-food'},{seq:1,type:'assistant/message',data:{turn:1,step:0,usage:{totalTokens:2000}}});
  let count=0;
  f.services.llm.stream=async function*() {
    count++;
    yield {type:'text-delta',index:0,text:JSON.stringify({speak:false,text:'',mood:'idle',snackAction:'eat'})};
    yield {type:'finish',reason:{kind:'stop'}};
  };
  await f.runtime.handle({type:'chat',text:'你自己决定吃不吃。'});
  assert.equal(f.runtime.growth.snapshot().snackCount,1);
  f.advance(5000);f.runtime.careStep();
  assert.equal(f.runtime.growth.snapshot().snackCount,0);assert.equal(count,1);
});
test('model actions cannot authorize snacks absent from the request context',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',memoryEnabled:false});
  f.services.llm.stream=async function*() {
    yield {type:'text-delta',index:0,text:JSON.stringify({speak:false,text:'',mood:'idle',snackAction:'eat'})};
    // Usage can create food only after this response: it was not available to choose in the prompt.
    yield {type:'usage',usage:{totalTokens:2000}};
    yield {type:'finish',reason:{kind:'stop'}};
  };
  await f.runtime.handle({type:'chat',text:'你好。'});
  f.advance(5000);f.runtime.careStep();
  assert.equal(f.runtime.growth.snapshot().snackCount,1);
  assert.equal(f.runtime.modelMealUntil,0);assert.equal(f.runtime.mealHoldUntil,0);
});
test('the new skirt interaction reaches the default model and growth',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',memoryEnabled:false});
  await f.runtime.handle({type:'interaction',kind:'skirt'});await f.drain();
  assert.equal(f.calls.length,1);
  assert.ok(JSON.stringify(f.calls[0].messages).includes('轻碰裙摆'));
  assert.equal(f.runtime.growth.snapshot().stats.interactions,1);
});

test('each real touch reaches the default model with its own part semantics and current Host clock',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',memoryEnabled:false});
  for(const [kind,label] of [['head','摸头'],['body','轻戳身体'],['skirt','轻碰裙摆']]) {
    await f.runtime.handle({type:'interaction',kind});await f.drain();
    const prompt=f.calls.at(-1).messages[0].content.find(part=>part.type==='text').text;
    const context=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
    assert.equal(context.events[0].kind,kind);assert.equal(context.events[0].label,label);
    assert.equal(context.mode,'direct-interaction');
    assert.equal(context.systemClock.iso,new Date(f.runtime.now()).toISOString());
    f.advance(3000);
  }
  assert.equal(f.calls.length,3,'one existing model request per touch, no added inference');
});

test('manual snack and legacy feed work with auto eating off and produce silent operational feedback',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',autoEatEnabled:false,memoryEnabled:false});
  f.emitSession({id:'manual-snack'},{seq:1,type:'assistant/message',data:{turn:1,step:0,usage:{totalTokens:4000}}});
  const id=f.runtime.growth.snapshot().snacks[0].id;
  await f.runtime.handle({type:'snack-offer',id});
  assert.equal(f.runtime.growth.snapshot().stats.eatenSnacks,1);
  assert.equal(f.messages.filter(message=>message.type==='growth'&&message.event?.type==='snack-eaten').length,1);
  assert.equal(f.messages.findLast(message=>message.type==='notice').reason,'ate');
  f.advance(90_001);f.runtime.growth.state.satiety=40;
  await f.runtime.handle({type:'interaction',kind:'feed'});
  assert.equal(f.runtime.growth.snapshot().stats.eatenSnacks,2);
  assert.equal(f.runtime.growth.snapshot().snackCount,0);
  assert.equal(f.calls.length,0);assert.deepEqual(f.runtime.history,[]);
  assert.equal(f.messages.filter(message=>message.type==='speech').length,0);
  assert.ok(f.messages.filter(message=>message.type==='notice').every(message=>message.kind==='snack-offer'&&!('speak' in message)));
});

test('the native snack-offer path feeds a low-energy awake companion without another model request',async t=>{
  const f=await fixture(t);
  f.runtime.native.petSleeping=false;f.runtime.growth.state.energy=8;f.runtime.growth.state.satiety=10;
  f.emitSession({id:'low-energy-snack'},{seq:1,type:'assistant/message',data:{turn:1,step:0,usage:{totalTokens:2000}}});
  const before=f.runtime.growth.snapshot();
  assert.equal(before.energy,8);assert.equal(before.snackCount,1);assert.equal(before.stats.eatenSnacks,0);
  await f.runtime.handle({type:'snack-offer',id:before.snacks[0].id});
  const after=f.runtime.growth.snapshot();
  assert.equal(after.energy,11);assert.equal(after.snackCount,0);assert.equal(after.stats.eatenSnacks,1);
  assert.equal(f.messages.findLast(message=>message.type==='notice').reason,'ate');
  assert.equal(f.calls.length,0);
});

test('refused manual meals give an immediate visible reason without bypassing any care gate or spending tokens',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',autoEatEnabled:false,memoryEnabled:false});
  f.emitSession({id:'guarded-snack'},{seq:1,type:'assistant/message',data:{turn:1,step:0,usage:{totalTokens:2000}}});
  const id=f.runtime.growth.snapshot().snacks[0].id;
  const cases=[
    ['full',()=>{f.runtime.growth.state.satiety=95;}],
    ['busy',()=>{f.runtime.agent={current:{phase:'working'},activeCount:1};}],
    ['awaiting-confirmation',()=>{f.runtime.agent={current:{phase:'waiting-approval'},activeCount:0};}],
    ['awaiting-confirmation',()=>{f.runtime.native.permissionRequestInFlight=true;}],
    ['resting',()=>{f.runtime.native.petSleeping=true;}],
    ['model-wait',()=>{f.runtime.mealHoldUntil=f.runtime.now()+60_000;}],
    ['cooldown',()=>{f.runtime.growth.state.lastMealAt=f.runtime.now();}],
    ['snack-unavailable',()=>{},'missing-snack'],
    ['disabled',()=>{f.runtime.settings.growthEnabled=false;}],
  ];
  for(const [reason,prepare,selection=id] of cases) {
    f.runtime.agent={available:false,current:null,sessions:[],activeCount:0,waitingCount:0};
    f.runtime.native={};f.runtime.mealHoldUntil=0;f.runtime.growth.state.satiety=40;
    f.runtime.growth.state.lastMealAt=null;f.runtime.settings.growthEnabled=true;
    prepare();
    const notices=f.messages.filter(message=>message.type==='notice').length;
    await f.runtime.handle({type:'snack-offer',id:selection});
    const notice=f.messages.findLast(message=>message.type==='notice');
    assert.equal(notice.reason,reason);assert.ok(notice.text.length>4);
    assert.equal(f.messages.filter(message=>message.type==='notice').length,notices+1);
    assert.equal(f.runtime.growth.snapshot().snackCount,1,reason);
    assert.equal(f.runtime.growth.snapshot().stats.eatenSnacks,0,reason);
  }
  assert.equal(f.calls.length,0);assert.equal(f.messages.some(message=>message.type==='speech'),false);
  assert.equal(f.messages.some(message=>message.type==='growth'&&message.event?.type==='snack-eaten'),false);
});

test('native pending permission facts reach Host snapshot without authorizing or revoking settings consent',async t=>{
  const f=await fixture(t);await f.enable();
  const before={...f.runtime.settings};
  await f.runtime.handle({type:'native-status',screenPermissionState:'restart-required',screenStatus:'请重启陪伴组件后刷新权限。',
    screenAuthorized:false,audioAuthorized:false,screenConsentPending:true,audioConsentPending:true,mouseConsentPending:true,
    permissionsNeedRestart:true,screenEnabled:false,audioEnabled:false,mousePlayEnabled:false});
  const snapshot=await f.runtime.snapshot();
  assert.equal(snapshot.native.screenStatus,'请重启陪伴组件后刷新权限。');
  assert.equal(snapshot.native.screenPermissionState,'restart-required');
  for(const key of ['screenConsentPending','audioConsentPending','mouseConsentPending','permissionsNeedRestart'])
    assert.equal(snapshot.native[key],true);
  for(const key of ['screenEnabled','audioEnabled','mousePlayEnabled','screenAuthorized','audioAuthorized'])
    assert.equal(snapshot.native[key],false);
  assert.deepEqual(snapshot.settings,before,'status is a fact report, not a user settings change');
  assert.equal(f.calls.length,0);
});

test('explicit touch works with observation off and no images, while the existing budget gate still applies',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',observationEnabled:false,memoryEnabled:false});
  assert.equal(f.runtime.settings.observationEnabled,false);
  await f.runtime.handle({type:'interaction',kind:'head'});await f.drain();
  assert.equal(f.calls.length,1);assert.equal(f.admissions.length,0);
  assert.ok(f.messages.some(message=>message.type==='speech'&&message.text==='模型回应1'));
  assert.equal(f.calls[0].messages[0].content.some(part=>part.type==='image'),false);
  assert.equal(f.runtime.ledger.dailyUsage().totalTokens,17);
  assert.equal(f.messages.findLast(message=>message.type==='speech').mood,'idle');
  assert.equal(f.runtime.modelMealUntil,0);assert.equal(f.runtime.mealHoldUntil,0);
  await f.runtime.handle({type:'settings',dailyTokenBudget:1});
  await f.runtime.handle({type:'interaction',kind:'body'});await f.drain();
  assert.equal(f.calls.length,1);assert.match(f.runtime.lastStatus,/用量预算/u);
  assert.ok(f.messages.some(message=>message.type==='speech'&&message.source==='system'&&message.reason==='budget_reached'));
  assert.equal(f.runtime.settings.observationEnabled,false);
});

test('malformed real provider replies surface only a safe reason without leaking their raw content',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',memoryEnabled:false});
  f.services.llm.stream=async function*() {
    yield {type:'text-delta',index:0,text:'PRIVATE_PROVIDER_RAW:not-json'};
    yield {type:'finish',reason:{kind:'stop'}};
  };
  await f.runtime.handle({type:'chat',text:'请回复这条受控测试消息。'});await f.drain();
  assert.match(f.runtime.lastStatus,/没有完整的JSON对象/u);
  assert.equal(JSON.stringify(f.messages).includes('PRIVATE_PROVIDER_RAW'),false);
  const feedback=f.messages.filter(message=>message.type==='speech');
  assert.equal(feedback.length,1);assert.equal(feedback[0].source,'system');assert.equal(feedback[0].reason,'invalid_response');
  assert.equal(feedback[0].mood,'error');assert.equal(feedback[0].speak,false);assert.match(feedback[0].text,/^系统提示：/u);
  assert.equal(f.messages.some(message=>message.type==='notice'&&message.kind==='model-reply'),false);
  assert.deepEqual(f.runtime.history,[]);assert.equal((await f.runtime.memory.snapshot()).counts.episodes,0);
});

test('structured touch output is rejected with one silent system reply and no second request or snack intent',async t=>{
  const f=await fixture(t);let count=0;
  await f.runtime.handle({type:'settings',memoryEnabled:false});
  f.services.llm.stream=async function*() {
    count++;
    yield {type:'text-delta',index:0,text:JSON.stringify({speak:true,text:'合成回复',mood:'happy',snackAction:'eat'})};
    yield {type:'usage',usage:{totalTokens:23}};yield {type:'finish',reason:{kind:'stop'}};
  };
  await f.runtime.handle({type:'interaction',kind:'body'});await f.drain();
  assert.equal(count,1);assert.equal(f.runtime.ledger.dailyUsage().totalTokens,23);
  const feedback=f.messages.filter(message=>message.type==='speech');
  assert.equal(feedback.length,1);assert.equal(feedback[0].source,'system');assert.equal(feedback[0].mood,'error');
  assert.equal(feedback[0].speak,false);assert.match(feedback[0].text,/^系统提示：.*结构化/u);
  assert.equal(f.runtime.modelMealUntil,0);assert.equal(f.runtime.mealHoldUntil,0);
  assert.equal(f.messages.some(message=>message.type==='notice'&&message.kind==='model-reply'),false);
  assert.deepEqual(f.runtime.history,[]);
});

test('an exhausted budget settles each explicit chat or touch with one non-spoken system reply and no inference or remembered dialogue',async t=>{
  const f=await fixture(t);await f.runtime.handle({type:'settings',voiceEnabled:true,dailyTokenBudget:1});
  f.runtime.recordUsage({totalTokens:1});
  const usage=f.runtime.ledger.dailyUsage(),memory=await f.runtime.memory.snapshot();let speeches=0;
  f.runtime.policy.recordSpeech=()=>{speeches++;};
  for(const message of [{type:'chat',text:'Synthetic budget-limited message'},{type:'interaction',kind:'skirt'}]) {
    const before=f.messages.length;await f.runtime.handle(message);await f.drain();
    const feedback=f.messages.slice(before).filter(item=>item.type==='speech');
    assert.equal(feedback.length,1);assert.equal(feedback[0].source,'system');
    assert.equal(feedback[0].reason,'budget_reached');assert.equal(feedback[0].mood,'error');assert.equal(feedback[0].speak,false);
    assert.match(feedback[0].text,/^系统提示：.*用量预算/u);
    assert.equal(f.messages.slice(before).some(item=>item.type==='notice'&&item.kind==='model-reply'),false);
  }
  assert.equal(f.calls.length,0);assert.equal(f.admissions.length,0);assert.equal(speeches,0);
  assert.deepEqual(f.runtime.history,[]);assert.equal((await f.runtime.memory.snapshot()).counts.episodes,memory.counts.episodes);
  assert.deepEqual(f.runtime.ledger.dailyUsage(),usage);
  assert.equal(f.runtime.settings.dailyTokenBudget,1);assert.equal(f.runtime.settings.voiceEnabled,true);
});

test('an automatic output-limit failure is charged once, stays quiet, and the exhausted daily budget blocks further requests',async t=>{
  const f=await fixture(t);let requests=0;
  f.services.llm.stream=async function*(request) {
    requests++;assert.equal(request.maxTokens,2048);
    yield {type:'reasoning-delta',index:0,text:'synthetic thinking'};
    yield {type:'usage',usage:{inputTokens:10,outputTokens:2048,totalTokens:2058}};
    yield {type:'finish',reason:{kind:'max-tokens'}};
  };
  await f.runtime.handle({type:'settings',dailyTokenBudget:2000});
  await f.enable();await f.observe();await f.drain();
  assert.equal(requests,1);assert.equal(f.runtime.ledger.dailyUsage().totalTokens,2058);
  assert.equal(f.runtime.ledger.dailyUsage().outputTokens,2048);assert.equal(f.runtime.budget().reached,true);
  assert.equal(f.runtime.lastStatus,'本次生成达到输出上限，请重试或在Harness降低推理强度');
  assert.equal(f.messages.some(message=>message.type==='notice'),false,'automatic errors do not open repeated pet bubbles');
  assert.equal(f.messages.some(message=>message.type==='speech'),false);
  f.advance(180_000);await f.observe();await f.drain();
  await f.runtime.handle({type:'interaction',kind:'head'});await f.drain();
  assert.equal(requests,1,'no automatic retry and no new inference beyond the budget');
  assert.equal(f.runtime.ledger.dailyUsage().totalTokens,2058,'one receipt is not duplicated');
  assert.ok(f.messages.some(message=>message.type==='speech'&&message.source==='system'&&message.reason==='budget_reached'));
});
