import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, metadataOnly, observationsAllowed, shouldAnalyze } from './controller.mjs';

test('preview cannot enable screenshot transport from settings or saved data', () => {
  assert.deepEqual(normalizeSettings({ screenEnabled: true, consentPair: 'anything' }), { ...DEFAULT_SETTINGS });
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
  assert.equal(shouldAnalyze({ settings: active, observation: { app: 'Safari', idleSeconds: 0 },
    previousApp: 'Editor', lastAnalysis: 0, lastSpeech: 99_000, now: 100_000 }), false);
});
