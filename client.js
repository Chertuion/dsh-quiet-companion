/* Built by client/build.mjs. Shared module identities come from the Harness module table. */
window.__ModuleLoader__.load({id:"dsh-quiet-companion",factory(require){
const module={exports:{}};const exports=module.exports;
'use strict';
const React = require('react');
const { Button, Switch } = require('@deepseek-ai/dsh-client-ui-primitives');
const { CompanionSettingsController } = (function(){const module={exports:{}};const exports=module.exports;
'use strict';

/** React-free, registration-owned settings bridge. Polls only while this settings page is mounted. */
class CompanionSettingsController {
  constructor(connection, { intervalMs = 2000, timers = globalThis } = {}) {
    this.connection = connection;
    this.intervalMs = intervalMs;
    this.timers = timers;
    this.listeners = new Set();
    this.state = { status: 'idle', snapshot: null, busy: false, operation: '', error: '' };
    this.active = 0;
    this.disposed = false;
    this.read = null;
    this.timer = null;
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
    if (!result || result.ok !== true || !result.value || typeof result.value !== 'object') throw new Error('bridge-request-failed');
    return result.value.snapshot && typeof result.value.snapshot === 'object' ? result.value.snapshot : result.value;
  }
  load() {
    if (this.disposed || this.state.busy) return Promise.resolve();
    if (this.read) return this.read;
    const controller = new AbortController();
    const revision = this.revision;
    this.controllers.add(controller);
    if (!this.state.snapshot) this.publish({ status: 'loading', error: '' });
    const work = this.call('snapshot', {}, controller).then(snapshot => {
      if (!controller.signal.aborted && revision === this.revision) this.publish({ snapshot, status: 'ready', error: '' });
    }).catch(() => {
      if (!controller.signal.aborted && revision === this.revision) this.publish({ status: 'error', error: '暂时无法读取陪伴设置。请检查 Harness 连接后重试。' });
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
    this.publish({ busy: true, operation, error: '' });
    try {
      const snapshot = await this.call(endpoint, payload, controller);
      if (controller.signal.aborted || this.disposed) return false;
      this.publish({ snapshot, status: 'ready', error: '' });
      return true;
    } catch {
      if (!controller.signal.aborted) this.publish({ error: '这次设置没有保存成功，请重试。权限操作也可以在 macOS 系统设置中检查。' });
      return false;
    } finally {
      this.controllers.delete(controller);
      if (!this.disposed) this.publish({ busy: false, operation: '' });
    }
  }
  update(patch) { return this.mutate('update-settings', { patch }, 'save-settings'); }
  action(action, payload = {}) { return this.mutate('action', { ...payload, action }, action); }
  open() {
    if (this.disposed) return () => {};
    this.active++;
    if (this.active === 1) {
      void this.load();
      this.timer = this.timers.setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void this.load();
      }, this.intervalMs);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      if (this.active === 0) {
        if (this.timer !== null) this.timers.clearInterval(this.timer);
        this.timer = null;
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
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.listeners.clear();
  }
}
module.exports = { CompanionSettingsController };

return module.exports;})();
const STYLE_TEXT = ".qcp-settings { color: var(--dsw-alias-label-primary, CanvasText); display: flex; flex-direction: column; gap: 16px; min-width: 0; width: 100%; font-size: 14px; line-height: 1.55; }\n.qcp-settings *, .qcp-settings *::before, .qcp-settings *::after { box-sizing: border-box; }\n.qcp-settings h2, .qcp-settings h3, .qcp-settings p { margin: 0; }\n.qcp-settings h2 { font-size: 17px; font-weight: 600; line-height: 26px; }\n.qcp-settings h3 { font-size: 14px; font-weight: 600; }\n.qcp-intro, .qcp-muted { color: var(--dsw-alias-label-tertiary, GrayText); font-size: 12px; line-height: 1.6; }\n.qcp-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }\n.qcp-title-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }\n.qcp-heading-badge, .qcp-tag { border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3)); border-radius: 6px; font-size: 11px; line-height: 18px; padding: 1px 6px; color: var(--dsw-alias-label-secondary, CanvasText); white-space: nowrap; }\n.qcp-model { background: var(--dsw-alias-settings-card-fill, Canvas); border: .5px solid var(--dsw-alias-settings-card-stroke, rgba(127,127,127,.3)); border-radius: var(--dsw-radius-xl, 12px); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }\n.qcp-model-head { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }\n.qcp-model-name { font-weight: 500; overflow-wrap: anywhere; }\n.qcp-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }\n.qcp-status { font-size: 12px; color: var(--dsw-alias-label-secondary, CanvasText); overflow-wrap: anywhere; }\n.qcp-error { color: var(--dsw-alias-state-error-primary, #b44747); background: var(--dsw-alias-settings-card-fill, Canvas); padding: 10px 12px; border: .5px solid currentColor; border-radius: 9px; font-size: 12px; }\n.qcp-tabs { display: flex; gap: 3px; flex-wrap: wrap; border-bottom: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3)); padding-bottom: 8px; }\n.qcp-tab { appearance: none; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, CanvasText); font: inherit; font-size: 12px; padding: 7px 10px; cursor: pointer; }\n.qcp-tab:hover { background: var(--dsw-alias-settings-card-fill, rgba(127,127,127,.08)); }\n.qcp-tab[aria-selected=true] { background: var(--dsw-alias-settings-card-fill, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, CanvasText); font-weight: 600; }\n.qcp-tab:focus-visible, .qcp-input:focus-visible, .qcp-select:focus-visible, .qcp-textarea:focus-visible { outline: 2px solid var(--dsw-alias-focus-ring, Highlight); outline-offset: 2px; }\n.qcp-panel { display: flex; flex-direction: column; gap: 14px; min-width: 0; }\n.qcp-card { background: var(--dsw-alias-settings-card-fill, Canvas); border: .5px solid var(--dsw-alias-settings-card-stroke, rgba(127,127,127,.3)); border-radius: var(--dsw-radius-xl, 12px); padding: 0 14px; min-width: 0; }\n.qcp-card-heading { padding: 13px 0 2px; }\n.qcp-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 61px; padding: 12px 0; }\n.qcp-row + .qcp-row { border-top: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.2)); }\n.qcp-row-copy { flex: 1; min-width: 0; }\n.qcp-row-label { font-size: 13px; font-weight: 500; }\n.qcp-row-desc { color: var(--dsw-alias-label-tertiary, GrayText); font-size: 12px; line-height: 1.6; margin-top: 3px; }\n.qcp-row-control { flex: none; max-width: 52%; }\n.qcp-input, .qcp-select, .qcp-textarea { background: var(--dsw-alias-settings-card-fill, Canvas); color: var(--dsw-alias-label-primary, CanvasText); border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.4)); border-radius: 8px; font: inherit; font-size: 12px; padding: 7px 9px; min-height: 32px; width: 100%; }\n.qcp-input[type=number] { width: 105px; text-align: right; }\n.qcp-select { max-width: 220px; }\n.qcp-input:disabled, .qcp-select:disabled, .qcp-textarea:disabled { opacity: .5; cursor: not-allowed; }\n.qcp-field { display: flex; flex-direction: column; gap: 6px; }\n.qcp-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary, CanvasText); }\n.qcp-textarea { resize: vertical; min-height: 120px; line-height: 1.7; }\n.qcp-small-textarea { min-height: 62px; }\n.qcp-form-row { padding: 12px 0; display: flex; flex-direction: column; gap: 8px; }\n.qcp-form-row + .qcp-form-row, .qcp-card > .qcp-form-row + .qcp-row { border-top: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.2)); }\n.qcp-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }\n.qcp-range { display: flex; gap: 9px; align-items: center; min-width: 145px; }\n.qcp-range input { width: 118px; max-width: 100%; accent-color: var(--dsw-alias-label-primary, Highlight); }\n.qcp-range output { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, CanvasText); min-width: 36px; text-align: right; }\n.qcp-note { color: var(--dsw-alias-label-tertiary, GrayText); font-size: 12px; line-height: 1.7; }\n.qcp-memory-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }\n.qcp-memory-list { display: flex; flex-direction: column; gap: 8px; max-height: 280px; overflow: auto; overscroll-behavior: contain; }\n.qcp-memory-item { border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.25)); border-radius: 9px; padding: 10px 11px; display: flex; flex-direction: column; gap: 7px; }\n.qcp-memory-copy { font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }\n.qcp-memory-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-tertiary, GrayText); }\n.qcp-memory-meta code { user-select: all; font-size: 10px; overflow-wrap: anywhere; }\n.qcp-memory-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }\n.qcp-confirm { padding: 12px; border: .5px solid var(--dsw-alias-state-warn-label, #a47b36); border-radius: 9px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }\n.qcp-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin: 0; }\n.qcp-metric { border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.25)); border-radius: 9px; padding: 9px 11px; }\n.qcp-metric dt { color: var(--dsw-alias-label-tertiary, GrayText); font-size: 11px; }\n.qcp-metric dd { font-variant-numeric: tabular-nums; font-size: 16px; margin: 4px 0 0; }\n.qcp-agent-summary { border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.25)); border-radius: 9px; padding: 10px 11px; font-size: 12px; overflow-wrap: anywhere; }\n.qcp-growth-gauge { display: flex; flex-direction: column; gap: 6px; min-width: 0; }\n.qcp-growth-meter { display: block; width: 100%; height: 10px; accent-color: var(--dsw-alias-label-secondary, Highlight); }\n.qcp-empty { color: var(--dsw-alias-label-tertiary, GrayText); padding: 14px 0; font-size: 12px; }\n@media (max-width: 600px) { .qcp-row { gap: 10px; } .qcp-row-control { max-width: 46%; } .qcp-range { min-width: 100px; } .qcp-range input { width: 80px; } .qcp-select { max-width: 170px; } }\n@media (prefers-reduced-motion: reduce) { .qcp-settings *, .qcp-settings *::before, .qcp-settings *::after { scroll-behavior: auto !important; } }\n";
const h = React.createElement;
const { useEffect, useId, useState } = React;

function button(label, onClick, disabled = false, variant = 'outline', extra = {}) {
  return h(Button, { size: 'sm', variant, disabled, onClick, ...extra }, label);
}
function Row({ label, description, children }) {
  return h('div', { className: 'qcp-row' },
    h('div', { className: 'qcp-row-copy' }, h('div', { className: 'qcp-row-label' }, label),
      description ? h('div', { className: 'qcp-row-desc' }, description) : null),
    h('div', { className: 'qcp-row-control' }, children));
}
function ToggleRow({ label, description, checked, disabled, onChange, title }) {
  return h(Row, { label, description }, h(Switch, { label, checked: checked === true, disabled, onChange, title }));
}
function Card({ title, children }) {
  return h('section', { className: 'qcp-card' }, title ? h('div', { className: 'qcp-card-heading' }, h('h3', null, title)) : null, children);
}
function NumberField({ label, value, min = 0, max, step = 1, disabled, onCommit, unit }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value ?? 0));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(String(value ?? 0)); }, [value, focused]);
  const commit = event => {
    setFocused(false);
    const raw = event.currentTarget.value.trim();
    if (!raw || !Number.isFinite(Number(raw))) { setDraft(String(value ?? 0)); return; }
    const next = Math.min(max ?? Infinity, Math.max(min, Number(raw)));
    setDraft(String(next));
    if (next !== Number(value)) void onCommit(next);
  };
  return h('div', { className: 'qcp-field' },
    h('label', { htmlFor: id, className: 'qcp-field-label' }, label),
    h('div', { className: 'qcp-actions' }, h('input', {
      id, className: 'qcp-input', type: 'number', min, max, step, value: draft, disabled,
      onFocus: () => setFocused(true), onChange: event => setDraft(event.currentTarget.value), onBlur: commit,
      onKeyDown: event => { if (event.key === 'Enter') event.currentTarget.blur(); },
    }), unit ? h('span', { className: 'qcp-muted' }, unit) : null));
}
function RangeField({ label, value, min, max, step, disabled, onCommit, format = value => String(value) }) {
  const [draft, setDraft] = useState(Number.isFinite(Number(value)) ? Number(value) : min);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(Number.isFinite(Number(value)) ? Number(value) : min); }, [value, min, editing]);
  const commit = event => {
    const next = Number(event.currentTarget.value);
    setEditing(false);
    if (Number.isFinite(next) && next !== Number(value)) void onCommit(next);
  };
  return h('div', { className: 'qcp-range' },
    h('input', { type: 'range', 'aria-label': label, min, max, step, value: draft, disabled,
      onPointerDown: () => setEditing(true), onChange: event => { setEditing(true); setDraft(Number(event.currentTarget.value)); },
      onPointerUp: commit, onBlur: commit, onKeyUp: event => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) commit(event); },
    }), h('output', null, format(draft)));
}
function TextListField({ value, disabled, onCommit }) {
  const id = useId();
  const [draft, setDraft] = useState((value ?? []).join('\n'));
  const [focused, setFocused] = useState(false);
  const stable = (value ?? []).join('\n');
  useEffect(() => { if (!focused) setDraft(stable); }, [stable, focused]);
  return h('div', { className: 'qcp-form-row' },
    h('label', { htmlFor: id, className: 'qcp-field-label' }, '额外安静应用'),
    h('textarea', { id, className: 'qcp-textarea qcp-small-textarea', value: draft, disabled,
      placeholder: '每行一个应用名称或 bundle ID', onFocus: () => setFocused(true),
      onChange: event => setDraft(event.currentTarget.value), onBlur: () => {
        setFocused(false);
        const next = [...new Set(draft.split(/[\n,，]/u).map(item => item.trim()).filter(Boolean))].slice(0,30);
        if (next.join('\n') !== stable) void onCommit(next);
      },
    }), h('p', { className: 'qcp-muted' }, '使用这些应用时减少主动发言；你仍可以主动与她交流。'));
}
function helperRunning(snapshot) {
  return snapshot.helper === true || snapshot.helper?.running === true || snapshot.helper?.alive === true;
}
const count = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未知';
const factsOf = snapshot => Array.isArray(snapshot.memory?.facts) ? snapshot.memory.facts : [];
const PHASE_LABELS = Object.freeze({idle:'空闲',thinking:'思考中',working:'执行中',running:'进行中',replying:'回复中',
  tool:'执行工具中',waiting:'等待中',approval:'等待确认','waiting-approval':'等待审批','waiting-user':'等待回答',
  success:'已完成',completed:'已完成',cancelled:'已取消',interrupted:'已中断',blocked:'等待处理',error:'出现问题',failed:'出现问题'});
