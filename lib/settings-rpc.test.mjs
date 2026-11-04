import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsHandler } from './settings-rpc.mjs';
const owner={principal:{kind:'owner'}};

test('lip sync preferences reach settings without requesting capture or enabling voice',async()=>{
  const f=fixture();f.runtime.settings.voiceEnabled=false;
  const result=await f.handler('update-settings',{patch:{lipSyncEnabled:false}},null,owner);
  assert.equal(result.value.settings.lipSyncEnabled,false);assert.equal(result.value.settings.voiceEnabled,false);
  assert.equal(f.controls.length,0);
});
function fixture() {
  const calls=[],controls=[];
  const runtime={ready:Promise.resolve(),settings:{screenEnabled:false,videoAudioEnabled:false},
    route:{provider:'host-default',model:'vision'},visionAvailable:true,
    snapshot:async()=>({settings:{...runtime.settings},memory:{facts:[]}}),
    handle:async message=>{calls.push(message);if(message.type==='settings') Object.assign(runtime.settings,message);},
    refreshRoute:async()=>{}};
  const handler=createSettingsHandler({runtime,getHelper:()=>({state:{running:true},send:message=>{controls.push(message);return true;}}),
    restartHelper:async()=>{calls.push('restart');}});
  return {runtime,handler,calls,controls};
}
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
