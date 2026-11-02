/** Read-only DSH 0.2.1-rc.5 progress adapter. No transcript, tool args, or errors are copied. */
import { createHash } from 'node:crypto';

const boundedCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const service = (ctx, key) => { try { return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]; } catch { return undefined; } };
const safeIdentity = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/u.test(value)
  ? value : `session-${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
const safeTool = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(value) ? value : '工具';
const ACTIVE = new Set(['running', 'thinking', 'replying', 'tool', 'waiting-approval', 'waiting-user']);
const PRIORITY = { 'waiting-approval': 100, 'waiting-user': 90, tool: 60, replying: 55, thinking: 50, running: 45,
  error: 30, blocked: 25, completed: 20, cancelled: 15, interrupted: 10, idle: 0 };

/**
 * Subscribe to public live/durable facts and selected projections, never to prompt text.
 * Returns an async disposer with snapshot(). Callback receives:
 * {available,current,sessions,activeCount,waitingCount,timestamp}.
 * completedSteps is the actual sessionStats whole-log count or null when unavailable;
 * observedCompletedSteps/Tools count distinct events since attachment. No task total or percent is inferred.
 */
export function attachAgentProgress(ctx, onUpdate, { now = Date.now, maxSessions = 32 } = {}) {
  const agents = service(ctx, 'agents');
  const projections = service(ctx, 'sessionProjections');
  const records = new Map();
  const disposers = [];
  let disposed = false;
  let lastPublished = '';
  const available = typeof ctx?.on === 'function';

  function recordFor(session, agent) {
    const id = session?.id ?? agent?.id;
    if (typeof id !== 'string' || !id || id.length > 4096) return null;
    let record = records.get(id);
    if (!record) {
      if (records.size >= maxSessions) {
        const victim = [...records.values()].filter(item => !ACTIVE.has(item.phase)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (victim) records.delete(victim.id);
        else return null;
      }
      record = { id, session, agent, phase: agent?.status === 'running' ? 'running' : 'idle', turn: null, step: null,
        toolName: '', tools: new Map(), approvals: new Set(), approvalRevision: 0, waitingUser: false, completedSteps: null,
        observedCompletedSteps: 0, observedCompletedTools: 0, endedSteps: new Set(), endedTools: new Set(),
        updatedAt: now(), lastSeq: null };
      records.set(id, record);
    }
    if (session) record.session = session;
    if (agent) record.agent = agent;
    return record;
  }

  function readProjection(record, initial = false) {
    if (!record.session || !projections) return;
    try {
      const values = projections.snapshot?.(record.session, ['sessionStats', 'userQuestions'])?.values;
      const steps = boundedCount(values?.sessionStats?.steps);
      if (steps !== null) record.completedSteps = steps;
      if (Array.isArray(values?.userQuestions?.active)) {
        // Timed questions in `continued` stay answerable after the Agent resumed;
        // answerability is not proof that the Agent is blocked waiting for the user.
        record.waitingUser = values.userQuestions.active.some(question => question?.state === 'open');
      }
    } catch { /* A missing optional projection means unknown, not zero. */ }
    if (!initial) return;
    try {
      const boundary = projections.stateOf?.(record.session, 'turnBoundary');
      if (boundedCount(boundary?.lastTurn) !== null) record.turn = boundary.lastTurn;
      if (boundary?.openTurnStartSeq !== null && boundary?.openTurnStartSeq !== undefined) record.phase = 'running';
      // Boundary seq numbers are not step numbers and are deliberately never displayed as steps.
    } catch { /* The rc5 projection capability can be absent. */ }
  }

  function view(record) {
    const phase = record.approvals.size ? 'waiting-approval' : record.waitingUser ? 'waiting-user' : record.phase;
    return { sessionId: safeIdentity(record.id), phase, turn: record.turn, step: record.step,
      toolName: record.toolName, activeTools: record.tools.size,
      approvalRevision: record.approvalRevision,
      waitingApproval: record.approvals.size > 0, waitingUser: record.waitingUser,
      completedSteps: record.completedSteps, observedCompletedSteps: record.observedCompletedSteps,
      observedCompletedTools: record.observedCompletedTools, updatedAt: record.updatedAt };
  }
  function snapshot() {
    const sessions = [...records.values()].map(view).sort((a, b) =>
      (PRIORITY[b.phase] ?? 0) - (PRIORITY[a.phase] ?? 0) || b.updatedAt - a.updatedAt);
    return { available, current: sessions[0] ?? null, sessions,
      activeCount: sessions.filter(item => ACTIVE.has(item.phase)).length,
      waitingCount: sessions.filter(item => item.waitingApproval || item.waitingUser).length, timestamp: now() };
  }
  function publish() {
    if (disposed) return;
    const value = snapshot();
    const fingerprint = JSON.stringify({ ...value, timestamp: 0 });
    if (fingerprint === lastPublished) return;
    lastPublished = fingerprint;
    try {
      const result = onUpdate?.(value);
      if (result && typeof result.catch === 'function') void result.catch(() => {});
    } catch { /* Progress observers cannot break DSH event delivery. */ }
  }
  function mutate(record, action) {
    if (!record || disposed) return;
    const previous = JSON.stringify(view(record));
    action();
    readProjection(record);
    if (JSON.stringify(view(record)) !== previous) record.updatedAt = now();
    publish();
  }
  function subscribe(event, listener) {
    if (!available) return;
    try {
      const release = ctx.on(event, listener);
      if (typeof release === 'function') disposers.push(release);
      else if (typeof ctx.off === 'function') disposers.push(() => ctx.off(event, listener));
    } catch { /* Optional events do not exist in every composition. */ }
  }

  subscribe('agent/created', payload => {
    if (disposed) return;
    const agent = payload?.agent;
    const record = recordFor(agent?.session, agent);
    if (!record) return;
    readProjection(record, true); publish();
  });
  subscribe('agent/disposed', payload => {
    if (disposed || typeof payload?.agent?.id !== 'string') return;
    records.delete(payload.agent.id); publish();
  });
  subscribe('agent/status', payload => {
    const agent = payload?.agent;
    const record = recordFor(agent?.session, agent);
    mutate(record, () => {
      if (payload.status === 'running' && !ACTIVE.has(record.phase)) record.phase = 'running';
      if (payload.status === 'idle' && ACTIVE.has(record.phase)) {
        record.phase = 'idle'; record.tools.clear(); record.approvals.clear(); record.waitingUser = false; record.toolName = '';
      }
    });
  });
  subscribe('agent/assistant-stream', payload => {
    if (disposed) return;
    const agent = payload?.agent;
    const frame = payload?.frame;
    if (!frame || (frame.type !== 'start' && frame.type !== 'chunk')) return;
    const record = recordFor(agent?.session, agent);
    mutate(record, () => {
      if (frame.type === 'start') {
        record.phase = 'thinking';
        if (boundedCount(frame.turn) !== null) record.turn = frame.turn;
        if (boundedCount(frame.step) !== null) record.step = frame.step;
      } else if (frame.chunk?.type === 'text-delta') record.phase = 'replying';
      else if (frame.chunk?.type === 'reasoning-delta') record.phase = 'thinking';
    });
  });
  subscribe('session/event', (session, event) => {
    if (disposed || !event || typeof event.type !== 'string') return;
    const allowed = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result',
      'approval/asked', 'approval/decided', 'user/message']);
    if (!allowed.has(event.type)) return;
    let agent;
    try { agent = agents?.get?.(session?.id); } catch { /* Optional registry. */ }
    const record = recordFor(session, agent);
    if (!record) return;
    const seq = boundedCount(event.seq);
    if (seq !== null && record.lastSeq !== null && seq <= record.lastSeq) return;
    if (seq !== null) record.lastSeq = seq;
    const data = event.data ?? {};
    mutate(record, () => {
      if (boundedCount(data.turn) !== null) record.turn = data.turn;
      if (boundedCount(data.step) !== null) record.step = data.step;
      switch (event.type) {
        case 'turn/start':
          record.phase = 'thinking'; record.step = null; record.tools.clear(); record.approvals.clear(); record.waitingUser = false; record.toolName = ''; break;
        case 'step/start': record.phase = 'thinking'; record.toolName = ''; break;
        case 'step/end': {
          const key = `${data.turn}:${data.step}`;
          if (boundedCount(data.turn) !== null && boundedCount(data.step) !== null && !record.endedSteps.has(key)) {
            record.endedSteps.add(key); record.observedCompletedSteps++;
          }
          if (!record.tools.size) { record.phase = 'running'; record.toolName = ''; }
          break;
        }
        case 'tool/call':
          if (typeof data.callId === 'string') {
            record.toolName = safeTool(data.name); record.tools.set(data.callId, record.toolName); record.phase = 'tool';
            if (data.name === 'ask_user_question') record.waitingUser = true;
          }
          break;
        case 'tool/result': {
          const callId = data.message?.toolCallId;
          if (typeof callId === 'string' && record.tools.has(callId)) {
            const name = record.tools.get(callId); record.tools.delete(callId);
            if (!record.endedTools.has(callId)) { record.endedTools.add(callId); record.observedCompletedTools++; }
            if (name === 'ask_user_question') record.waitingUser = false;
          }
          record.toolName = [...record.tools.values()].at(-1) ?? '';
          record.phase = data.message?.isError === true ? 'error' : record.tools.size ? 'tool' : 'running';
          break;
        }
        case 'approval/asked':
          if (typeof data.id === 'string') {
            if (!record.approvals.has(data.id)) record.approvalRevision++;
            record.approvals.add(data.id); record.toolName = safeTool(data.toolName);
          }
          break;
        case 'approval/decided':
          if (typeof data.id === 'string') record.approvals.delete(data.id);
          break;
        case 'user/message':
          if (data.source?.kind === 'user-question-reply') record.waitingUser = false;
          break;
        case 'turn/end': {
          const phases = { completed: 'completed', aborted: 'cancelled', error: 'error', blocked: 'blocked',
            'max-tokens': 'blocked', interrupted: 'interrupted', forked: 'interrupted' };
          record.phase = phases[data.reason?.kind] ?? 'idle';
          record.tools.clear(); record.approvals.clear(); record.waitingUser = false; record.toolName = '';
          break;
        }
      }
      // Bound dedup metadata; counts remain factual while raw call ids are not exposed.
      if (record.endedSteps.size > 512) record.endedSteps.delete(record.endedSteps.values().next().value);
      if (record.endedTools.size > 512) record.endedTools.delete(record.endedTools.values().next().value);
    });
  });
  try {
    for (const agent of agents?.list?.() ?? []) {
      const record = recordFor(agent?.session, agent);
      if (record) readProjection(record, true);
    }
  } catch { /* Event updates can still operate if bootstrap is unavailable. */ }
  publish();
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await Promise.allSettled(disposers.map(release => Promise.resolve().then(release)));
    records.clear();
  };
  dispose.snapshot = snapshot;
  return dispose;
}
