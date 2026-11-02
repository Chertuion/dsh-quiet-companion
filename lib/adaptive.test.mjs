import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveEngine } from './adaptive.mjs';

const settings = { observationEnabled: true, screenEnabled: true };
const app = (name = 'Editor', extra = {}) => ({ app: name, bundleId: `com.fixture.${name}`, idleSeconds: 2, ...extra });
function fixture(options = {}) {
  let time = 100_000;
  const engine = new AdaptiveEngine({ now: () => time, ...options });
  return { engine, advance: ms => { time += ms; }, get now() { return time; } };
}

test('stable frame and cooldown expiration alone never request model analysis', () => {
  const f = fixture(); const obs = app('Editor', { visualFingerprint: 'a', visualChange: 0 });
  assert.equal(f.engine.evaluate(obs, settings).shouldAnalyze, false);
  f.engine.recordAnalysis(); f.engine.recordSpeech(); f.advance(120_000);
  assert.equal(f.engine.evaluate(obs, settings).shouldAnalyze, false);
  assert.equal(f.engine.evaluate(obs, settings).reason, 'no-new-event');
});

test('app switch requires dwell and rapid switches coalesce without stale commentary', () => {
  const f = fixture(); f.engine.evaluate(app('Editor'), settings);
  f.advance(500); assert.equal(f.engine.evaluate(app('Browser'), settings).shouldAnalyze, false);
  f.advance(1000); f.engine.evaluate(app('Editor'), settings);
  f.advance(6000); assert.equal(f.engine.evaluate(app('Editor'), settings).shouldAnalyze, false);
  f.engine.evaluate(app('Browser'), settings); f.advance(5000);
  const event = f.engine.evaluate(app('Browser'), settings);
  assert.equal(event.trigger, 'app-change');
  f.engine.recordAnalysis(event); f.advance(200_000);
  assert.equal(f.engine.evaluate(app('Browser'), settings).shouldAnalyze, false);
});

test('scene changes need new fingerprint and novelty; raw frames never enter retained state', () => {
  const f = fixture(); f.engine.evaluate(app('Browser', { visualFingerprint: 'first', visualChange: 1 }), settings);
  f.advance(1000);
  assert.equal(f.engine.evaluate(app('Browser', { visualFingerprint: 'tiny', visualChange: 0.02 }), settings).shouldAnalyze, false);
  const result = f.engine.evaluate(app('Browser', { visualFingerprint: 'new_scene', visualChange: 0.7,
    screen: { data: 'SECRET_FRAME', mimeType: 'image/png' }, frames: [{ data: 'SECRET_VIDEO_FRAME' }], title: 'SECRET_TITLE' }), settings);
  assert.equal(result.trigger, 'scene-change');
  f.engine.recordAnalysis(result);
  assert.equal(/SECRET/u.test(JSON.stringify(f.engine.inspect())), false);
  f.advance(200_000);
  assert.equal(f.engine.evaluate(app('Browser', { visualFingerprint: 'new_scene', visualChange: 1 }), settings).shouldAnalyze, false);
});

test('new scenes during spacing coalesce to newest, and model silence consumes event', () => {
  const f = fixture(); f.engine.evaluate(app('Browser', { visualFingerprint: 'a' }), settings); f.engine.recordAnalysis();
  for (const fingerprint of ['b', 'c', 'd']) {
    f.advance(2000);
    assert.equal(f.engine.evaluate(app('Browser', { visualFingerprint: fingerprint, visualChange: 0.8 }), settings).reason, 'adaptive-spacing');
  }
  assert.equal(f.engine.inspect().pendingEvents.length, 1);
  f.advance(100_000); const event = f.engine.evaluate(app('Browser', { visualFingerprint: 'd' }), settings);
  assert.match(event.key, /:d$/u); f.engine.recordAnalysis(event);
  assert.equal(f.engine.evaluate(app('Browser', { visualFingerprint: 'd' }), settings).shouldAnalyze, false);
});

test('unanswered prior speech expands quiet time; interaction resets it without a fixed timer trigger', () => {
  const f = fixture(); f.engine.evaluate(app(), settings);
  for (let i = 0; i < 2; i++) {
    f.engine.recordSpeech(); f.advance(250_000); f.engine.evaluate(app(), settings);
  }
  assert.equal(f.engine.inspect().ignoredCount, 2);
  f.engine.evaluate(app('Browser'), settings); f.advance(5000);
  const spacing = f.engine.evaluate(app('Browser'), settings);
  assert.equal(spacing.reason, 'adaptive-spacing');
  assert.ok(spacing.quietMs > 90_000);
  f.advance(30_000);
  assert.equal(f.engine.evaluate(app('Browser'), settings).reason, 'recently-unengaged');
  f.engine.recordUserInteraction();
  assert.equal(f.engine.inspect().ignoredCount, 0);
  assert.equal(f.engine.evaluate(app('Browser'), settings).shouldAnalyze, false);
});

test('pause, snooze, meeting apps, absence, and actual budget suppress automatic analysis', () => {
  for (const [patch, context, expected] of [
    [{ paused: true }, {}, 'paused'], [{ snoozeUntil: 9999999 }, {}, 'snoozed'],
    [{}, { budgetReached: true }, 'budget-reached'], [{}, { budget: { reached: true } }, 'budget-reached'],
  ]) {
    const f = fixture();
    assert.equal(f.engine.evaluate(app(), { ...settings, ...patch }, context).reason, expected);
  }
  const f = fixture();
  assert.equal(f.engine.evaluate({ app: 'zoom.us', bundleId: 'us.zoom.xos' }, settings).reason, 'quiet-context');
  assert.equal(f.engine.evaluate(app('Editor', { idleSeconds: 600 }), settings).reason, 'user-away');
});

