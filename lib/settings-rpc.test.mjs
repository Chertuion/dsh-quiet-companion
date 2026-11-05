import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsHandler } from './settings-rpc.mjs';
import { MousePlayPolicy } from './mouse-play.mjs';
const owner={principal:{kind:'owner'}};

test('lip sync preferences reach settings without requesting capture or enabling voice',async()=>{
  const f=fixture();f.runtime.settings.voiceEnabled=false;
  const result=await f.handler('update-settings',{patch:{lipSyncEnabled:false}},null,owner);
  assert.equal(result.value.settings.lipSyncEnabled,false);assert.equal(result.value.settings.voiceEnabled,false);
  assert.equal(f.controls.length,0);
});
function fixture() {
  const calls=[],controls=[];
  const runtime={ready:Promise.resolve(),generation:0,settings:{screenEnabled:false,videoAudioEnabled:false},
    route:{provider:'host-default',model:'vision'},visionAvailable:true,
    snapshot:async()=>({settings:{...runtime.settings},memory:{facts:[]}}),
    handle:async message=>{calls.push(message);if(message.type==='settings') Object.assign(runtime.settings,message);},
    refreshRoute:async()=>{}};
  const helper={state:{running:true},send:message=>{controls.push(message);return true;}};
  let currentHelper=helper;
  const handler=createSettingsHandler({runtime,getHelper:()=>currentHelper,
    restartHelper:async()=>{calls.push('restart');}});
  return {runtime,handler,calls,controls,helper,setHelper:value=>{currentHelper=value;}};
}

function mouseReady(f) {
  let now=1000;const interactions=[];
  Object.assign(f.runtime.settings,{mousePlayEnabled:true,observationEnabled:true,snoozeUntil:0});
  f.runtime.native={mousePlayEnabled:true,mouseAuthorized:true,mousePlayActive:false,
    mouseConsentPending:false,permissionRequestInFlight:false};
  f.runtime.now=()=>now;f.runtime.mousePlay=new MousePlayPolicy({now:()=>now});
  f.runtime.policy={recordUserInteraction:at=>interactions.push(at)};
  return {interactions,advance:(milliseconds=1000)=>{now+=milliseconds;}};
}

test('an explicit owner mouse test reuses only the existing safe native control without changing automatic cooldown',async()=>{
  const f=fixture(),local=mouseReady(f);local.advance();
  assert.equal((await f.handler('action',{action:'test-mouse-play'},null,{principal:{kind:'viewer'}})).error.code,'forbidden');
  assert.equal(f.controls.length,0);
  const before=f.runtime.mousePlay.lastPlayed;
  const result=await f.handler('action',{action:'test-mouse-play'},null,owner);
  assert.equal(result.ok,true);assert.deepEqual(f.controls,[{type:'control',action:'mouse-play'}]);
  assert.deepEqual(f.calls,[]);assert.deepEqual(local.interactions,[2000]);
  assert.equal(f.runtime.mousePlay.lastInteraction,2000);assert.equal(f.runtime.mousePlay.lastPlayed,before);
  assert.equal(f.runtime.mousePlay.evaluate({idleSeconds:0},f.runtime.settings,{native:f.runtime.native}),false);
});

test('mouse test gates reject disconnected, unenabled, unauthorized, paused, snoozed, pending and active states',async()=>{
  for(const [prepare,code] of [
    [f=>{f.helper.state.running=false;},'helper-unavailable'],
    [f=>{f.runtime.settings.mousePlayEnabled=false;},'mouse-test-unavailable'],
    [f=>{f.runtime.native.mousePlayEnabled=false;},'mouse-test-unavailable'],
    [f=>{delete f.runtime.native.mousePlayEnabled;},'mouse-test-unavailable'],
    [f=>{f.runtime.native.mouseAuthorized=false;},'mouse-test-unavailable'],
    [f=>{delete f.runtime.native.mouseAuthorized;},'mouse-test-unavailable'],
    [f=>{f.runtime.settings.observationEnabled=false;},'mouse-test-unavailable'],
    [f=>{f.runtime.settings.snoozeUntil=5000;},'mouse-test-unavailable'],
    [f=>{f.runtime.native.permissionRequestInFlight=true;},'mouse-test-busy'],
    [f=>{f.runtime.native.mouseConsentPending=true;},'mouse-test-busy'],
    [f=>{f.runtime.native.mousePlayActive=true;},'mouse-test-busy'],
  ]) {
    const f=fixture(),local=mouseReady(f);prepare(f);
    const result=await f.handler('action',{action:'test-mouse-play'},null,owner);
    assert.equal(result.ok,false);assert.equal(result.error.code,code);
    assert.deepEqual(f.controls,[]);assert.deepEqual(f.calls,[]);assert.deepEqual(local.interactions,[]);
    assert.equal(f.runtime.mousePlay.lastPlayed,null);
  }
});

