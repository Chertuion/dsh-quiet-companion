import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsHandler } from './settings-rpc.mjs';
const owner={principal:{kind:'owner'}};
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
