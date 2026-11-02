import test from 'node:test';
import assert from 'node:assert/strict';
import {MousePlayPolicy} from './mouse-play.mjs';
test('long ignored gesture requires opt-in, active observation, actual authorization and a new observation',()=>{
  let now=0;const policy=new MousePlayPolicy({now:()=>now});
  const settings={mousePlayEnabled:true,observationEnabled:true,snoozeUntil:0,mousePlayAfterMinutes:20};
  const context={native:{mouseAuthorized:true}};
  const observation={app:'Fixture Editor',bundleId:'fixture.editor',idleSeconds:1};
  assert.equal(policy.evaluate(observation,settings,context),false);
  now=21*60_000;
  assert.equal(policy.evaluate(observation,{...settings,mousePlayEnabled:false},context),false);
  assert.equal(policy.evaluate(observation,settings,{native:{mouseAuthorized:false}}),false);
  assert.equal(policy.evaluate({...observation,idleSeconds:300},settings,context),false);
  assert.equal(policy.evaluate(observation,settings,{...context,agent:{current:{phase:'waiting-approval'}}}),false);
  assert.equal(policy.evaluate(observation,settings,context),true);
  now+=25*60_000;assert.equal(policy.evaluate(observation,settings,context),false);
  now+=6*60_000;policy.interact();assert.equal(policy.evaluate(observation,settings,context),false);
});
