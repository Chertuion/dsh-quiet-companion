'use strict';

// Messages come from local codes, never raw provider errors, RPC details or credentials.
const BRIDGE_ERRORS = Object.freeze({
  forbidden: '只有此 Harness 的所有者可以管理陪伴设置。',
  'explicit-consent-required': '请使用对应的授权开关开启此功能。',
  'helper-unavailable': '宠物尚未运行，请先重新启动宠物。',
  'helper-disconnected': '宠物连接已关闭，请重新启动宠物后重试。',
  'vision-unavailable': '当前 Harness 默认模型不支持图片，暂时无法开启画面理解。',
  'model-required': '请先在 Harness 中配置默认模型。',
  'permission-in-progress': '正在等待原生授权，请在原生提示中继续或取消。',
  'mouse-test-unavailable': '请先开启应用感知与指针互动，并确认辅助功能已授权。',
  'mouse-test-busy': '请等当前授权或指针动作结束后再试。',
  'mouse-test-in-progress': '请求已发送，请等待本次反馈后再试。',
});

/** React-free, registration-owned settings bridge. Polls only while this settings page is mounted. */
class CompanionSettingsController {
  constructor(connection, { intervalMs = 2000, timers = globalThis } = {}) {
    this.connection = connection;
    this.intervalMs = intervalMs;
    this.timers = timers;
    this.listeners = new Set();
    this.state = { status: 'idle', snapshot: null, busy: false, operation: '', error: '', errorType: '' };
    this.active = 0;
    this.disposed = false;
    this.read = null;
    this.timer = null;
    this.stopVisibility = null;
    this.controllers = new Set();
    this.revision = 0;
    this.store = {
      getSnapshot: () => this.state,
      subscribe: listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    };
  }
  publish(patch) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* One UI observer cannot block another. */ } }
  }
  async call(endpoint, payload, controller) {
    const result = await this.connection.rpc.call('/api', `quiet-companion/${endpoint}`, payload, controller.signal);
    if (!result || result.ok !== true || !result.value || typeof result.value !== 'object') {
      const error = new Error('bridge-request-failed');
      error.userMessage = BRIDGE_ERRORS[result?.error?.code] || '';
      throw error;
    }
    return result.value.snapshot && typeof result.value.snapshot === 'object' ? result.value.snapshot : result.value;
  }
  load() {
    if (this.disposed || this.state.busy) return Promise.resolve();
    if (this.read) return this.read;
    const controller = new AbortController();
    const revision = this.revision;
    this.controllers.add(controller);
    if (!this.state.snapshot) this.publish({ status: 'loading',
      ...(this.state.errorType === 'operation' ? {} : { error: '', errorType: '' }) });
    const work = this.call('snapshot', {}, controller).then(snapshot => {
      if (!controller.signal.aborted && revision === this.revision) this.publish({ snapshot, status: 'ready',
        ...(this.state.errorType === 'connection' ? { error: '', errorType: '' } : {}) });
    }).catch(() => {
      if (!controller.signal.aborted && revision === this.revision) this.publish({ status: 'error', errorType: 'connection', error: '暂时无法读取陪伴设置。请检查 Harness 连接后重试。' });
    }).finally(() => {
      this.controllers.delete(controller);
      if (this.read === work) this.read = null;
    });
    this.read = work;
    return work;
  }
  async mutate(endpoint, payload, operation) {
    if (this.disposed || this.state.busy) return false;
    this.revision++;
    for (const controller of this.controllers) controller.abort();
    this.read = null;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.publish({ busy: true, operation, error: '', errorType: '' });
    try {
      const snapshot = await this.call(endpoint, payload, controller);
      if (controller.signal.aborted || this.disposed) return false;
      this.publish({ snapshot, status: 'ready', error: '', errorType: '' });
      return true;
    } catch (error) {
      if (!controller.signal.aborted) this.publish({ errorType: 'operation',
        error: Object.values(BRIDGE_ERRORS).includes(error?.userMessage) ? error.userMessage
          : '这次操作未完成，请重试；权限操作请检查原生提示或 macOS 系统设置。' });
      return false;
    } finally {
      this.controllers.delete(controller);
      if (!this.disposed) this.publish({ busy: false, operation: '' });
    }
  }
  update(patch) { return this.mutate('update-settings', { patch }, 'save-settings'); }
  action(action, payload = {}) { return this.mutate('action', { ...payload, action }, action); }
  retry() { this.publish({ error: '', errorType: '' }); return this.load(); }
  open() {
    if (this.disposed) return () => {};
    this.active++;
    if (this.active === 1) {
      const page = typeof document === 'undefined' ? null : document;
      const loadVisible = () => {
        if (!this.disposed && this.active > 0 && page?.visibilityState !== 'hidden') void this.load();
      };
      if (typeof page?.addEventListener === 'function' && typeof page?.removeEventListener === 'function') {
        page.addEventListener('visibilitychange', loadVisible);
        this.stopVisibility = () => page.removeEventListener('visibilitychange', loadVisible);
      }
      loadVisible();
      this.timer = this.timers.setInterval(loadVisible, this.intervalMs);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      if (this.active === 0) {
        if (this.timer !== null) this.timers.clearInterval(this.timer);
        this.timer = null;
        this.stopVisibility?.();
        this.stopVisibility = null;
        // Reads are disposable; an explicit save already requested by the user may complete.
        if (this.read && !this.state.busy) {
          for (const controller of this.controllers) controller.abort();
          this.read = null;
          this.revision++;
        }
      }
    };
  }
  dispose() {
    this.disposed = true;
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.stopVisibility?.();
    this.stopVisibility = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.listeners.clear();
  }
}
module.exports = { CompanionSettingsController };
