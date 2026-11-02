/** Event-gated proactive policy. Time can delay/coalesce an event; time alone never creates chatter. */
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const clean = (value, size = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/gu, '').slice(0, size) : '';
const meetingApp = value => /(?:^|[.\s_-])(?:zoom|teams|facetime|webex|meeting|voov)(?:$|[.\s_-])|腾讯会议|飞书会议/u.test(value.toLowerCase());
const silent = reason => ({ shouldAnalyze: false, trigger: null, priority: 0, reason });

/**
 * evaluate(observation, settings, context) -> {shouldAnalyze,trigger,priority,reason,key?,quietMs?}.
 * Also accepts evaluate({observation,settings,context}). The model must still be allowed to choose silence.
 * recordAnalysis(decision, now?), recordSpeech(decision, now?), recordUserInteraction(now?), reset(), inspect().
 * Retains only app ids, idle/timestamp/fingerprint metadata. Never retains screen/frames/title/URL/audio.
 */
export class AdaptiveEngine {
  constructor({ now = Date.now, baseQuietMs = 90_000, appDwellMs = 4500,
    visualThreshold = 0.16, prolongedActivityMs = 45 * 60_000 } = {}) {
    this.now = now;
    this.baseQuietMs = Math.max(15_000, finite(baseQuietMs, 90_000));
    this.appDwellMs = Math.max(1000, finite(appDwellMs, 4500));
    this.visualThreshold = Math.max(0.02, Math.min(1, finite(visualThreshold, 0.16)));
    this.prolongedActivityMs = Math.max(60_000, finite(prolongedActivityMs, 45 * 60_000));
    this.reset();
  }

  reset() {
    this.stableApp = '';
    this.candidateApp = '';
    this.candidateSince = null;
    this.lastFingerprint = '';
    this.lastTranscriptKey = '';
    this.lastAgentKey = '';
    this.lastInteractionKey = '';
    this.lastObservation = null;
    this.activeSince = null;
    this.prolongedReported = false;
    this.lastAnalysis = null;
    this.lastSpeech = null;
    this.lastInteraction = null;
    this.awaitingEngagement = null;
    this.ignoredCount = 0;
    this.engagement = 0;
    this.visit = 0;
    this.pending = new Map();
    this.seen = new Map();
    this.urgentDelivered = new Set();
  }

  rememberEvent(event, now) {
    if (this.seen.has(event.key)) return;
    // Repeated scene changes coalesce into the newest scene rather than queueing old commentary.
    if (event.trigger === 'scene-change' || event.trigger === 'video-dialogue') for (const [key, item] of this.pending) {
      if (item.trigger === event.trigger) this.pending.delete(key);
    }
    if (!this.pending.has(event.key)) this.pending.set(event.key, { ...event, createdAt: now });
    while (this.pending.size > 12) this.pending.delete(this.pending.keys().next().value);
  }

