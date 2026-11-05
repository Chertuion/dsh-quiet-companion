const test = require('node:test');
const assert = require('node:assert/strict');
const { CompanionSettingsController } = require('./controller.cjs');

function deferred() { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; }
function fixture(call) {
  const intervals=new Set();
  const timers={setInterval(callback){intervals.add(callback);return callback;},clearInterval(callback){intervals.delete(callback);}};
  return {controller:new CompanionSettingsController({rpc:{call}},{timers}),intervals};
}
function visibilityDocument(state='visible') {
  const listeners=new Set();
  return {visibilityState:state,listeners,added:0,removed:0,
    addEventListener(type,listener){assert.equal(type,'visibilitychange');listeners.add(listener);this.added++;},
    removeEventListener(type,listener){assert.equal(type,'visibilitychange');listeners.delete(listener);this.removed++;},
    dispatch(){for(const listener of [...listeners]) listener();},
  };
}
async function withDocument(page,run) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:page});
  try {await run();}
  finally {
    if(previous) Object.defineProperty(globalThis,'document',previous);
    else delete globalThis.document;
  }
}

test('constructing the settings bridge performs no reads, actions, inference or permission requests',()=>{
  let calls=0; const {controller}=fixture(()=>{calls++;});
  assert.equal(calls,0); assert.equal(controller.store.getSnapshot().status,'idle'); controller.dispose();
});