test('a failed mouse test delivery returns the existing safe disconnect error without enabling permissions',async()=>{
  const f=fixture();mouseReady(f);f.helper.send=()=>false;
  const result=await f.handler('action',{action:'test-mouse-play'},null,owner);
  assert.equal(result.ok,false);assert.equal(result.error.code,'helper-disconnected');
  assert.equal(result.error.message,'宠物连接已关闭，请重新启动。');
  assert.deepEqual(f.calls,[]);assert.equal(f.runtime.mousePlay.lastPlayed,null);
  assert.equal((await f.handler('snapshot',{},null,owner)).value.mouseTestRequest,null);
});

test('a delivered mouse test reports only a local timestamped request, separately from old native feedback',async()=>{
  const f=fixture();mouseReady(f);
  f.runtime.native.mouseStatus='指针互动已结束';
  const native={...f.runtime.native},settings={...f.runtime.settings};
  const result=await f.handler('action',{action:'test-mouse-play'},null,owner);
  assert.deepEqual(result.value.mouseTestRequest,{id:1,sentAt:1000,phase:'sent'});
  assert.deepEqual(f.runtime.native,native);assert.deepEqual(f.runtime.settings,settings);
  assert.deepEqual(f.controls,[{type:'control',action:'mouse-play'}]);assert.deepEqual(f.calls,[]);
});

test('rapid mouse test repeats neither resend nor reset the request timer or automatic cooldown',async()=>{
  const f=fixture(),local=mouseReady(f);
  f.runtime.mousePlay.lastPlayed=500;
  await f.handler('action',{action:'test-mouse-play'},null,owner);
  for(const elapsed of [0,1999]) {
    local.advance(elapsed);
    const result=await f.handler('action',{action:'test-mouse-play'},null,owner);
    assert.equal(result.error.code,'mouse-test-in-progress');
    assert.deepEqual((await f.handler('snapshot',{},null,owner)).value.mouseTestRequest,{id:1,sentAt:1000,phase:'sent'});
  }
  assert.equal(f.controls.length,1);assert.deepEqual(local.interactions,[1000]);
  assert.equal(f.runtime.mousePlay.lastPlayed,500);
  local.advance(1);
  const retried=await f.handler('action',{action:'test-mouse-play'},null,owner);
  assert.deepEqual(retried.value.mouseTestRequest,{id:2,sentAt:3000,phase:'sent'});
  assert.equal(f.controls.length,2);assert.equal(f.runtime.mousePlay.lastPlayed,500);
});

test('unrelated native active and ended reports never confirm a mouse test request',async()=>{
  const f=fixture(),local=mouseReady(f);
  await f.handler('action',{action:'test-mouse-play'},null,owner);
  f.runtime.native.mousePlayActive=true;f.runtime.native.mouseStatus='正在轻拉鼠标';
  assert.equal((await f.handler('snapshot',{},null,owner)).value.mouseTestRequest.phase,'sent');
  local.advance(2000);
  assert.deepEqual((await f.handler('snapshot',{},null,owner)).value.mouseTestRequest,{id:1,sentAt:1000,phase:'unconfirmed'});
  f.runtime.native.mousePlayActive=false;f.runtime.native.mouseStatus='指针互动已结束';
  assert.equal((await f.handler('snapshot',{},null,owner)).value.mouseTestRequest.phase,'unconfirmed');
  assert.equal(f.controls.length,1);assert.deepEqual(f.calls,[]);
});