  evaluate(observation = {}, settings = {}, context = {}) {
    if (observation && typeof observation === 'object' && 'observation' in observation) {
      const request = observation;
      observation = request.observation ?? {};
      settings = request.settings ?? {};
      context = request.context ?? {};
    }
    const now = finite(context.now, this.now());
    const budget = context.budgetReached === true || context.budget?.reached === true || settings.budgetReached === true;
    if (budget) { this.pending.clear(); return silent('budget-reached'); }
    if (settings.paused === true || settings.observationEnabled === false || context.paused === true) {
      this.pending.clear(); return silent('paused');
    }
    if (finite(settings.snoozeUntil, 0) > now) { this.pending.clear(); return silent('snoozed'); }
    if (context.manual === true) return { shouldAnalyze: true, trigger: 'user-interaction', priority: 100, reason: 'explicit-user-request' };

    for (const [key, stamp] of this.seen) if (now - stamp > 30 * 60_000) this.seen.delete(key);
    for (const [key, event] of this.pending) if (now - event.createdAt > 10 * 60_000) this.pending.delete(key);
    if (this.awaitingEngagement !== null && now - this.awaitingEngagement >= 4 * 60_000) {
      this.ignoredCount = Math.min(5, this.ignoredCount + 1);
      this.engagement = Math.max(0, this.engagement - 1);
      this.awaitingEngagement = null;
    }
    const app = clean(observation.app);
    const bundleId = clean(observation.bundleId);
    const appKey = bundleId || app;
    const idleSeconds = Math.max(0, finite(observation.idleSeconds, 0));
    const fingerprint = typeof observation.visualFingerprint === 'string'
      && /^[A-Za-z0-9_-]{1,128}$/u.test(observation.visualFingerprint) ? observation.visualFingerprint : '';
    const visualAllowed = settings.screenEnabled === true || context.visualAllowed === true;
    this.lastObservation = { app, bundleId, idleSeconds, timestamp: now,
      ...(visualAllowed && fingerprint ? { visualFingerprint: fingerprint } : {}) };

    if (!this.stableApp) { this.stableApp = appKey; this.candidateApp = appKey; }
    if (appKey && appKey !== this.stableApp) {
      if (this.candidateApp !== appKey) { this.candidateApp = appKey; this.candidateSince = now; }
      else if (this.candidateSince !== null && now - this.candidateSince >= this.appDwellMs) {
        this.stableApp = appKey; this.candidateSince = null; this.visit++;
        this.rememberEvent({ trigger: 'app-change', key: `app:${appKey}:${this.visit}`, priority: 42, novelty: 0.5 }, now);
      }
    } else { this.candidateApp = appKey; this.candidateSince = null; }

    if (visualAllowed && fingerprint) {
      const change = Math.max(0, Math.min(1, finite(observation.visualChange, 0)));
      if (this.lastFingerprint && fingerprint !== this.lastFingerprint && change >= this.visualThreshold) {
        this.rememberEvent({ trigger: 'scene-change', key: `scene:${appKey}:${fingerprint}`,
          priority: change >= 0.45 ? 70 : 58, novelty: change }, now);
      }
      this.lastFingerprint = fingerprint;
    } else this.lastFingerprint = '';

    // Root supplies only a digest/id after authorized transcription; raw dialogue is never retained here.
    const transcriptFingerprint = typeof observation.transcriptFingerprint === 'string'
      && /^[a-f0-9]{64}$/u.test(observation.transcriptFingerprint) ? observation.transcriptFingerprint : '';
    const transcriptId = typeof context.transcriptId === 'string'
      && /^[A-Za-z0-9_.:-]{1,128}$/u.test(context.transcriptId) ? context.transcriptId : '';
    const transcriptKey = transcriptFingerprint || transcriptId;
    const transcriptAllowed = settings.audioEnabled !== false && context.audioAllowed !== false && Boolean(transcriptKey);
    if (!transcriptAllowed) {
      // A delayed interpretation must still have current, authorized dialogue evidence.
      // Keep the last digest for deduplication so an expired segment cannot revive itself.
      for (const [key, event] of this.pending) if (event.trigger === 'video-dialogue') this.pending.delete(key);
    } else {
      if (transcriptKey !== this.lastTranscriptKey) {
        this.lastTranscriptKey = transcriptKey;
        this.rememberEvent({ trigger: 'video-dialogue', key: `dialogue:${appKey}:${transcriptKey}`,
          priority: 74, novelty: 0.9 }, now);
      }
    }

    if (idleSeconds < 90 && appKey && !meetingApp(`${bundleId} ${app}`)) {
      if (this.activeSince === null) this.activeSince = now;
      if (!this.prolongedReported && now - this.activeSince >= this.prolongedActivityMs) {
        this.prolongedReported = true;
        this.rememberEvent({ trigger: 'prolonged-activity', key: `activity:${this.activeSince}`, priority: 40, novelty: 0.4 }, now);
      }
    } else { this.activeSince = null; this.prolongedReported = false; }

    const current = context.agent?.current ?? context.agent;
    if (current && settings.agentProgressEnabled !== false) {
      const phase = current.phase;
      const session = clean(current.sessionId, 100);
      const generation = `${current.turn ?? ''}:${current.step ?? ''}:${phase === 'waiting-approval' ? current.approvalRevision ?? '' : ''}`;
      const key = `${session}:${generation}:${phase}`;
      if (key !== this.lastAgentKey) {
        this.lastAgentKey = key;
        const event = phase === 'waiting-approval' ? { trigger: 'agent-approval', priority: 95, urgent: true }
          : phase === 'waiting-user' ? { trigger: 'agent-question', priority: 85 }
            : phase === 'completed' ? { trigger: 'agent-completed', priority: 72 }
              : phase === 'error' ? { trigger: 'agent-error', priority: 78 } : null;
        if (event) this.rememberEvent({ ...event, key: `agent:${key}`, novelty: 1 }, now);
      }
    }
    if (context.userInteractionId !== undefined) {
      const key = clean(String(context.userInteractionId), 80);
      if (key && key !== this.lastInteractionKey) {
        this.lastInteractionKey = key;
        this.recordUserInteraction(now);
        this.rememberEvent({ trigger: 'user-interaction', key: `interaction:${key}`, priority: 80, novelty: 1 }, now);
      }
    }

    const quietMeeting = settings.quietMeetingApps !== false && meetingApp(`${bundleId} ${app}`);
    const configuredQuiet = Array.isArray(settings.quietApps) && settings.quietApps.some(value =>
      typeof value === 'string' && value && (bundleId.toLowerCase() === value.toLowerCase() || app.toLowerCase() === value.toLowerCase()));
    if (quietMeeting || configuredQuiet || context.quiet === true) {
      this.pending.clear(); return silent('quiet-context');
    }
    if (idleSeconds >= 5 * 60) { this.pending.clear(); return silent('user-away'); }
    const event = [...this.pending.values()].sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt)[0];
    if (!event) return silent('no-new-event');
    const engaged = this.lastInteraction !== null && now - this.lastInteraction < 5 * 60_000;
    const quietMs = Math.round(this.baseQuietMs * Math.min(8, 1 + this.ignoredCount * 1.5)
      / (engaged ? 1 + this.engagement * 0.4 : 1) * (event.novelty >= 0.45 ? 0.75 : 1));
    const urgentOnce = event.urgent && settings.urgentAgentAlerts === true && !this.urgentDelivered.has(event.key);
    const explicit = event.trigger === 'user-interaction';
    const last = Math.max(this.lastAnalysis ?? -Infinity, this.lastSpeech ?? -Infinity);
    if (!explicit && !urgentOnce && now - last < quietMs) {
      return { ...silent('adaptive-spacing'), quietMs };
    }
    // Low-novelty events are progressively filtered when recent reactions received no engagement.
    if (this.ignoredCount >= 2 && event.priority < 60) {
      this.pending.delete(event.key); this.seen.set(event.key, now);
      return { ...silent('recently-unengaged'), quietMs };
    }
    return { shouldAnalyze: true, trigger: event.trigger, priority: event.priority,
      reason: urgentOnce ? 'new-approval-needs-attention' : 'new-context-event', key: event.key, quietMs };
  }

  recordAnalysis(decision = {}, now = this.now()) {
    this.lastAnalysis = finite(now, this.now());
    const key = typeof decision === 'object' ? decision.key : undefined;
    if (key) {
      const event = this.pending.get(key);
      if (event?.urgent) this.urgentDelivered.add(key);
      this.pending.delete(key); this.seen.set(key, this.lastAnalysis);
    } else if (typeof decision === 'string') {
      for (const [candidate, event] of this.pending) if (event.trigger === decision) {
        this.pending.delete(candidate); this.seen.set(candidate, this.lastAnalysis);
      }
    }
    while (this.seen.size > 128) this.seen.delete(this.seen.keys().next().value);
    while (this.urgentDelivered.size > 64) this.urgentDelivered.delete(this.urgentDelivered.values().next().value);
  }

  recordSpeech(decision = {}, now = this.now()) {
    this.lastSpeech = finite(now, this.now());
    this.awaitingEngagement = this.lastSpeech;
    if (decision?.key) this.recordAnalysis(decision, this.lastSpeech);
  }

  recordUserInteraction(now = this.now()) {
    this.lastInteraction = finite(now, this.now());
    this.engagement = Math.min(3, this.engagement + 1);
    this.ignoredCount = 0; this.awaitingEngagement = null;
  }

  inspect() {
    return { observation: this.lastObservation ? { ...this.lastObservation } : null,
      pendingEvents: [...this.pending.values()].map(value => ({ ...value })),
      lastAnalysis: this.lastAnalysis, lastSpeech: this.lastSpeech, lastInteraction: this.lastInteraction,
      ignoredCount: this.ignoredCount, engagement: this.engagement };
  }
}

export const createAdaptiveEngine = options => new AdaptiveEngine(options);