const factualCount = value => Number.isSafeInteger(value) && value >= 0;
const phaseLabel = phase => typeof phase==='string' ? (PHASE_LABELS[phase.toLowerCase()] ?? phase) : '进行中';

function MemorySection({ snapshot, controller, disabled }) {
  const memory = snapshot.memory ?? {};
  const [draft, setDraft] = useState(memory.factsText ?? '');
  const [dirty, setDirty] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [forget, setForget] = useState('');
  const id = useId();
  useEffect(() => { if (!dirty) setDraft(memory.factsText ?? ''); }, [memory.factsText, dirty]);
  const save = async () => {
    if (await controller.action('memory-save', { text: draft })) setDirty(false);
  };
  const remove = async value => {
    if (value && await controller.action('memory-forget', { text: value })) setForget('');
  };
  return h(React.Fragment, null,
    h(Card, { title: '跨启动记忆' },
      h(ToggleRow, { label: '使用记忆', checked: snapshot.settings?.memoryEnabled, disabled,
        description: '开启后记住允许保留的文字对话、明确偏好与约定。关闭后不再新增或用于模型回应，已有记录仍可查看和清除。',
        onChange: next => controller.update({ memoryEnabled: next }) }),
      h('div', { className: 'qcp-form-row' },
        h('p', { className: 'qcp-note' }, `本机记录：${count(memory.counts?.facts)} 条事实 · ${count(memory.counts?.pinned)} 条置顶 · ${count(memory.counts?.episodes)} 个近期文字回合。`),
        h('p', { className: 'qcp-muted' }, '模型只整理有用户原文证据的事实。画面和系统声音不会直接写入长期记忆。'))),
    h(Card, { title: '手动置顶的事实' }, h('div', { className: 'qcp-form-row' },
      h('label', { htmlFor: id, className: 'qcp-field-label' }, '每行一条，例如希望她记住的称呼、偏好或约定'),
      h('textarea', { id, className: 'qcp-textarea', rows: 5, maxLength: 16000, value: draft, disabled,
        onChange: event => { setDraft(event.currentTarget.value); setDirty(true); } }),
      h('div', { className: 'qcp-actions' }, button(dirty ? '保存置顶事实' : '已与本机同步', save, disabled || !dirty, 'primary'),
        dirty ? button('撤销编辑', () => { setDraft(memory.factsText ?? ''); setDirty(false); }, disabled, 'ghost') : null),
      h('p', { className: 'qcp-muted' }, '这里替换手动置顶内容；模型整理的事实保留在下面，可单独遗忘。'))),
    h(Card, { title: '查看和遗忘' }, h('div', { className: 'qcp-form-row' },
      h('div', { className: 'qcp-memory-toolbar' }, h('span', { className: 'qcp-muted' }, '全部事实与来源'), button('刷新记忆', () => controller.load(), disabled)),
      factsOf(snapshot).length ? h('div', { className: 'qcp-memory-list' }, factsOf(snapshot).map(fact => h('article', { className: 'qcp-memory-item', key: fact.id },
        h('div', { className: 'qcp-memory-copy' }, fact.text),
        h('div', { className: 'qcp-memory-footer' }, h('div', { className: 'qcp-memory-meta' },
          h('span', { className: 'qcp-tag' }, fact.pinned ? '手动置顶' : ({ preference:'偏好',agreement:'约定',event:'共同经历',profile:'资料',fact:'事实' }[fact.kind] ?? '事实')),
          h('span', null, fact.source === 'user-chat' ? '对话证据' : '用户编辑'), fact.slot ? h('code', null, fact.slot) : null),
          button('遗忘', () => remove(fact.id), disabled, 'ghost')),
        h('details', { className: 'qcp-memory-meta' }, h('summary', null, '条目与来源'),
          h('code', null, fact.id), fact.provenance?.quote ? h('p', null, `用户原文：${fact.provenance.quote}`) : null)))) : h('p', { className: 'qcp-empty' }, '还没有保存的事实。'),
      h('label', { className: 'qcp-field-label', htmlFor: `${id}-forget` }, '按条目 ID、主题键或完整事实遗忘'),
      h('div', { className: 'qcp-actions' }, h('input', { id: `${id}-forget`, className: 'qcp-input', style: { flex:1, minWidth:120 }, value: forget, disabled,
        onChange: event => setForget(event.currentTarget.value), onKeyDown: event => { if(event.key==='Enter') { event.preventDefault(); void remove(forget.trim()); } } }),
        button('遗忘匹配项', () => remove(forget.trim()), disabled || !forget.trim())),
      h('p', { className: 'qcp-muted' }, '遗忘会删除匹配事实及其来源文字回合，并取消旧的整理任务。'))),
    confirmClear ? h('div', { className: 'qcp-confirm', role: 'alertdialog', 'aria-label': '确认清空陪伴记忆' },
      h('strong', null, '清空全部陪伴记忆？'), h('p', null, '将删除本插件保存的事实和文字回合。Harness 的共享图片附件另由宿主管理。'),
      h('div', { className: 'qcp-actions' }, button('确认清空', async () => { if(await controller.action('memory-clear')) { setDraft(''); setDirty(false); setConfirmClear(false); } }, disabled, 'primary'),
        button('取消', () => setConfirmClear(false), disabled)))
      : h('div', { className: 'qcp-actions' }, button('清空全部陪伴记忆', () => setConfirmClear(true), disabled, 'ghost')));
}