test('one new urgent approval may pass spacing once; ordinary repeat cannot', () => {
  const f = fixture(); f.engine.evaluate(app(), settings); f.engine.recordAnalysis();
  const agent = { current: { sessionId: 's1', phase: 'waiting-approval', turn: 2, step: 3 } };
  const event = f.engine.evaluate(app(), { ...settings, urgentAgentAlerts: true }, { agent });
  assert.equal(event.shouldAnalyze, true); assert.equal(event.trigger, 'agent-approval');
  f.engine.recordAnalysis(event);
  assert.equal(f.engine.evaluate(app(), { ...settings, urgentAgentAlerts: true }, { agent }).shouldAnalyze, false);
  const nextApproval = { current: { ...agent.current, approvalRevision: 2 } };
  assert.equal(f.engine.evaluate(app(), { ...settings, urgentAgentAlerts: true }, { agent: nextApproval }).shouldAnalyze, true);
  const normal = fixture(); normal.engine.evaluate(app(), settings); normal.engine.recordAnalysis();
  assert.equal(normal.engine.evaluate(app(), settings, { agent }).reason, 'adaptive-spacing');
});

test('explicit interaction bypasses speech spacing; long activity is one threshold event, not recurring', () => {
  const f = fixture({ prolongedActivityMs: 60_000 }); f.engine.evaluate(app(), settings); f.engine.recordSpeech();
  const explicit = f.engine.evaluate(app(), settings, { userInteractionId: 'touch-1' });
  assert.equal(explicit.shouldAnalyze, true); assert.equal(explicit.trigger, 'user-interaction');
  f.engine.recordAnalysis(explicit); f.advance(120_000);
  const prolonged = f.engine.evaluate(app(), settings);
  assert.equal(prolonged.trigger, 'prolonged-activity'); f.engine.recordAnalysis(prolonged);
  f.advance(120_000);
  assert.equal(f.engine.evaluate(app(), settings).shouldAnalyze, false);
});

test('new authorized dialogue digests coalesce, dedup and never retain transcript text', () => {
  const f = fixture(); f.engine.evaluate(app('Browser'), settings); f.engine.recordAnalysis();
  for (const character of ['a', 'b', 'c']) {
    f.advance(1000);
    const event = f.engine.evaluate(app('Browser', { transcriptFingerprint: character.repeat(64),
      transcript: 'PRIVATE_AUDIO_DIALOGUE', audio: { data: 'PRIVATE_AUDIO_BYTES' } }), settings);
    assert.equal(event.reason, 'adaptive-spacing');
  }
  assert.equal(f.engine.inspect().pendingEvents.length, 1);
  assert.equal(JSON.stringify(f.engine.inspect()).includes('PRIVATE'), false);
  f.advance(100_000);
  const event = f.engine.evaluate(app('Browser', { transcriptFingerprint: 'c'.repeat(64) }), settings);
  assert.equal(event.trigger, 'video-dialogue'); assert.match(event.key, new RegExp(`:${'c'.repeat(64)}$`, 'u'));
  f.engine.recordAnalysis(event); f.advance(100_000);
  assert.equal(f.engine.evaluate(app('Browser', { transcriptFingerprint: 'c'.repeat(64) }), settings).shouldAnalyze, false);
  assert.equal(f.engine.evaluate(app('Browser'), settings, { transcriptId: 'transcript-2' }).trigger, 'video-dialogue');
});

test('dialogue events obey pause/meeting suppression and explicit audio opt-out', () => {
  const f = fixture();
  const observation = app('Browser', { transcriptFingerprint: 'd'.repeat(64) });
  assert.equal(f.engine.evaluate(observation, { ...settings, audioEnabled: false }).shouldAnalyze, false);
  assert.equal(f.engine.evaluate(observation, { ...settings, paused: true }).reason, 'paused');
  assert.equal(f.engine.evaluate({ ...observation, app: 'Teams', bundleId: 'com.microsoft.teams' }, settings).reason, 'quiet-context');
  assert.equal(f.engine.inspect().pendingEvents.length, 0);
});

test('expired or revoked dialogue evidence removes delayed events before spacing expires', () => {
  for (const mode of ['expired', 'revoked', 'disabled']) {
    const f = fixture(); f.engine.evaluate(app('Browser'), settings); f.engine.recordAnalysis();
    const withDialogue = app('Browser', { transcriptFingerprint: 'e'.repeat(64) });
    assert.equal(f.engine.evaluate(withDialogue, settings, { audioAllowed: true }).reason, 'adaptive-spacing');
    assert.equal(f.engine.inspect().pendingEvents[0].trigger, 'video-dialogue');
    f.advance(100_000);
    const result = mode === 'expired' ? f.engine.evaluate(app('Browser'), settings, { audioAllowed: true })
      : mode === 'revoked' ? f.engine.evaluate(withDialogue, settings, { audioAllowed: false })
        : f.engine.evaluate(withDialogue, { ...settings, audioEnabled: false }, { audioAllowed: true });
    assert.equal(result.shouldAnalyze, false, mode);
    assert.equal(f.engine.inspect().pendingEvents.some(item => item.trigger === 'video-dialogue'), false, mode);
    // A stale copy of the same text is not a new event after the current evidence was dropped.
    assert.equal(f.engine.evaluate(withDialogue, settings, { audioAllowed: true }).shouldAnalyze, false, mode);
  }
});