test('helper replacement, disconnect, generation and route changes permanently stale the prior mouse request',async()=>{
  for(const mutate of [
    f=>{f.setHelper({...f.helper,state:{running:true}});return()=>f.setHelper(f.helper);},
    f=>{f.helper.state.running=false;return()=>{f.helper.state.running=true;};},
    f=>{f.runtime.generation++;return()=>{f.runtime.generation--;};},
    f=>{f.runtime.route.model='other';return()=>{f.runtime.route.model='vision';};},
    f=>{f.runtime.routeFingerprint='other';return()=>{delete f.runtime.routeFingerprint;};},
  ]) {
    const f=fixture();mouseReady(f);
    await f.handler('action',{action:'test-mouse-play'},null,owner);
    const restore=mutate(f);
    const result=await f.handler('snapshot',{},null,owner);
    assert.deepEqual(result.value.mouseTestRequest,{id:1,sentAt:1000,phase:'stale'});
    restore();
    assert.equal((await f.handler('snapshot',{},null,owner)).value.mouseTestRequest.phase,'stale');
    assert.equal(f.controls.length,1);assert.deepEqual(f.calls,[]);
  }
});
test('private memory and controls require owner and a live peer',async()=>{
  const f=fixture();
  assert.equal((await f.handler('snapshot',{},null,{principal:{kind:'viewer'}})).error.code,'forbidden');
  assert.equal((await f.handler('snapshot',{},AbortSignal.abort(),owner)).error.code,'aborted');
  assert.equal((await f.handler('snapshot',{},null,owner)).value.helper.running,true);
});
test('settings patches cannot bypass screen/audio consent or replace default route',async()=>{
  const f=fixture();
  assert.equal((await f.handler('update-settings',{patch:{screenEnabled:true}},null,owner)).error.code,'explicit-consent-required');
  assert.equal((await f.handler('update-settings',{patch:{videoAudioEnabled:true}},null,owner)).error.code,'explicit-consent-required');
  assert.equal((await f.handler('update-settings',{patch:{mousePlayEnabled:true}},null,owner)).error.code,'explicit-consent-required');
  await f.handler('update-settings',{patch:{provider:'other',model:'other',consentPair:'forged',voiceEnabled:true}},null,owner);
  assert.deepEqual(f.calls,[{type:'settings',voiceEnabled:true}]);assert.equal(f.controls.length,0);
});
test('only explicit permission actions reach native gates and unsupported images stay off',async()=>{
  const f=fixture();
  await f.handler('action',{action:'request-audio-permission'},null,owner);
  assert.deepEqual(f.controls,[{type:'control',action:'enable-system-audio'}]);
  f.runtime.visionAvailable=false;
  assert.equal((await f.handler('action',{action:'request-screen-permission'},null,owner)).ok,false);
  assert.equal(f.controls.length,1);
});
test('forget remains a local operation and appearance ranges are bounded',async()=>{
  const f=fixture();
  await f.handler('action',{action:'memory-forget',text:'fact-id'},null,owner);
  assert.deepEqual(f.calls,[{type:'chat',text:'/forget fact-id'}]);
  await f.handler('action',{action:'set-appearance',scale:100,opacity:-2},null,owner);
  assert.deepEqual(f.controls,[{type:'control',action:'set-appearance',scale:1.6,opacity:0.45}]);
});
test('growth panel visibility can turn on and off without changing growth or requesting permissions',async()=>{
  const f=fixture();f.runtime.settings.growthEnabled=true;
  const visible=await f.handler('update-settings',{patch:{growthPanelVisible:true}},null,owner);
  assert.equal(visible.ok,true);assert.equal(visible.value.settings.growthPanelVisible,true);
  assert.equal(visible.value.settings.growthEnabled,true);
  const hidden=await f.handler('update-settings',{patch:{growthPanelVisible:false}},null,owner);
  assert.equal(hidden.ok,true);assert.equal(hidden.value.settings.growthPanelVisible,false);
  assert.equal(hidden.value.settings.growthEnabled,true);
  assert.deepEqual(f.calls,[{type:'settings',growthPanelVisible:true},{type:'settings',growthPanelVisible:false}]);
  assert.equal(f.controls.length,0);
});

test('explicit permission disable cancels pending native intent even if the saved feature is already false',async()=>{
  const f=fixture();
  f.runtime.native={screenConsentPending:true,audioConsentPending:true,mouseConsentPending:true};
  const result=await f.handler('update-settings',{patch:{screenEnabled:false,videoAudioEnabled:false,mousePlayEnabled:false}},null,owner);
  assert.equal(result.ok,true);
  assert.deepEqual(f.controls,[{type:'control',action:'disable-screen'},
    {type:'control',action:'disable-system-audio'},{type:'control',action:'disable-mouse-play'}]);
  assert.equal(f.runtime.settings.consentPair,'');assert.equal(f.runtime.settings.audioConsentPair,'');
  await f.handler('update-settings',{patch:{observationEnabled:false}},null,owner);
  assert.deepEqual(f.controls.at(-1),{type:'control',action:'pause'});
});

test('checking system permissions is read-only and does not refresh the route or enable any feature',async()=>{
  const f=fixture();let routeRefreshes=0;f.runtime.refreshRoute=async()=>{routeRefreshes++;};
  f.runtime.native={screenConsentPending:true};
  const result=await f.handler('action',{action:'refresh-permissions'},null,owner);
  assert.equal(result.ok,true);assert.equal(routeRefreshes,0);
  assert.deepEqual(f.controls,[{type:'control',action:'refresh-permissions'}]);
  assert.deepEqual(f.calls,[]);assert.equal(result.value.settings.screenEnabled,false);
});

test('permission actions cannot overlap a native dialog and return a specific safe failure',async()=>{
  const f=fixture();f.runtime.native={permissionRequestInFlight:true};
  for(const action of ['request-screen-permission','request-audio-permission','request-mouse-permission']) {
    const result=await f.handler('action',{action},null,owner);
    assert.equal(result.ok,false);assert.equal(result.error.code,'permission-in-progress');
  }
  assert.equal(f.controls.length,0);
  f.runtime.visionAvailable=false;f.runtime.native={};
  assert.equal((await f.handler('action',{action:'request-screen-permission'},null,owner)).error.code,'vision-unavailable');
});

test('ordinary switches echo both values and do not request OS permissions',async()=>{
  const names=['observationEnabled','voiceEnabled','lipSyncEnabled','memoryEnabled','agentProgressEnabled','reduceMotion',
    'dynamicSkinEnabled','quietMeetingApps','urgentAgentAlerts','growthEnabled','snackRewardsEnabled','autoEatEnabled','growthPanelVisible'];
  for(const name of names) {
    const f=fixture();
    for(const value of [true,false,true]) {
      const result=await f.handler('update-settings',{patch:{[name]:value}},null,owner);
      assert.equal(result.ok,true);assert.equal(result.value.settings[name],value,name);
    }
    assert.deepEqual(f.controls,name==='observationEnabled'?[{type:'control',action:'pause'}]:[],name);
  }
});