test('mouse test failures display only local Chinese guard messages instead of remote diagnostics',async()=>{
  for(const [code,message] of [
    ['mouse-test-unavailable','请先开启应用感知与指针互动，并确认辅助功能已授权。'],
    ['mouse-test-busy','请等当前授权或指针动作结束后再试。'],
    ['mouse-test-in-progress','请求已发送，请等待本次反馈后再试。'],
  ]) {
    const calls=[];const {controller}=fixture(async(channel,endpoint,payload)=>{
      calls.push({channel,endpoint,payload});
      return {ok:false,error:{code,message:'PRIVATE_REMOTE_DIAGNOSTIC'}};
    });
    assert.equal(await controller.action('test-mouse-play'),false);
    assert.equal(controller.state.error,message);assert.equal(JSON.stringify(controller.state).includes('PRIVATE_REMOTE'),false);
    assert.deepEqual(calls,[{channel:'/api',endpoint:'quiet-companion/action',payload:{action:'test-mouse-play'}}]);
    controller.dispose();
  }
});
test('visible-page polling uses authenticated snapshot channel only and stops when closed',async()=>{
  const calls=[]; const {controller,intervals}=fixture(async(channel,endpoint,payload)=>{calls.push({channel,endpoint,payload});return {ok:true,value:{settings:{observationEnabled:false}}};});
  const close=controller.open(); await controller.load();
  assert.equal(intervals.size,1);
  for(const callback of intervals) callback(); await controller.load();
  assert.equal(calls.length,2); assert.equal(calls.every(call=>call.channel==='/api'&&call.endpoint==='quiet-companion/snapshot'),true);
  close(); assert.equal(intervals.size,0); controller.dispose();
});
test('becoming visible immediately refreshes a mounted page while hidden events and timers issue no reads',async()=>{
  const page=visibilityDocument('hidden');
  await withDocument(page,async()=>{
    const calls=[];const {controller,intervals}=fixture(async(channel,endpoint,payload)=>{
      calls.push({channel,endpoint,payload});return {ok:true,value:{screenFrames:{count:calls.length}}};
    });
    try {
      const close=controller.open();
      assert.equal(calls.length,0,'Opening a hidden page must not read.');
      page.dispatch();for(const callback of intervals) callback();
      assert.equal(calls.length,0);
      page.visibilityState='visible';page.dispatch();
      assert.equal(calls.length,1,'Visibility change must read without waiting for a polling tick.');
      await controller.read;
      assert.equal(controller.state.snapshot.screenFrames.count,1);
      page.visibilityState='hidden';page.dispatch();for(const callback of intervals) callback();
      assert.equal(calls.length,1);
      page.visibilityState='visible';page.dispatch();await controller.read;
      assert.equal(calls.length,2);
      assert.deepEqual(calls,[1,2].map(()=>({channel:'/api',endpoint:'quiet-companion/snapshot',payload:{}})));
      close();
    } finally {controller.dispose();}
  });
});
test('multiple mounted views share one visibility listener and final close or disposal removes it',async()=>{
  const page=visibilityDocument();
  await withDocument(page,async()=>{
    let calls=0;const {controller,intervals}=fixture(async()=>{calls++;return {ok:true,value:{settings:{}}};});
    try {
      const closeFirst=controller.open(),closeSecond=controller.open();await controller.read;
      assert.equal(page.added,1);assert.equal(page.listeners.size,1);assert.equal(intervals.size,1);
      const savedListener=[...page.listeners][0];
      closeFirst();closeFirst();assert.equal(page.listeners.size,1);
      page.dispatch();await controller.read;assert.equal(calls,2);
      closeSecond();assert.equal(page.listeners.size,0);assert.equal(page.removed,1);assert.equal(intervals.size,0);
      page.dispatch();savedListener();assert.equal(calls,2,'A closed view must not refresh even through a stale callback.');
      const closeAgain=controller.open();await controller.read;
      assert.equal(page.added,2);assert.equal(page.listeners.size,1);assert.equal(calls,3);
      controller.dispose();assert.equal(page.listeners.size,0);assert.equal(page.removed,2);assert.equal(intervals.size,0);
      page.dispatch();savedListener();closeAgain();assert.equal(calls,3);
    } finally {controller.dispose();}
  });
});
test('documents without event listener APIs retain safe visible polling without registration',async()=>{
  await withDocument({visibilityState:'visible'},async()=>{
    let calls=0;const {controller,intervals}=fixture(async()=>{calls++;return {ok:true,value:{settings:{}}};});
    try {
      const close=controller.open();await controller.read;assert.equal(calls,1);
      for(const callback of intervals) callback();await controller.read;assert.equal(calls,2);
      close();assert.equal(intervals.size,0);
    } finally {controller.dispose();}
  });
});
test('setting saves and explicit permission actions use distinct payloads and accept returned snapshots',async()=>{
  const calls=[]; const {controller}=fixture(async(channel,endpoint,payload)=>{calls.push({channel,endpoint,payload});return {ok:true,value:{settings:payload.patch??{screenEnabled:false},status:'等待原生授权'}};});
  assert.equal(await controller.update({voiceEnabled:true}),true);
  assert.equal(await controller.action('request-screen-permission'),true);
  assert.deepEqual(calls.map(call=>[call.endpoint,call.payload]),[
    ['quiet-companion/update-settings',{patch:{voiceEnabled:true}}],['quiet-companion/action',{action:'request-screen-permission'}],
  ]);
  assert.equal(controller.state.snapshot.status,'等待原生授权'); controller.dispose();
});
test('a stale read cannot overwrite a later user save',async()=>{
  const old=deferred();
  const {controller}=fixture(async(_channel,endpoint)=>endpoint==='quiet-companion/snapshot'?old.promise:{ok:true,value:{settings:{voiceEnabled:true}}});
  const reading=controller.load();
  await controller.update({voiceEnabled:true});
  old.resolve({ok:true,value:{settings:{voiceEnabled:false}}}); await reading;
  assert.equal(controller.state.snapshot.settings.voiceEnabled,true); controller.dispose();
});
test('closed or disposed views abort pending reads and do not publish late private snapshots',async()=>{
  const pending=deferred(); let signal;
  const {controller}=fixture(async(_channel,_endpoint,_payload,nextSignal)=>{signal=nextSignal;return pending.promise;});
  const close=controller.open(); const reading=controller.load(); close();
  assert.equal(signal.aborted,true); controller.dispose();
  pending.resolve({ok:true,value:{memory:{factsText:'PRIVATE_FIXTURE'}}}); await reading;
  assert.equal(controller.state.snapshot,null);
});
test('RPC errors do not expose remote payloads or provider diagnostics',async()=>{
  const {controller}=fixture(async()=>({ok:false,error:{message:'PRIVATE_FIXTURE_KEY',details:{private:'PRIVATE_FIXTURE_SCREEN'}}}));
  await controller.load();
  assert.equal(controller.state.status,'error'); assert.equal(JSON.stringify(controller.state).includes('PRIVATE_'),false);
  assert.equal(await controller.action('memory-clear'),false); assert.equal(controller.state.busy,false); controller.dispose();
});
test('concurrent gestures cannot dispatch overlapping mutations',async()=>{
  const pending=deferred(); let calls=0;
  const {controller}=fixture(async()=>{calls++;return pending.promise;});
  const first=controller.action('request-audio-permission');
  assert.equal(await controller.update({voiceEnabled:true}),false);
  pending.resolve({ok:true,value:{settings:{}}}); await first;
  assert.equal(calls,1); controller.dispose();
});
test('one failed observer does not prevent other settings observers from updating',async()=>{
  const {controller}=fixture(async()=>({ok:true,value:{settings:{}}}));let notified=0;
  controller.store.subscribe(()=>{throw new Error('fixture');});controller.store.subscribe(()=>notified++);
  await controller.load(); assert.ok(notified>=1); controller.dispose();
});
test('mouse play permission is explicit while disabling and delay changes use settings patches',async()=>{
  const calls=[]; const {controller}=fixture(async(channel,endpoint,payload)=>{
    calls.push({channel,endpoint,payload});return {ok:true,value:{settings:{mousePlayEnabled:false},native:{mouseAuthorized:false,mousePlayActive:false}}};
  });
  await controller.action('request-mouse-permission');
  await controller.update({mousePlayEnabled:false});
  await controller.update({mousePlayAfterMinutes:20});
  assert.deepEqual(calls,[
    {channel:'/api',endpoint:'quiet-companion/action',payload:{action:'request-mouse-permission'}},
    {channel:'/api',endpoint:'quiet-companion/update-settings',payload:{patch:{mousePlayEnabled:false}}},
    {channel:'/api',endpoint:'quiet-companion/update-settings',payload:{patch:{mousePlayAfterMinutes:20}}},
  ]); controller.dispose();
});
test('virtual snack and growth controls use the existing owner channel without new permissions or credentials',async()=>{
  const calls=[]; const {controller}=fixture(async(channel,endpoint,payload)=>{
    calls.push({channel,endpoint,payload});return {ok:true,value:{settings:{growthEnabled:true},growth:{snacks:[]}}};
  });
  await controller.action('offer-snack',{id:'snack-fixture'});
  await controller.action('offer-snack');
  await controller.action('growth-refresh');
  await controller.update({tokensPerSnack:2000,snackRewardsEnabled:true,autoEatEnabled:true,growthEnabled:true});
  assert.deepEqual(calls,[
    {channel:'/api',endpoint:'quiet-companion/action',payload:{id:'snack-fixture',action:'offer-snack'}},
    {channel:'/api',endpoint:'quiet-companion/action',payload:{action:'offer-snack'}},
    {channel:'/api',endpoint:'quiet-companion/action',payload:{action:'growth-refresh'}},
    {channel:'/api',endpoint:'quiet-companion/update-settings',payload:{patch:{tokensPerSnack:2000,snackRewardsEnabled:true,autoEatEnabled:true,growthEnabled:true}}},
  ]); controller.dispose();
});