function CompanionSection({ snapshot, controller, disabled }) {
  const settings = snapshot.settings ?? {};
  const native = snapshot.native ?? {};
  const vision = snapshot.capabilities?.vision ?? snapshot.route?.vision;
  const helper = helperRunning(snapshot);
  return h(React.Fragment, null,
    h(Card, { title: '感知与陪伴' },
      h(ToggleRow, { label: '应用感知', checked: settings.observationEnabled, disabled,
        description: '留意前台应用与空闲状态。关闭或暂停后停止采集，你仍可以主动聊天。', onChange: next => controller.update({ observationEnabled: next }) }),
      h(ToggleRow, { label: '画面理解', checked: settings.screenEnabled, disabled: disabled || !helper || !vision,
        title: !vision ? '当前 Harness 默认模型未声明支持图片' : !helper ? '请先启动原生宠物' : undefined,
        description: !vision ? '当前默认模型不支持图片；文字陪伴仍可使用。' : '开启时由原生宠物确认并申请屏幕录制权限。更换默认模型后需重新同意。',
        onChange: next => next ? controller.action('request-screen-permission') : controller.update({ screenEnabled: false }) }),
      h('div', { className: 'qcp-form-row' }, h('div', { className: 'qcp-grid' },
        h(NumberField, { label: '画面采样间隔', value: settings.captureIntervalSeconds ?? 3, min: 1, max: 30, step: 1, unit: '秒', disabled,
          onCommit: next => controller.update({ captureIntervalSeconds: next }) })),
        h('p', { className: 'qcp-muted' }, '感知频率不等于发言频率。只有新事件需要理解时，才选取最近最多 3 帧送给默认模型。'),
        h('p', { className: 'qcp-note' }, '选中的关键帧会经过 Harness 附件服务，可能保存在本机共享附件缓存中；本插件不承诺自动删除该缓存。'))),
    h(Card, { title: '撒娇抢鼠标' },
      h(ToggleRow, { label: '允许撒娇抢鼠标', checked: settings.mousePlayEnabled, disabled: disabled || (!helper && settings.mousePlayEnabled!==true),
        title: !helper ? '请先启动原生宠物' : undefined,
        description: '默认关闭。太久没有互动时，短暂轻拉鼠标，最长 1.5 秒；移动鼠标或按 Esc 立即停止，不点击或输入。',
        onChange: next => next ? controller.action('request-mouse-permission') : controller.update({ mousePlayEnabled: false }) }),
      h('div', { className: 'qcp-form-row' },
        h(NumberField, { label: '多久没有互动后可以撒娇', value: settings.mousePlayAfterMinutes ?? 20, min: 5, max: 120, step: 1, unit: '分钟', disabled,
          onCommit: mousePlayAfterMinutes => controller.update({ mousePlayAfterMinutes }) }),
        h('p', { className: 'qcp-muted' }, '开启需要 macOS 辅助功能权限；点击开关后，由原生宠物显示确认与权限提示。'),
        h('p', { className: 'qcp-status', role: 'status' }, `辅助功能：${native.mouseAuthorized===true?'已授权':native.mouseAuthorized===false?'未授权':'待读取'} · 状态：${native.mousePlayActive===true?'正在轻拉鼠标':native.mousePlayActive===false?'未在轻拉鼠标':'待读取'}`),
        native.mouseStatus?h('p',{className:'qcp-muted'},native.mouseStatus):null)),
    h(Card, { title: '系统声音与视频对白' },
      h(ToggleRow, { label: '理解系统播放声音', checked: settings.videoAudioEnabled, disabled: disabled || !helper,
        description: '仅在本机离线语音识别可用时转写系统播放声，不使用麦克风。开启时会显示原生确认与权限请求。',
        onChange: next => next ? controller.action('request-audio-permission') : controller.update({ videoAudioEnabled: false }) }),
      h(Row, { label: '识别语言', description: '离线识别资源由 macOS 提供。' }, h('select', { className: 'qcp-select', 'aria-label': '系统声音识别语言', value: settings.speechLanguage || 'zh-CN', disabled,
        onChange: event => controller.update({ speechLanguage: event.currentTarget.value }) },
      [['zh-CN','中文（普通话）'],['en-US','英语（美国）']].map(([value,label]) => h('option', {value,key:value},label)))),
      h('div', { className: 'qcp-form-row' }, h('p', { className: 'qcp-status' }, native.audioStatus || '系统声音尚未开启。'),
        h('p', { className: 'qcp-muted' }, `屏幕权限：${native.screenAuthorized===true?'已授权':native.screenAuthorized===false?'未授权':'待读取'} · 声音识别：${native.audioAuthorized===true?'已授权':native.audioAuthorized===false?'未授权':'待读取'}`))),
    h(Card, { title: '发言与安静时机' },
      h(ToggleRow, { label: '会议中减少主动打扰', checked: settings.quietMeetingApps !== false, disabled,
        description: '识别常见会议应用，降低主动发言；由你发起的交流仍可继续。', onChange: next => controller.update({ quietMeetingApps: next }) }),
      h(ToggleRow, { label: '优先提醒任务待确认', checked: settings.urgentAgentAlerts !== false, disabled,
        description: '任务出现真实的待审批事件时，允许优先提醒一次。', onChange: next => controller.update({ urgentAgentAlerts: next }) }),
      h(TextListField, { value: settings.quietApps ?? [], disabled, onCommit: next => controller.update({ quietApps: next }) })));
}

