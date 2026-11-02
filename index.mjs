import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { listModels, generateComment } from './lib/model.mjs';
import { DEFAULT_SETTINGS, normalizeSettings, observationsAllowed, metadataOnly, shouldAnalyze } from './lib/controller.mjs';

export const name = 'quiet-companion';

/** A native companion owned by the current DSH plugin lifecycle. */
export function apply(ctx) {
  ctx.effect(() => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      console.warn('[quiet-companion] 此预览包仅支持 Apple Silicon macOS。');
      return () => {};
    }
    const root = dirname(fileURLToPath(import.meta.url));
    const executable = join(root, 'native/QuietCompanion.app/Contents/MacOS/QuietCompanion');
    if (!existsSync(executable)) throw new Error('quiet-companion: 安装包缺少原生程序，请重新安装完整 tgz。');
    const stateDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'quiet-companion');
    const settingsFile = join(stateDir, 'settings.json');
    let settings = { ...DEFAULT_SETTINGS };
    try {
      if (existsSync(settingsFile)) settings = normalizeSettings(JSON.parse(readFileSync(settingsFile, 'utf8')));
    } catch { console.warn('[quiet-companion] 设置不可读，已使用默认暂停状态。'); }
    let disposed = false;
    let models = [];
    let history = [];
    let latest = null;
    let lastAnalysis = 0;
    let lastSpeech = 0;
    let previousApp = '';
    let inFlight = null;
    let modelRefresh = null;
    const pendingRequests = new Set();
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    const send = message => {
      if (disposed || child.stdin.destroyed || !child.stdin.writable) return;
      try { child.stdin.write(JSON.stringify(message) + '\n'); } catch { /* Child exit is handled below. */ }
    };
    const status = text => send({ type: 'status', text });
    const getLLM = () => {
      try { return typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm; }
      catch { return null; }
    };
    function saveSettings() {
      try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const staging = settingsFile + '.tmp';
        writeFileSync(staging, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
        renameSync(staging, settingsFile);
      } catch { status('设置暂未保存；本次仍可使用。'); }
    }
    function cancelRequest() {
      inFlight?.abort();
      inFlight = null;
    }
    function synchronizeSettings() { send({ type: 'settings', settings }); }
    async function refreshModels() {
      if (modelRefresh) return modelRefresh;
      modelRefresh = (async () => {
        const llm = getLLM();
        models = await listModels(llm);
        if (disposed) return;
        // The preview transport is text-only, even when a provider advertises vision.
        send({ type: 'models', models: models.map(item => ({ ...item, vision: false })) });
        synchronizeSettings();
        status(models.length ? '文字陪伴可用。先选择模型，再开启应用感知；屏幕／视频理解尚未接通。'
          : '请先在 Harness 中配置模型，再打开陪伴设置刷新。离线摸头和拖拽仍可使用。');
      })().finally(() => { modelRefresh = null; });
      return modelRefresh;
    }
    async function react(userText = '') {
      if (disposed || inFlight) return;
      const manual = Boolean(userText);
      if (!manual && !observationsAllowed(settings)) return;
      const route = models.find(item => item.provider === settings.provider && item.model === settings.model);
      if (!route) {
        if (manual) send({ type: 'speech', mood: 'idle', text: '先在“陪伴设置”里选一个已配置的模型，再和我说话吧。' });
        return;
      }
      const controller = new AbortController();
      inFlight = controller;
      const snapshot = { ...settings };
      lastAnalysis = Date.now();
      const observation = observationsAllowed(settings) && latest ? { ...latest } : {
        app: '应用观察已暂停', bundleId: '', idleSeconds: 0, timestamp: new Date().toISOString(),
      };
      if (manual) status('正在等她回答……');
      try {
        const reply = await generateComment(getLLM(), {
          provider: route.provider, model: route.model, observation,
          history, userText, signal: controller.signal,
        });
        if (disposed || controller.signal.aborted
            || snapshot.provider !== settings.provider || snapshot.model !== settings.model) return;
        if (!manual && !observationsAllowed(settings)) return;
        if (reply.shouldSpeak) {
          if (manual) history.push({ role: 'user', text: userText.slice(0, 1200) });
          history.push({ role: 'assistant', text: reply.text });
          history = history.slice(-8);
          lastSpeech = Date.now();
          send({ type: 'speech', text: reply.text, mood: reply.mood });
        } else if (manual) {
          send({ type: 'speech', mood: 'idle', text: '这次没有收到可用的模型回应。可以检查模型配置后再试一下。' });
        }
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    }
    function requestReaction(userText = '') {
      const task = react(userText).catch(() => status('本次请求未完成，请检查模型设置。'));
      pendingRequests.add(task);
      void task.finally(() => pendingRequests.delete(task));
    }
    function handle(message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready' || message.type === 'request-models') {
        void refreshModels().catch(() => status('模型列表暂不可用，请稍后重新打开设置。'));
      } else if (message.type === 'settings') {
        const next = normalizeSettings({ ...settings, ...message });
        cancelRequest();
        settings = next;
        latest = null;
        previousApp = '';
        saveSettings();
        synchronizeSettings();
      } else if (message.type === 'observation') {
        if (!observationsAllowed(settings)) return;
        // Never retain or pass a screenshot, window title, URL, or other unknown property.
        const observation = metadataOnly(message);
        latest = observation;
        if (shouldAnalyze({ settings, observation, previousApp, lastAnalysis, lastSpeech })) {
          requestReaction();
        }
        previousApp = observation.app;
      } else if (message.type === 'chat' && typeof message.text === 'string') {
        const userText = message.text.trim().slice(0, 1200);
        if (userText) {
          cancelRequest();
          requestReaction(userText);
        }
      } else if (message.type === 'quit') {
        cancelRequest();
      }
    }
    lines.on('line', line => {
      if (disposed || line.length > 128_000) return;
      try { handle(JSON.parse(line)); } catch { /* Invalid IPC is ignored; never print private payloads. */ }
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => { /* Native system diagnostics may contain private paths; do not copy into DSH logs. */ });
    child.on('error', () => console.warn('[quiet-companion] 无法启动原生宠物，请检查安装包。'));
    child.on('exit', () => { cancelRequest(); lines.close(); });
    return async () => {
      disposed = true;
      cancelRequest();
      history = [];
      latest = null;
      try {
        if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write('{"type":"shutdown"}\n');
      } catch { /* The owned helper may already be exiting. */ }
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        const term = setTimeout(() => { child.kill('SIGTERM'); }, 2_000);
        const kill = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
        let deadline;
        const stopped = await Promise.race([
          exited.then(() => true),
          new Promise(resolve => { deadline = setTimeout(() => resolve(false), 7_000); }),
        ]);
        clearTimeout(term);
        clearTimeout(kill);
        clearTimeout(deadline);
        if (!stopped) throw new Error('quiet-companion: 原生进程尚未退出，请先关闭旧宠物再重新启用。');
      }
      lines.close();
      await Promise.allSettled([...pendingRequests, ...(modelRefresh ? [modelRefresh] : [])]);
    };
  });
}
