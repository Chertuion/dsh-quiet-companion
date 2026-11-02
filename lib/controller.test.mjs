import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, metadataOnly, observationsAllowed, screenAllowed } from './controller.mjs';

test('default sensing and audio are off while default model and memory are selected', () => {
  const settings=normalizeSettings();
  assert.equal(settings.screenEnabled,false); assert.equal(settings.observationEnabled,false);
  assert.equal(settings.videoAudioEnabled,false); assert.equal(settings.useDefaultModel,true);
  assert.equal(settings.memoryEnabled,true);
});
test('desktop growth panel defaults hidden for old profiles and round-trips independently of growth',()=>{
  assert.equal(DEFAULT_SETTINGS.growthPanelVisible,false);
  const previous={growthEnabled:true,snackRewardsEnabled:true,autoEatEnabled:true,tokensPerSnack:4000};
  const migrated=normalizeSettings(previous);
  assert.equal(migrated.growthPanelVisible,false);
  const visible=normalizeSettings({...migrated,growthPanelVisible:true});
  assert.equal(visible.growthPanelVisible,true);assert.equal(visible.growthEnabled,true);
  assert.equal(normalizeSettings(JSON.parse(JSON.stringify(visible))).growthPanelVisible,true);
  const hidden=normalizeSettings({...visible,growthPanelVisible:false});
  assert.equal(hidden.growthPanelVisible,false);assert.equal(hidden.growthEnabled,true);
  assert.equal(hidden.tokensPerSnack,4000);assert.equal(hidden.autoEatEnabled,true);
  assert.equal(normalizeSettings({growthEnabled:false,growthPanelVisible:true}).growthEnabled,false);
  assert.equal(normalizeSettings({growthPanelVisible:'true'}).growthPanelVisible,false);
});
test('screen and audio require consent to the actual model pair', () => {
  const input={observationEnabled:true,provider:'p',model:'m',screenEnabled:true,videoAudioEnabled:true};
  assert.equal(normalizeSettings(input).screenEnabled,false);
  const allowed=normalizeSettings({...input,consentPair:'p\u001fm',audioConsentPair:'p\u001fm'});
  assert.equal(allowed.screenEnabled,true); assert.equal(allowed.videoAudioEnabled,true);
  assert.equal(screenAllowed(allowed,{provider:'p',model:'m',vision:true}),true);
  assert.equal(screenAllowed(allowed,{provider:'p',model:'different',vision:true}),false);
  assert.equal(screenAllowed(allowed,{provider:'p',model:'m',vision:false}),false);
  assert.equal(normalizeSettings({...allowed,model:'new'}).screenEnabled,false);
});
test('metadata policy removes pixels, window titles and URLs', () => {
  const output = metadataOnly({ app: 'Safari', bundleId: 'com.apple.Safari', idleSeconds: 5,
    screen: { data: 'SECRET' }, title: 'private title', url: 'https://private.example', timestamp: 1 });
  assert.equal(JSON.stringify(output).includes('SECRET'), false);
  assert.equal(JSON.stringify(output).includes('private'), false);
  assert.equal(output.timestamp, '1970-01-01T00:00:00.001Z');
});
test('pause, snooze and unselected destination block automatic inference', () => {
  const active = { ...DEFAULT_SETTINGS, observationEnabled: true, provider: 'p', model: 'm' };
  assert.equal(observationsAllowed(DEFAULT_SETTINGS, 1_000), false);
  assert.equal(observationsAllowed({ ...active, snoozeUntil: 2_000 }, 1_000), false);
  assert.equal(observationsAllowed({ ...active, model: '' }, 1_000), false);
  assert.equal(observationsAllowed(active, 1_000), true);
});
