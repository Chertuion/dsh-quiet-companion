const test = require('node:test');
const assert = require('node:assert/strict');
const { CompanionSettingsController } = require('./controller.cjs');

function deferred() { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; }
function fixture(call) {
  const intervals=new Set();
  const timers={setInterval(callback){intervals.add(callback);return callback;},clearInterval(callback){intervals.delete(callback);}};
  return {controller:new CompanionSettingsController({rpc:{call}},{timers}),intervals};
}

test('constructing the settings bridge performs no reads, actions, inference or permission requests',()=>{
  let calls=0; const {controller}=fixture(()=>{calls++;});
  assert.equal(calls,0); assert.equal(controller.store.getSnapshot().status,'idle'); controller.dispose();
});
test('visible-page polling uses authenticated snapshot channel only and stops when closed',async()=>{
  const calls=[]; const {controller,intervals}=fixture(async(channel,endpoint,payload)=>{calls.push({channel,endpoint,payload});return {ok:true,value:{settings:{observationEnabled:false}}};});
  const close=controller.open(); await controller.load();
  assert.equal(intervals.size,1);
  for(const callback of intervals) callback(); await controller.load();
  assert.equal(calls.length,2); assert.equal(calls.every(call=>call.channel==='/api'&&call.endpoint==='quiet-companion/snapshot'),true);
  close(); assert.equal(intervals.size,0); controller.dispose();
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