function AppearanceSection({ snapshot, controller, disabled }) {
  const settings = snapshot.settings ?? {}, native = snapshot.native ?? {};
  const voices = Array.isArray(native.voices) ? native.voices : [];
  const appearanceDisabled = disabled || !helperRunning(snapshot);
  return h(React.Fragment, null,
    h(Card, { title: '角色与桌面' },
      h(ToggleRow, { label: '动态鲸尾女仆', checked: settings.dynamicSkinEnabled !== false, disabled,
        description: '使用逐帧动作；关闭后显示参考立绘。', onChange: next => controller.update({ dynamicSkinEnabled: next }) }),
      h(ToggleRow, { label: '减少动态效果', checked: settings.reduceMotion, disabled,
        description: '减少漂浮与连续动作，保持更安静的桌面表现。', onChange: next => controller.update({ reduceMotion: next }) }),
      h(Row, { label: '宠物大小' }, h(RangeField, { label:'宠物大小',value:native.scale??1,min:.6,max:1.6,step:.05,disabled:appearanceDisabled,
        format:value=>`${Math.round(value*100)}%`,onCommit:scale=>controller.action('set-appearance',{scale}) })),
      h(Row, { label: '透明度' }, h(RangeField, { label:'宠物透明度',value:native.opacity??1,min:.45,max:1,step:.05,disabled:appearanceDisabled,
        format:value=>`${Math.round(value*100)}%`,onCommit:opacity=>controller.action('set-appearance',{opacity}) })),
      h('div',{className:'qcp-form-row'},h('div',{className:'qcp-actions'},
        button('显示宠物',()=>controller.action('show-pet'),disabled),button('隐藏宠物',()=>controller.action('hide-pet'),disabled),
        button('喂食',()=>controller.action('feed'),appearanceDisabled),button('休息',()=>controller.action('sleep'),appearanceDisabled),button('叫醒',()=>controller.action('wake'),appearanceDisabled)))),
    h(Card, { title: '语音输出' },
      h(ToggleRow, { label:'朗读模型回应',checked:settings.voiceEnabled,disabled,description:'使用 macOS 本机声音朗读，不额外发送给语音云服务。',
        onChange:next=>controller.update({voiceEnabled:next}) }),
      h(Row,{label:'朗读声音',description:voices.length?'选择本机已安装的声音。':'等待原生宠物读取本机声音。'},
        h('select',{className:'qcp-select','aria-label':'朗读声音',value:settings.voiceIdentifier||'',disabled:disabled||!voices.length,
          onChange:event=>controller.update({voiceIdentifier:event.currentTarget.value})},
          h('option',{value:''},'跟随系统默认'),voices.map(voice=>h('option',{key:voice.id,value:voice.id},`${voice.name}${voice.language?` · ${voice.language}`:''}`)))),
      h(Row,{label:'朗读速度'},h(RangeField,{label:'朗读速度',value:settings.voiceRate??.48,min:.3,max:.65,step:.01,disabled,
        format:value=>value.toFixed(2),onCommit:voiceRate=>controller.update({voiceRate}) }))));
}

