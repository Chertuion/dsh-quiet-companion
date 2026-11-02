/** Consent and bounded settings shared by native sensing and model orchestration. */
export const DEFAULT_SETTINGS = Object.freeze({
  observationEnabled: false, screenEnabled: false, captureIntervalSeconds: 3,
  snoozeUntil: 0, provider: '', model: '', consentPair: '', useDefaultModel: true,
  videoAudioEnabled: false, audioConsentPair: '', speechLanguage: 'zh-CN', voiceEnabled: false,
  voiceIdentifier: '', voiceRate: 0.48, lipSyncEnabled:true, memoryEnabled: true, agentProgressEnabled: true,
  reduceMotion: false, dynamicSkinEnabled: true, quietMeetingApps: true,
  quietApps: [], urgentAgentAlerts: true, dailyTokenBudget: 100000,
  dailyBudget: 0, inputPricePerMillion: 0, outputPricePerMillion: 0,
  mousePlayEnabled: false, mousePlayAfterMinutes: 20,
  growthEnabled:true,snackRewardsEnabled:true,autoEatEnabled:true,tokensPerSnack:2000,growthPanelVisible:false,
});

export function normalizeSettings(value = {}) {
  const cleanString = input => typeof input === 'string' ? input.slice(0, 240) : '';
  const number = (input, fallback, low, high) => Number.isFinite(Number(input))
    ? Math.min(high, Math.max(low, Number(input))) : fallback;
  const provider = cleanString(value.provider), model = cleanString(value.model);
  const pair = provider + '\u001f' + model;
  const consentPair = cleanString(value.consentPair);
  return {
    observationEnabled: value.observationEnabled === true,
    screenEnabled: value.screenEnabled === true && Boolean(provider && model) && consentPair === pair,
    captureIntervalSeconds: number(value.captureIntervalSeconds, 3, 1, 30),
    snoozeUntil: Number.isFinite(value.snoozeUntil) ? Math.max(0, value.snoozeUntil) : 0,
    provider, model, consentPair: consentPair === pair ? pair : '', useDefaultModel: true,
    videoAudioEnabled: value.videoAudioEnabled === true && cleanString(value.audioConsentPair) === pair,
    audioConsentPair: cleanString(value.audioConsentPair) === pair ? pair : '',
    speechLanguage: ['zh-CN','en-US'].includes(value.speechLanguage) ? value.speechLanguage : 'zh-CN',
    voiceEnabled: value.voiceEnabled === true, voiceIdentifier: cleanString(value.voiceIdentifier),
    voiceRate: number(value.voiceRate, 0.48, 0.3, 0.65), lipSyncEnabled:value.lipSyncEnabled!==false,
    memoryEnabled: value.memoryEnabled !== false, agentProgressEnabled: value.agentProgressEnabled !== false,
    reduceMotion: value.reduceMotion === true, dynamicSkinEnabled: value.dynamicSkinEnabled !== false,
    quietMeetingApps: value.quietMeetingApps !== false,
    quietApps: Array.isArray(value.quietApps) ? value.quietApps.filter(x => typeof x === 'string').slice(0,30).map(cleanString) : [],
    urgentAgentAlerts: value.urgentAgentAlerts !== false,
    dailyTokenBudget: number(value.dailyTokenBudget,100000,0,10_000_000),
    dailyBudget: number(value.dailyBudget,0,0,100000),
    inputPricePerMillion: number(value.inputPricePerMillion,0,0,100000),
    outputPricePerMillion: number(value.outputPricePerMillion,0,0,100000),
    mousePlayEnabled: value.mousePlayEnabled === true,
    mousePlayAfterMinutes: number(value.mousePlayAfterMinutes,20,5,120),
    growthEnabled:value.growthEnabled!==false,snackRewardsEnabled:value.snackRewardsEnabled!==false,
    autoEatEnabled:value.autoEatEnabled!==false,tokensPerSnack:Math.round(number(value.tokensPerSnack,2000,100,100000)),
    growthPanelVisible:value.growthPanelVisible===true,
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

export function screenAllowed(settings, route, now = Date.now()) {
  return observationsAllowed(settings, now) && settings.screenEnabled === true
    && route?.vision === true && route.provider === settings.provider && route.model === settings.model
    && settings.consentPair === route.provider + '\u001f' + route.model;
}
