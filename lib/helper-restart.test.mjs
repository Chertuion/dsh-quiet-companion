import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelperRestarter } from './helper-restart.mjs';

function fixture() {
  const events=[];
  const runtime={ready:Promise.resolve(),settings:{observationEnabled:false,screenEnabled:true,videoAudioEnabled:false,
    provider:'fixture',model:'vision',consentPair:'fixture\u001fvision',audioConsentPair:''},
    native:{screenEnabled:true,screenAuthorized:true,audioConsentPending:true,permissionRequestInFlight:true,petSleeping:true},
    frames:[{synthetic:true}],transcript:'synthetic temporary text',latest:{synthetic:true},pendingStart:'old-start',
    cancel(){events.push('cancel');},clearFrames(){events.push('clear-frames');this.frames=[];},
    clearTranscript(){events.push('clear-transcript');this.transcript='';},
    handle(){throw new Error('Restart must not persist synthetic off settings.');}};
  const initial=structuredClone(runtime.settings);
  let current,disposed=false,acceptedOldEchoes=0,starts=0,disposeImpl;
  const old={dispose:async()=>{
    events.push('dispose');assert.equal(current,undefined);
    if(current===old) acceptedOldEchoes++;
    if(disposeImpl) await disposeImpl();
  }};
  current=old;
  const restart=createHelperRestarter({runtime,
    detach:()=>{events.push('detach');const previous=current;current=undefined;return previous;},
    start:async()=>{events.push('start');starts++;current={dispose:async()=>{}};},isDisposed:()=>disposed});
  return {runtime,initial,events,restart,get current(){return current;},get starts(){return starts;},
    get acceptedOldEchoes(){return acceptedOldEchoes;},
    blockDispose:()=>new Promise(resolve=>{disposeImpl=()=>new Promise(done=>{resolve(done);});}),
    disposeOwner:()=>{disposed=true;}};
}

test('helper restart clears transient private context while preserving explicit settings and valid consent',async()=>{
  for(const [observationEnabled,videoAudioEnabled] of [[false,false],[false,true],[true,true]]) {
    const f=fixture();Object.assign(f.runtime.settings,{observationEnabled,videoAudioEnabled,
      audioConsentPair:videoAudioEnabled?f.initial.consentPair:''});
    const settings=structuredClone(f.runtime.settings);await f.restart.restart();
    assert.deepEqual(f.runtime.settings,settings);
    for(const key of ['screenEnabled','audioEnabled','mousePlayEnabled','permissionRequestInFlight',
      'screenConsentPending','audioConsentPending','mouseConsentPending']) assert.equal(f.runtime.native[key],false);
    assert.equal(f.runtime.native.screenAuthorized,undefined);assert.equal(f.runtime.native.screenPermissionState,'unavailable');
    assert.match(f.runtime.native.screenStatus,/当前不采集/u);assert.equal(f.runtime.native.petSleeping,true);
    assert.deepEqual(f.runtime.frames,[]);
    assert.equal(f.runtime.transcript,'');assert.equal(f.runtime.latest,null);assert.equal(f.runtime.pendingStart,null);
    assert.deepEqual(f.events,['detach','cancel','clear-frames','clear-transcript','dispose','start']);
    assert.equal(f.acceptedOldEchoes,0);assert.equal(f.starts,1);assert.equal(f.restart.pending,undefined);
  }
});

test('a cancelled audio request stays off and a previously paused observer is never turned on by restart',async()=>{
  const f=fixture();await f.restart.restart();
  assert.equal(f.runtime.settings.observationEnabled,false);assert.equal(f.runtime.settings.videoAudioEnabled,false);
  assert.equal(f.runtime.settings.audioConsentPair,'');assert.equal(f.runtime.native.audioConsentPending,false);
  assert.equal(f.runtime.native.permissionRequestInFlight,false);
  assert.equal(f.runtime.settings.screenEnabled,true);assert.equal(f.runtime.settings.consentPair,f.initial.consentPair);
});

test('concurrent restart clicks share one disposal and never start a replacement before the old helper exits',async()=>{
  const f=fixture(),releaseReady=f.blockDispose();
  const first=f.restart.restart(),second=f.restart.restart();
  assert.equal(first,second);
  const release=await releaseReady;assert.equal(f.starts,0);release();await first;
  assert.equal(f.starts,1);assert.equal(f.events.filter(value=>value==='dispose').length,1);
});

test('explicit off and a real route change during restart are not overwritten by a saved pre-restart snapshot',async()=>{
  const f=fixture(),releaseReady=f.blockDispose();const pending=f.restart.restart();
  const release=await releaseReady;
  f.runtime.settings={...f.runtime.settings,screenEnabled:false,videoAudioEnabled:false,consentPair:'',audioConsentPair:'',
    provider:'changed',model:'other'};
  const authoritative=structuredClone(f.runtime.settings);release();await pending;
  assert.deepEqual(f.runtime.settings,authoritative);assert.equal(f.starts,1);
});

test('owner shutdown during disposal never launches another helper or revives a pending feature',async()=>{
  const f=fixture(),releaseReady=f.blockDispose();const pending=f.restart.restart();
  const release=await releaseReady;f.disposeOwner();release();await pending;
  assert.equal(f.starts,0);assert.equal(f.current,undefined);assert.deepEqual(f.runtime.settings,f.initial);
});

test('a failed new launch leaves settings intact and releases the restart lock for an explicit retry',async()=>{
  const f=fixture();let tries=0;
  const restarter=createHelperRestarter({runtime:f.runtime,detach:()=>undefined,start:async()=>{
    tries++;if(tries===1) throw new Error('synthetic launch failure');
  }});
  await assert.rejects(restarter.restart(),/synthetic launch failure/u);
  assert.equal(restarter.pending,undefined);assert.deepEqual(f.runtime.settings,f.initial);
  await restarter.restart();assert.equal(tries,2);assert.deepEqual(f.runtime.settings,f.initial);
});