function GrowthGauge({ label, value }) {
  const known=Number.isFinite(value) && value>=0 && value<=100;
  return h('div',{className:'qcp-growth-gauge'},h('div',{className:'qcp-memory-toolbar'},
    h('span',{className:'qcp-field-label'},label),h('span',{className:'qcp-status'},known?`${count(value)} / 100`:'未知')),
    known?h('meter',{className:'qcp-growth-meter',min:0,max:100,value,'aria-label':label}):null);
}

function GrowthSection({ snapshot, controller, disabled }) {
  const settings=snapshot.settings??{},growth=snapshot.growth??{},stats=growth.stats??{};
  const snacks=Array.isArray(growth.snacks)?growth.snacks.filter(snack=>snack&&typeof snack==='object'&&typeof snack.id==='string'&&snack.id):[];
  const inventory=factualCount(growth.snackCount)?growth.snackCount:Array.isArray(growth.snacks)?snacks.length:null;
  const [selected,setSelected]=useState('');
  useEffect(()=>{if(selected&&!snacks.some(snack=>snack.id===selected)) setSelected('');},[snacks,selected]);
  const growthEnabled=settings.growthEnabled!==false;
  const offerDisabled=disabled||!growthEnabled||inventory===null||inventory===0;
  const stage=typeof growth.stage==='string'&&growth.stage?growth.stage:'待读取';
  const moodNames={idle:'安静',happy:'开心',shy:'害羞',concern:'关心',tease:'想撒娇',thinking:'思考中',sleep:'休息中'};
  const moodText=typeof growth.mood==='string' ? (moodNames[growth.mood]??growth.mood) : '未知';
  return h(React.Fragment,null,
    h(Card,{title:'陪伴成长'},
      h(ToggleRow,{label:'启用成长',checked:growthEnabled,disabled,
        description:'陪伴过程中的成长与虚拟零食。关闭后保留已有成长和库存。',onChange:next=>controller.update({growthEnabled:next})}),
      h('div',{className:'qcp-form-row'},
        h('div',{className:'qcp-memory-toolbar'},h('span',{className:'qcp-tag'},`阶段：${stage}`),button('刷新成长',()=>controller.action('growth-refresh'),disabled)),
        h('dl',{className:'qcp-metrics'},
          h('div',{className:'qcp-metric'},h('dt',null,'等级'),h('dd',null,factualCount(growth.level)?`Lv. ${count(growth.level)}${typeof growth.levelTitle==='string'&&growth.levelTitle?` · ${growth.levelTitle}`:''}`:'未知')),
          h('div',{className:'qcp-metric'},h('dt',null,'经验'),h('dd',null,factualCount(growth.experience)?count(growth.experience):'未知'))),
        factualCount(growth.experience)&&Number.isSafeInteger(growth.nextLevelExperience)&&growth.nextLevelExperience>0
          ?h('div',{className:'qcp-growth-gauge'},h('p',{className:'qcp-muted'},`升级经验：${count(growth.experience)} / ${count(growth.nextLevelExperience)}`),
            h('progress',{className:'qcp-growth-meter',value:Math.min(growth.experience,growth.nextLevelExperience),max:growth.nextLevelExperience,'aria-label':'升级经验'})):null,
        h('div',{className:'qcp-grid'},h(GrowthGauge,{label:'饱腹',value:growth.satiety}),h(GrowthGauge,{label:'精力',value:growth.energy}),
          typeof growth.mood==='number'?h(GrowthGauge,{label:'心情',value:growth.mood}):h('div',{className:'qcp-growth-gauge'},h('span',{className:'qcp-field-label'},'心情'),h('span',{className:'qcp-status'},moodText))))),
    h(Card,{title:'零食库存'},h('div',{className:'qcp-form-row'},
      h('p',{className:'qcp-status'},inventory!==null?`当前库存：${count(inventory)} 份`:'当前库存：待读取'),
      h('div',{className:'qcp-actions'},h('select',{className:'qcp-select','aria-label':'选择虚拟零食',value:selected,disabled:offerDisabled,
        onChange:event=>setSelected(event.currentTarget.value)},h('option',{value:''},'自动选一份'),
        snacks.slice(0,100).map((snack,index)=>h('option',{value:snack.id,key:snack.id},`${typeof snack.name==='string'?snack.name:typeof snack.kind==='string'?snack.kind:'零食'} · ${index+1}`))),
        button('递一份零食',()=>controller.action('offer-snack',selected?{id:selected}:{}),offerDisabled,'primary')),
      h('p',{className:'qcp-muted'},'递出后由她决定什么时候吃；过饱或忙碌时会先等一等，不保证立即吃掉。'),
      typeof growth.status==='string'&&growth.status?h('p',{className:'qcp-status',role:'status'},growth.status):null,
      h('p',{className:'qcp-muted'},`累计获得 ${count(stats.earnedSnacks)} 份 · 已吃 ${count(stats.eatenSnacks)} 份 · 已记录 ${count(stats.trackedTokens)} token`))),
    h(Card,{title:'零食奖励规则'},
      h(ToggleRow,{label:'按 token 获得零食',checked:settings.snackRewardsEnabled!==false,disabled,
        description:'已上报的真实用量累计达到设定值后，获得本地虚拟零食。',onChange:next=>controller.update({snackRewardsEnabled:next})}),
      h(ToggleRow,{label:'允许自动吃零食',checked:settings.autoEatEnabled!==false,disabled,
        description:'由状态决定进食时机；你也可以手动递一份。',onChange:next=>controller.update({autoEatEnabled:next})}),
      h('div',{className:'qcp-form-row'},
        h(NumberField,{label:'每份零食所需 token',value:settings.tokensPerSnack??2000,min:100,max:100000,step:100,unit:'token',disabled,
          onCommit:tokensPerSnack=>controller.update({tokensPerSnack})}),
        h('p',{className:'qcp-note'},'来源范围：本 Host Agent 步骤及宠物自身调用；未上报用量不推算，不计其他应用。'),
        h('p',{className:'qcp-muted'},'日常互动也可增加成长，不需要为了成长额外消耗 token。'),
        h('p',{className:'qcp-muted'},'token 映射仅为虚拟成长奖励，不提供购买或真实付费；使用现有 Harness 配置，不需要额外 API Key 或系统授权。'))));
}

