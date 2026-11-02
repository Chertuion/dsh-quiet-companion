/** Metadata-only preview policy. Screen capture is deliberately unavailable. */
export const DEFAULT_SETTINGS = Object.freeze({
  observationEnabled: false, screenEnabled: false, captureIntervalSeconds: 8,
  snoozeUntil: 0, provider: '', model: '', consentPair: '',
});

export function normalizeSettings(value = {}) {
  const cleanString = input => typeof input === 'string' ? input.slice(0, 240) : '';
  return {
    observationEnabled: value.observationEnabled === true,
    screenEnabled: false,
    captureIntervalSeconds: Math.min(60, Math.max(3, Number(value.captureIntervalSeconds) || 8)),
    snoozeUntil: Number.isFinite(value.snoozeUntil) ? Math.max(0, value.snoozeUntil) : 0,
    provider: cleanString(value.provider), model: cleanString(value.model), consentPair: '',
  };
}

export function observationsAllowed(settings, now = Date.now()) {
  return settings.observationEnabled && settings.snoozeUntil <= now
    && Boolean(settings.provider && settings.model);
}

/** Copy an explicit metadata whitelist. Raw pixels, titles and unknown fields are dropped. */
export function metadataOnly(input = {}) {
  const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/gu, '').slice(0, 160) : '';
  const stamp = typeof input.timestamp === 'number' ? input.timestamp : Date.now();
  return {
    app: clean(input.app), bundleId: clean(input.bundleId),
    idleSeconds: Number.isFinite(input.idleSeconds) ? Math.max(0, Math.round(input.idleSeconds)) : 0,
    timestamp: new Date(Number.isFinite(stamp) && Math.abs(stamp) < 8.64e15 ? stamp : Date.now()).toISOString(),
  };
}

export function shouldAnalyze({ settings, observation, previousApp, lastAnalysis, lastSpeech, now = Date.now() }) {
  if (!observationsAllowed(settings, now) || now - lastAnalysis < 45_000 || now - lastSpeech < 90_000) return false;
  return observation.app !== previousApp || observation.idleSeconds >= 120 || now - lastAnalysis >= 180_000;
}