test('known permission failures remain visible across successful polling without exposing raw errors',async()=>{
  const {controller}=fixture(async(_channel,endpoint)=>endpoint.endsWith('/action')
    ? {ok:false,error:{code:'vision-unavailable',message:'PRIVATE_PROVIDER_DIAGNOSTIC',details:{key:'PRIVATE_KEY'}}}
    : {ok:true,value:{settings:{screenEnabled:false}}});
  assert.equal(await controller.action('request-screen-permission'),false);
  assert.match(controller.state.error,/默认模型不支持图片/u);
  await controller.load();
  assert.match(controller.state.error,/默认模型不支持图片/u);
  assert.equal(controller.state.status,'ready');
  assert.equal(JSON.stringify(controller.state).includes('PRIVATE_'),false);
  await controller.retry();
  assert.equal(controller.state.error,'');
  controller.dispose();
});

test('permission completion is reflected only by later native snapshots, never by the send acknowledgement',async()=>{
  const snapshots=[{settings:{screenEnabled:false},native:{screenConsentPending:true,screenPermissionState:'restart-required'}},
    {settings:{screenEnabled:true},native:{screenConsentPending:false,screenAuthorized:true}}];
  let sent=0;
  const {controller}=fixture(async(_channel,endpoint)=>{
    if(endpoint.endsWith('/action')) {sent++;return {ok:true,value:{settings:{screenEnabled:false}}};}
    return {ok:true,value:snapshots.shift()};
  });
  await controller.action('request-screen-permission');
  assert.equal(controller.state.snapshot.settings.screenEnabled,false);
  await controller.load();
  assert.equal(controller.state.snapshot.settings.screenEnabled,false);
  assert.equal(controller.state.snapshot.native.screenConsentPending,true);
  await controller.load();
  assert.equal(controller.state.snapshot.settings.screenEnabled,true);
  assert.equal(sent,1,'Polling must not replay a permission action.');
  controller.dispose();
});