function UsageSection({ snapshot, controller, disabled }) {
  const settings=snapshot.settings??{}, usage=snapshot.usage??{}, budget=snapshot.budget??{}, agent=snapshot.agent??{};
  const balance=snapshot.balance??{};
  const metrics=[['总 token',usage.totalTokens],['未缓存输入',usage.inputTokens],['缓存读取',usage.cacheReadTokens],['输出 token',usage.outputTokens]];
  const costs=Object.entries(usage.estimatedCosts??{}).filter(([,value])=>Number.isFinite(value));
  return h(React.Fragment,null,
    h(Card,{title:'Harness Agent 进度'},
      h(ToggleRow,{label:'显示真实任务进度',checked:settings.agentProgressEnabled!==false,disabled,
        description:'显示当前 Host 的真实步骤、工具与待确认状态，不生成完成百分比。',onChange:next=>controller.update({agentProgressEnabled:next})}),
      h('div',{className:'qcp-form-row'},h('div',{className:'qcp-agent-summary'},
        agent.available===false?'当前没有可读取的 Agent 进度。':agent.current
          ? `${agent.current.title||agent.current.name||'当前任务'} · ${phaseLabel(agent.current.phase||agent.current.status)}${agent.current.toolName?` · 工具：${agent.current.toolName}`:''}`
          : '暂无进行中的任务。'),
        agent.current?h('div',{className:'qcp-actions'},
          factualCount(agent.current.turn)?h('span',{className:'qcp-tag'},`当前轮次：${count(agent.current.turn)}`):null,
          factualCount(agent.current.step)?h('span',{className:'qcp-tag'},`当前步骤：${count(agent.current.step)}`):null,
          factualCount(agent.current.observedCompletedSteps)?h('span',{className:'qcp-tag'},`已观察完成步骤：${count(agent.current.observedCompletedSteps)}`):null):null,
        h('p',{className:'qcp-muted'},`运行中 ${count(agent.activeCount)} · 待确认 ${count(agent.waitingCount)}`))),
    h(Card,{title:'今日实际用量'},h('div',{className:'qcp-form-row'},
      h('div',{className:'qcp-memory-toolbar'},h('span',{className:'qcp-muted'},usage.day||'今日'),button('刷新用量与余额',()=>controller.action('refresh-usage'),disabled)),
      h('dl',{className:'qcp-metrics'},metrics.map(([label,value])=>h('div',{className:'qcp-metric',key:label},h('dt',null,label),h('dd',null,count(value))))),
      h('p',{className:'qcp-muted'},`有用量回报 ${count(usage.reportedCalls)} / 实际调用 ${count(usage.calls)}。${usage.usageComplete?'统计完整。':'缺失的计数保持未知，不能据此推断完整账单。'}`),
      h('p',{className:'qcp-status'},costs.length?`按所填单价估算：${costs.map(([currency,value])=>`${currency} ${value.toFixed(4)}`).join(' / ')}${usage.estimatedCostComplete?'':'（部分用量）'}`:'尚无可计算的费用估算。'),
      h('p',{className:'qcp-status'},balance.available===true
        ? `${balance.source||'账户余额'}：${(balance.wallets??[]).map(wallet=>`${wallet.currency} ${wallet.balance}`).join(' / ')||'未返回普通钱包余额'}`
        : balance.reason||'当前模型服务暂不提供可查询的余额。'),
      budget.reached?h('p',{className:'qcp-status'},'已达到今日设置的预算，模型回应暂时暂停。'):null)),
    h(Card,{title:'每日预算与单价'},h('div',{className:'qcp-form-row'},h('div',{className:'qcp-grid'},
      h(NumberField,{label:'每日 token 上限',value:settings.dailyTokenBudget??100000,min:0,max:10000000,disabled,onCommit:dailyTokenBudget=>controller.update({dailyTokenBudget})}),
      h(NumberField,{label:'每日估算费用上限',value:settings.dailyBudget??0,min:0,max:100000,step:.1,unit:'元',disabled,onCommit:dailyBudget=>controller.update({dailyBudget})}),
      h(NumberField,{label:'输入单价／百万 token',value:settings.inputPricePerMillion??0,min:0,max:100000,step:.01,unit:'元',disabled,onCommit:inputPricePerMillion=>controller.update({inputPricePerMillion})}),
      h(NumberField,{label:'输出单价／百万 token',value:settings.outputPricePerMillion??0,min:0,max:100000,step:.01,unit:'元',disabled,onCommit:outputPricePerMillion=>controller.update({outputPricePerMillion})})),
      h('p',{className:'qcp-note'},'预算填 0 表示不设置该上限。费用仅按你输入的单价估算，和账户余额分开；未知用量不会补成零。'))));
}

