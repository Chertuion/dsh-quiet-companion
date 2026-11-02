/** Private local opt-in text memory and actual-usage ledger. Never accepts observations or credentials. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync, readFileSync, openSync, writeFileSync,
  closeSync, fsyncSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

const FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const LIMITS = Object.freeze({ recent: 24, facts: 48, days: 62, fileBytes: 512 * 1024 });
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = value => Number.isFinite(value) && value >= 0 ? value : null;
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
const clone = value => JSON.parse(JSON.stringify(value));

/** Remove obvious encoded images and credential forms even from explicitly saved chat text. */
function memoryText(value, max = 1200) {
  if (typeof value !== 'string') return '';
  const sanitized = value.slice(0, 20_000)
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/giu, '[编码内容已省略]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[私钥已省略]')
    .replace(/\b(?:sk|rk|pk)[_-][A-Za-z0-9_-]{12,}\b/gu, '[密钥已省略]')
    .replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]+=*/giu, 'Bearer [密钥已省略]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|secret|password|密码|密钥)\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,，;；]+)/giu, '$1[敏感信息已省略]')
    .replace(/((?:密码|密钥|口令)\s*(?:是|为)\s*)[^\s,，;；。]+/gu, '$1[敏感信息已省略]')
    .replace(/(\b(?:password|api[_ -]?key|access[_ -]?token)\s+is\s+)[^\s,;]+/giu, '$1[敏感信息已省略]')
    .replace(/[A-Za-z0-9+/]{240,}={0,2}/gu, '[编码内容已省略]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim();
  return Array.from(sanitized).slice(0, max).join('');
}
function usageFields(value) {
  const usage = {};
  if (!value || typeof value !== 'object') return usage;
  for (const field of FIELDS) if (integer(value[field]) !== null) usage[field] = value[field];
  if (usage.totalTokens === undefined && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .every(field => usage[field] !== undefined)) {
    // rc5 counters are DISJOINT: inputTokens is uncached input, not aggregate prompt tokens.
    // A reported total is authoritative. Without it, missing cache counters remain unknown.
    const sum = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (Number.isSafeInteger(sum)) usage.totalTokens = sum;
  }
  return usage;
}
function emptyDay(day) {
  return { day, calls: 0, reportedCalls: 0,
    ...Object.fromEntries(FIELDS.map(field => [field, null])),
    coverage: Object.fromEntries(FIELDS.map(field => [field, 0])), estimatedCosts: {}, costCoverage: {}, pricedCalls: 0 };
}
function estimatedCost(usage, prices) {
  if (!prices || !/^[A-Z]{3}$/u.test(prices.currency)
      || positive(prices.inputPerMillion) === null || positive(prices.outputPerMillion) === null
      || usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  const input = usage.inputTokens * prices.inputPerMillion;
  // Only reported categories contribute. Omitted cache categories make this estimate partial;
  // their absence is never saved as an actual zero count or a complete cost.
  const read = usage.cacheReadTokens === undefined ? 0
    : usage.cacheReadTokens * (positive(prices.cacheReadPerMillion) ?? prices.inputPerMillion);
  const write = usage.cacheWriteTokens === undefined ? 0
    : usage.cacheWriteTokens * (positive(prices.cacheWritePerMillion) ?? prices.inputPerMillion);
  const output = usage.outputTokens * prices.outputPerMillion;
  const value = (input + read + write + output) / 1_000_000;
  return Number.isFinite(value) ? { currency: prices.currency, value,
    complete: usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined } : null;
}

/**
 * Synchronous private store: operations are atomic within the owning plugin process.
 * memory defaults off. addChat/addFact accept text only, bounded and sanitized.
 * recordUsage(usage,{at,prices,id}) stores numeric aggregates only, never API keys/routes/screens.
 * dailyUsage returns actual reported sums plus coverage; absent counters/cost/balance remain null.
 */
export class StateStore {
  constructor(dir, { now = Date.now, dayOffsetMinutes = 480 } = {}) {
    if (typeof dir !== 'string' || !dir) throw new Error('invalid-state-directory');
    this.dir = resolve(dir);
    this.file = join(this.dir, 'state.json');
    this.now = now;
    this.dayOffsetMinutes = Number.isFinite(dayOffsetMinutes) ? Math.max(-720, Math.min(840, dayOffsetMinutes)) : 480;
    this.state = { version: 1, memory: { enabled: false, recent: [], facts: [] }, usage: { days: [], dedup: [] } };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (lstatSync(this.dir).isSymbolicLink()) throw new Error('unsafe-state-directory');
    chmodSync(this.dir, 0o700);
    this.load();
  }

  dayOf(at = this.now()) {
    const timestamp = Number.isFinite(at) && Math.abs(at) < 8.64e15 ? at : this.now();
    return new Date(timestamp + this.dayOffsetMinutes * 60_000).toISOString().slice(0, 10);
  }

  load() {
    if (!existsSync(this.file)) return;
    const info = lstatSync(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIMITS.fileBytes) throw new Error('unsafe-state-file');
    chmodSync(this.file, 0o600);
    let parsed;
    try { parsed = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch { throw new Error('unreadable-state-file'); }
    if (parsed?.version !== 1) throw new Error('unsupported-state-version');
    const memory = parsed.memory;
    if (memory?.enabled === true) {
      this.state.memory.enabled = true;
      this.state.memory.recent = (Array.isArray(memory.recent) ? memory.recent : []).slice(-LIMITS.recent)
        .filter(item => item?.role === 'user' || item?.role === 'assistant')
        .map(item => ({ role: item.role, text: memoryText(item.text), at: integer(item.at) ?? 0 })).filter(item => item.text);
      this.state.memory.facts = (Array.isArray(memory.facts) ? memory.facts : []).slice(-LIMITS.facts)
        .map(item => ({ id: typeof item?.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(item.id) ? item.id : randomUUID(),
          text: memoryText(item?.text, 300), at: integer(item?.at) ?? 0, source: 'user-explicit' })).filter(item => item.text);
    }
    const days = Array.isArray(parsed.usage?.days) ? parsed.usage.days : [];
    this.state.usage.days = days.filter(item => validDay(item?.day)).slice(-LIMITS.days).map(item => {
      const day = emptyDay(item.day);
      day.calls = integer(item.calls) ?? 0; day.reportedCalls = Math.min(day.calls, integer(item.reportedCalls) ?? 0);
      for (const field of FIELDS) {
        day[field] = integer(item[field]);
        day.coverage[field] = Math.min(day.calls, integer(item.coverage?.[field]) ?? 0);
      }
      day.estimatedCosts = Object.fromEntries(Object.entries(item.estimatedCosts ?? {})
        .filter(([currency, amount]) => /^[A-Z]{3}$/u.test(currency) && positive(amount) !== null));
      day.costCoverage = Object.fromEntries(Object.entries(item.costCoverage ?? {})
        .filter(([currency, count]) => /^[A-Z]{3}$/u.test(currency) && integer(count) !== null && count <= day.calls));
      day.pricedCalls = Math.min(day.calls, integer(item.pricedCalls) ?? 0);
      return day;
    });
    this.state.usage.dedup = (Array.isArray(parsed.usage?.dedup) ? parsed.usage.dedup : [])
      .filter(value => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value)).slice(-256);
  }

  persist() {
    const staging = join(this.dir, `.state-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(staging, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(this.state)}\n`, 'utf8');
      fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(staging, this.file); chmodSync(this.file, 0o600);
    } catch {
      throw new Error('state-write-failed');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(staging); } catch { /* Already atomically promoted, or never created. */ }
    }
  }

  setMemoryEnabled(enabled) {
    this.state.memory.enabled = enabled === true;
    if (!this.state.memory.enabled) { this.state.memory.recent = []; this.state.memory.facts = []; }
    this.persist();
    return this.inspectMemory();
  }

  addChat(role, value) {
    if (!this.state.memory.enabled || (role !== 'user' && role !== 'assistant')) return false;
    const text = memoryText(value);
    if (!text) return false;
    this.state.memory.recent.push({ role, text, at: this.now() });
    this.state.memory.recent = this.state.memory.recent.slice(-LIMITS.recent);
    this.persist(); return true;
  }

  addFact(value) {
    if (!this.state.memory.enabled) return null;
    const text = memoryText(value, 300);
    if (!text) return null;
    const duplicate = this.state.memory.facts.find(item => item.text === text);
    if (duplicate) return clone(duplicate);
    const item = { id: randomUUID(), text, at: this.now(), source: 'user-explicit' };
    this.state.memory.facts.push(item); this.state.memory.facts = this.state.memory.facts.slice(-LIMITS.facts);
    this.persist(); return clone(item);
  }

  removeFact(id) {
    const before = this.state.memory.facts.length;
    this.state.memory.facts = this.state.memory.facts.filter(item => item.id !== id);
    if (this.state.memory.facts.length === before) return false;
    this.persist(); return true;
  }

  inspectMemory() { return clone(this.state.memory); }
  clearMemory() { this.state.memory.recent = []; this.state.memory.facts = []; this.persist(); return this.inspectMemory(); }
  exportMemory() { return JSON.stringify(this.inspectMemory(), null, 2); }

  recordUsage(value, { at = this.now(), prices, id } = {}) {
    let key;
    if (typeof id === 'string' && id) {
      key = createHash('sha256').update(id).digest('hex').slice(0, 32);
      if (this.state.usage.dedup.includes(key)) return this.dailyUsage(at);
    }
    const date = this.dayOf(at);
    let day = this.state.usage.days.find(item => item.day === date);
    if (!day) { day = emptyDay(date); this.state.usage.days.push(day); }
    day.calls++;
    const usage = usageFields(value);
    if (Object.keys(usage).length) day.reportedCalls++;
    for (const [field, count] of Object.entries(usage)) {
      const sum = (day[field] ?? 0) + count;
      if (!Number.isSafeInteger(sum)) continue;
      day[field] = sum; day.coverage[field]++;
    }
    const cost = estimatedCost(usage, prices);
    if (cost) {
      day.estimatedCosts[cost.currency] = (day.estimatedCosts[cost.currency] ?? 0) + cost.value;
      if (cost.complete) day.costCoverage[cost.currency] = (day.costCoverage[cost.currency] ?? 0) + 1;
      day.pricedCalls++;
    }
    this.state.usage.days.sort((a, b) => a.day.localeCompare(b.day));
    this.state.usage.days = this.state.usage.days.slice(-LIMITS.days);
    if (key) { this.state.usage.dedup.push(key); this.state.usage.dedup = this.state.usage.dedup.slice(-256); }
    this.persist(); return this.dailyUsage(at);
  }

  dailyUsage(at = this.now()) {
    const day = clone(this.state.usage.days.find(item => item.day === this.dayOf(at)) ?? emptyDay(this.dayOf(at)));
    return { ...day, usageComplete: day.calls > 0 && day.coverage.totalTokens === day.calls,
      estimatedCostComplete: day.calls > 0 && Object.keys(day.estimatedCosts).length === 1
        && Object.values(day.costCoverage).some(count => count === day.calls),
      balanceKnown: false, balance: null };
  }

  /** Budget counts only reported use; cost is explicitly a user-price estimate, never an account balance. */
  budgetReached({ dailyTokenLimit, dailyCostLimit, currency = 'CNY', tokenLimit, costLimit } = {}, at = this.now()) {
    const usage = this.dailyUsage(at);
    const tokens = positive(dailyTokenLimit ?? tokenLimit);
    const cost = positive(dailyCostLimit ?? costLimit);
    const estimate = /^[A-Z]{3}$/u.test(currency) ? usage.estimatedCosts[currency] ?? null : null;
    const costComplete = usage.calls > 0 && usage.costCoverage[currency] === usage.calls;
    const reasons = [];
    if (tokens !== null && tokens > 0 && usage.totalTokens !== null && usage.totalTokens >= tokens) reasons.push('daily-token-limit');
    if (cost !== null && cost > 0 && estimate !== null && estimate >= cost) reasons.push('daily-estimated-cost-limit');
    return { reached: reasons.length > 0, reasons, day: usage.day,
      knownTokens: usage.totalTokens, tokensComplete: usage.usageComplete,
      estimatedCost: estimate, costComplete, currency,
      remainingTokens: tokens !== null && tokens > 0 && usage.usageComplete ? Math.max(0, tokens - usage.totalTokens) : null,
      remainingEstimatedCost: cost !== null && cost > 0 && estimate !== null && costComplete ? Math.max(0, cost - estimate) : null,
      balanceKnown: false, balance: null };
  }

  clearUsage(day) {
    this.state.usage.days = validDay(day) ? this.state.usage.days.filter(item => item.day !== day) : [];
    this.state.usage.dedup = []; this.persist(); return this.dailyUsage();
  }
  inspect() { return { version: 1, memory: this.inspectMemory(), days: this.state.usage.days.map(day =>
    this.dailyUsage(Date.parse(`${day.day}T12:00:00Z`) - this.dayOffsetMinutes * 60_000)) }; }
  exportState() { return JSON.stringify(this.inspect(), null, 2); }
}

export const createStateStore = (dir, options) => new StateStore(dir, options);
