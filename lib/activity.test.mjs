import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachAgentProgress } from './activity.mjs';

function fixture(agents = [], projections) {
  const events = new EventEmitter();
  const services = { agents: { list: () => agents, get: id => agents.find(agent => agent.id === id) }, sessionProjections: projections };
  return { events, ctx: { get: key => services[key], on(event, listener) {
    events.on(event, listener); return () => events.off(event, listener);
  } } };
}
const agent = id => ({ id, session: { id }, status: 'running' });

test('bootstrap reads only selected rc5 projections; seq is never displayed as a step', async () => {
  const a = agent('session-1');
  const accesses = [];
  const f = fixture([a], { snapshot(session, keys) { accesses.push(keys); return { values: { sessionStats: { steps: 7 }, userQuestions: { active: [] } } }; },
    stateOf() { return { lastTurn: 3, lastStepStartSeq: 999, openTurnStartSeq: 990 }; } });
  let current;
  const dispose = attachAgentProgress(f.ctx, value => { current = value; });
  assert.equal(current.current.turn, 3);
  assert.equal(current.current.step, null);
  assert.equal(current.current.completedSteps, 7);
  assert.deepEqual(accesses[0], ['sessionStats', 'userQuestions']);
  assert.equal('percent' in current.current, false);
  await dispose();
});

test('real turn/tool/approval events drive progress without copying private content', async () => {
  const a = agent('s1'); const f = fixture([a]);
  const updates = []; let stamp = 10;
  const dispose = attachAgentProgress(f.ctx, value => updates.push(value), { now: () => ++stamp });
  const emit = (type, data, seq) => f.events.emit('session/event', a.session, { type, data, seq });
  emit('turn/start', { turn: 1 }, 1);
  emit('step/start', { turn: 1, step: 2 }, 2);
  emit('tool/call', { turn: 1, step: 2, callId: 'c1', name: 'exec_command', arguments: 'SECRET_PROMPT /Users/private password' }, 3);
  assert.equal(updates.at(-1).current.phase, 'tool');
  emit('approval/asked', { id: 'approval', toolName: 'exec_command', reason: 'SECRET_REASON' }, 4);
  assert.equal(updates.at(-1).current.phase, 'waiting-approval');
  emit('approval/decided', { id: 'approval', outcome: 'allowed-once' }, 5);
  assert.equal(updates.at(-1).current.phase, 'tool');
  emit('tool/result', { turn: 1, step: 2, message: { toolCallId: 'c1', isError: true, content: 'PRIVATE RESULT' }, error: { reason: 'PRIVATE_ERROR_STACK' } }, 6);
  assert.equal(updates.at(-1).current.phase, 'error');
  emit('step/end', { turn: 1, step: 2 }, 7);
  emit('step/end', { turn: 1, step: 2 }, 7);
  assert.equal(updates.at(-1).current.observedCompletedSteps, 1);
  assert.equal(updates.at(-1).current.observedCompletedTools, 1);
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 8);
  assert.equal(updates.at(-1).current.phase, 'completed');
  assert.equal(/SECRET|PRIVATE|\/Users/u.test(JSON.stringify(updates)), false);
  await dispose();
  const count = updates.length; emit('turn/start', { turn: 4 }, 9);
  assert.equal(updates.length, count);
  assert.equal(f.events.listenerCount('session/event'), 0);
});

test('approval has priority across sessions; status idle does not erase completion', async () => {
  const a = agent('a'); const b = agent('b'); const f = fixture([a, b]);
  let snapshot; const dispose = attachAgentProgress(f.ctx, value => { snapshot = value; });
  f.events.emit('session/event', a.session, { type: 'approval/asked', data: { id: 'x', toolName: 'read' }, seq: 1 });
  f.events.emit('session/event', b.session, { type: 'turn/start', data: { turn: 2 }, seq: 1 });
  assert.equal(snapshot.current.sessionId, 'a');
  assert.equal(snapshot.waitingCount, 1);
  f.events.emit('session/event', a.session, { type: 'turn/end', data: { reason: { kind: 'completed' } }, seq: 2 });
  f.events.emit('agent/status', { agent: a, status: 'idle' });
  assert.equal(snapshot.current.sessionId, 'b');
  assert.equal(snapshot.sessions.find(row => row.sessionId === 'a').phase, 'completed');
  f.events.emit('agent/disposed', { agent: b });
  assert.equal(snapshot.current.phase, 'completed');
  await dispose();
});

test('stream shape detects thinking/replying but ignores tokens and malformed identities', async () => {
  const a = agent('/Users/private/prompt title'); const f = fixture([a]);
  const updates = []; const dispose = attachAgentProgress(f.ctx, value => updates.push(value));
  f.events.emit('agent/assistant-stream', { agent: a, frame: { type: 'start', turn: 1, step: 3 } });
  f.events.emit('agent/assistant-stream', { agent: a, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'SECRET' } } });
  assert.equal(updates.at(-1).current.phase, 'replying');
  assert.match(updates.at(-1).current.sessionId, /^session-[a-f0-9]{12}$/u);
  assert.equal(JSON.stringify(updates).includes('SECRET'), false);
  assert.equal(JSON.stringify(updates).includes('/Users'), false);
  const count = updates.length;
  f.events.emit('agent/assistant-stream', { agent: a, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'MORE SECRET' } } });
  assert.equal(updates.length, count);
  await dispose();
});

test('observer rejection cannot break host event handling and absence stays unknown', async () => {
  const f = fixture();
  const dispose = attachAgentProgress(f.ctx, () => { throw new Error('observer failure'); });
  assert.doesNotThrow(() => f.events.emit('agent/created', { agent: agent('s') }));
  assert.equal(dispose.snapshot().current.completedSteps, null);
  await dispose(); await dispose();
});

test('continued timed questions remain answerable but do not fabricate a blocked Agent', async () => {
  const a = agent('timed');
  const f = fixture([a], { snapshot() { return { values: { userQuestions: {
    active: [{ state: 'continued', questions: 'PRIVATE_QUESTION_TEXT' }],
  } } }; } });
  let latest; const dispose = attachAgentProgress(f.ctx, value => { latest = value; });
  assert.equal(latest.current.waitingUser, false);
  f.events.emit('session/event', a.session, { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } });
  assert.equal(latest.current.phase, 'completed');
  assert.equal(JSON.stringify(latest).includes('PRIVATE'), false);
  await dispose();
});