function LoadedSettings({ controller, useSnapshot }) {
  const state=useSnapshot(value=>value);
  const [tab,setTab]=useState('companion');
  const id=useId();
  useEffect(()=>controller.open(),[controller]);
  const snapshot=state.snapshot??{};
  const disabled=state.busy||state.status!=='ready';
  const tabs=[['companion','感知与陪伴'],['appearance','外观与语音'],['growth','成长与零食'],['memory','记忆'],['usage','进度与用量']];
  const view={companion:CompanionSection,appearance:AppearanceSection,growth:GrowthSection,memory:MemorySection,usage:UsageSection}[tab];
  return h('div',{className:'qcp-settings'},
    h('div',{className:'qcp-title-row'},h('div',{className:'qcp-title-copy'},h('h2',null,'安静陪伴'),h('p',{className:'qcp-intro'},'在这里管理她如何感知、交流、记忆与安静陪伴。')),
      h('div',{className:'qcp-actions'},h('span',{className:'qcp-heading-badge'},helperRunning(snapshot)?'宠物已连接':'等待宠物连接'),
        button('重启宠物',()=>controller.action('restart-pet'),disabled,'outline'))),
    snapshot.helper?.error?h('div',{className:'qcp-error',role:'alert'},String(snapshot.helper.error)):null,
    (snapshot.native?.permissionRequestInFlight===true||snapshot.permissionRequestInFlight===true)
      ?h('p',{className:'qcp-note',role:'status'},'正在等待原生授权确认，请在 macOS 提示中继续或取消。'):null,
    h('div',{className:'qcp-model'},h('div',{className:'qcp-model-head'},h('span',{className:'qcp-muted'},'Harness 默认模型'),
      h('span',{className:'qcp-model-name'},snapshot.route?.label||snapshot.route?.model||'等待默认模型配置'),
      snapshot.route?h('span',{className:'qcp-tag'},(snapshot.capabilities?.vision??snapshot.route.vision)?'可理解画面':'文字模型'):null),
      h('p',{className:'qcp-muted'},'自动跟随 Harness，不需要重复填写 API Key。默认模型可在“模型”设置中更改。'),
      snapshot.status?h('p',{className:'qcp-status',role:'status'},typeof snapshot.status==='string'?snapshot.status:snapshot.status.text||''):null,
      h('div',{className:'qcp-actions'},button('刷新模型',()=>controller.action('refresh-model'),disabled),
        button(snapshot.settings?.observationEnabled?'暂停观察':'恢复观察',()=>controller.action(snapshot.settings?.observationEnabled?'pause':'resume'),disabled),
        button('安静 30 分钟',()=>controller.action('snooze'),disabled))),
    state.error?h('div',{className:'qcp-error',role:'alert'},state.error,button('重试',()=>controller.load(),state.busy,'ghost')):null,
    state.status==='loading'&&!state.snapshot?h('p',{className:'qcp-muted',role:'status'},'正在读取陪伴设置……'):null,
    h('div',{className:'qcp-tabs',role:'tablist','aria-label':'安静陪伴设置分区'},tabs.map(([key,label])=>h('button',{
      key,id:`${id}-tab-${key}`,className:'qcp-tab',type:'button',role:'tab',tabIndex:tab===key?0:-1,'aria-selected':tab===key,'aria-controls':`${id}-panel`,
      onClick:()=>setTab(key),onKeyDown:event=>{
        if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
          event.preventDefault(); const index=tabs.findIndex(([value])=>value===tab);
          const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
          setTab(tabs[next][0]); document.getElementById(`${id}-tab-${tabs[next][0]}`)?.focus();
        }
      },
    },label))),
    h('div',{id:`${id}-panel`,className:'qcp-panel',role:'tabpanel','aria-labelledby':`${id}-tab-${tab}`},h(view,{snapshot,controller,disabled})),
    h('p',{className:'qcp-muted','aria-live':'polite'},state.busy?'正在应用设置……':snapshot.native?.modelStatus||''));
}
function SettingsPage(props) {
  if(!props.controller||!props.useSnapshot) return null;
  return h(LoadedSettings,{controller:props.controller,useSnapshot:props.useSnapshot});
}

module.exports={
  name:'quiet-companion-settings',inject:['slots','connection','locale'],
  apply(ctx) {
    const controller=new CompanionSettingsController(ctx.connection);
    ctx.effect(()=>{
      if(typeof document==='undefined') return ()=>{};
      const style=document.createElement('style'); style.dataset.quietCompanionSettings='true'; style.textContent=STYLE_TEXT;
      document.head.appendChild(style); return ()=>style.remove();
    },'quiet-companion: settings styles');
    ctx.effect(()=>()=>controller.dispose(),'quiet-companion: settings bridge');
    ctx.effect(()=>ctx.locale.register('quietCompanionSettings',{zh:{nav:'安静陪伴'},en:{nav:'Quiet Companion'}}),'quiet-companion: settings copy');
    const t=ctx.locale.bind('quietCompanionSettings');
    ctx.on('connection/reset',()=>{if(controller.active>0) void controller.load();});
    ctx.slots.inject('settings.section',()=>ctx.slots.register({
      name:'settings.section',id:'quiet-companion',order:55,label:()=>t('nav'),
      inject:()=>({controller,hooks:{snapshot:controller.store}}),
    },SettingsPage));
  },
};

return module.exports;
}});
