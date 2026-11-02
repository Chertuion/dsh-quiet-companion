import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from './storage.mjs';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createStateStore(dir, { now: () => Date.parse('2026-11-02T12:00:00Z'), ...options }) };
}

test('memory is opt-in, bounded, inspectable and removable; opt-out erases remembered text', t => {
  const { dir, store } = fixture(t);
  assert.equal(store.addChat('user', 'do not persist before consent'), false);
  assert.equal(store.addFact('do not persist'), null);
  store.setMemoryEnabled(true);
  for (let i = 0; i < 30; i++) store.addChat(i % 2 ? 'assistant' : 'user', `line-${i}`);
  assert.equal(store.inspectMemory().recent.length, 24);
  const fact = store.addFact('请记住，我希望少一点打扰。');
  assert.equal(fact.source, 'user-explicit');
  assert.equal(store.addFact(fact.text).id, fact.id);
  const loaded = createStateStore(dir);
  assert.equal(loaded.inspectMemory().facts[0].text, fact.text);
  assert.equal(store.removeFact(fact.id), true);
  store.setMemoryEnabled(false);
  assert.deepEqual(store.inspectMemory(), { enabled: false, recent: [], facts: [] });
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8').includes('line-'), false);
});

test('unknown object fields, screenshots and recognizable credentials are never persisted', t => {
  const { dir, store } = fixture(t); store.setMemoryEnabled(true);
  assert.equal(store.addChat('user', { text: 'bad', screen: { data: 'PRIVATE_PIXELS' } }), false);
  store.addChat('user', '你好 API_KEY=supersecret password:abc123 密码是chinesesecret password is englishsecret sk-abcdefghijklmnop data:image/png;base64,QUJDRA==');
  store.recordUsage({ inputTokens: 12, outputTokens: 3, screen: { data: 'PRIVATE_PIXELS' }, apiKey: 'CREDENTIAL' });
  const saved = readFileSync(join(dir, 'state.json'), 'utf8');
  assert.equal(/supersecret|abc123|chinesesecret|englishsecret|sk-abcdefghijklmnop|QUJDRA|PRIVATE_PIXELS|CREDENTIAL/u.test(saved), false);
  assert.equal(saved.includes('你好'), true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('actual rc5 token counts are disjoint; unknown cost and balance stay null', t => {
  const { store } = fixture(t);
  const empty = store.dailyUsage();
  assert.equal(empty.totalTokens, null); assert.equal(empty.balance, null);
  store.recordUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10, totalTokens: 200 });
  store.recordUsage({ inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const day = store.dailyUsage();
  assert.equal(day.totalTokens, 245); assert.equal(day.inputTokens, 140); assert.equal(day.cacheReadTokens, 70);
  assert.equal(day.calls, 2); assert.equal(day.usageComplete, true);
  assert.equal(day.coverage.cacheReadTokens, 2); assert.deepEqual(day.estimatedCosts, {});
  const budget = store.budgetReached({ dailyTokenLimit: 240, dailyCostLimit: 1 });
  assert.equal(budget.reached, true); assert.deepEqual(budget.reasons, ['daily-token-limit']);
  assert.equal(budget.estimatedCost, null); assert.equal(budget.balanceKnown, false);
});

test('reported rc5 total is preserved and absent cache counters never invent a total', t => {
  const { store } = fixture(t);
  store.recordUsage({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, totalTokens: 17 });
  assert.equal(store.dailyUsage().totalTokens, 17);
  assert.equal(store.budgetReached({ dailyTokenLimit: 16 }).reached, true);
  store.clearUsage();
  store.recordUsage({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 });
  assert.equal(store.dailyUsage().totalTokens, null);
  assert.equal(store.dailyUsage().cacheWriteTokens, null);
  assert.equal(store.dailyUsage().usageComplete, false);
  store.recordUsage({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 40, cacheWriteTokens: 2 });
  assert.equal(store.dailyUsage().totalTokens, 55);
  assert.equal(store.dailyUsage().usageComplete, false);
});

test('usage gaps remain explicit; duplicate request ids do not charge twice', t => {
  const { store } = fixture(t);
  store.recordUsage({ inputTokens: 8, outputTokens: 2, totalTokens: 10 }, { id: 'request-secret-id' });
  store.recordUsage({ inputTokens: 8, outputTokens: 2, totalTokens: 10 }, { id: 'request-secret-id' });
  store.recordUsage(undefined);
  const day = store.dailyUsage();
  assert.equal(day.calls, 2); assert.equal(day.reportedCalls, 1); assert.equal(day.totalTokens, 10);
  assert.equal(day.usageComplete, false);
  assert.equal(store.budgetReached({ dailyTokenLimit: 5 }).reached, true);
  assert.equal(store.budgetReached({ dailyTokenLimit: 50 }).remainingTokens, null);
  assert.equal(store.exportState().includes('request-secret-id'), false);
});

test('optional user-defined prices produce labeled estimates and currency-specific limits', t => {
  const { store } = fixture(t);
  store.recordUsage({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 200_000, cacheWriteTokens: 0 }, {
    prices: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 3, cacheReadPerMillion: 0.2 },
  });
  const day = store.dailyUsage();
  assert.ok(Math.abs(day.estimatedCosts.CNY - 2.34) < 1e-9);
  assert.equal(day.estimatedCostComplete, true);
  assert.equal(store.budgetReached({ dailyCostLimit: 2.3, currency: 'CNY' }).reached, true);
  assert.equal(store.budgetReached({ dailyCostLimit: 1.9, currency: 'USD' }).estimatedCost, null);
  store.recordUsage({ inputTokens: 100, outputTokens: 10 }, {
    prices: { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 3, cacheReadPerMillion: 0.2 },
  });
  assert.equal(store.dailyUsage().estimatedCostComplete, false);
});

test('Asia/Shanghai day boundary and clear/export operate on local text/aggregates only', t => {
  const { store } = fixture(t);
  const before = Date.parse('2026-11-02T15:59:59Z'); const after = before + 1000;
  store.recordUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, { at: before });
  store.recordUsage({ inputTokens: 2, outputTokens: 2, totalTokens: 4 }, { at: after });
  assert.equal(store.dailyUsage(before).day, '2026-11-02');
  assert.equal(store.dailyUsage(after).day, '2026-11-03');
  assert.equal(store.dailyUsage(before).totalTokens, 2);
  assert.equal(store.dailyUsage(after).totalTokens, 4);
  store.setMemoryEnabled(true); store.addChat('user', '清除测试'); store.clearMemory();
  assert.equal(store.exportMemory().includes('清除测试'), false);
  store.clearUsage('2026-11-03'); assert.equal(store.dailyUsage(after).totalTokens, null);
});

test('different currencies never become one complete estimated-cost balance', t => {
  const { store } = fixture(t);
  for (const currency of ['CNY', 'USD']) store.recordUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, {
    prices: { currency, inputPerMillion: 2, outputPerMillion: 3 },
  });
  assert.equal(store.dailyUsage().estimatedCostComplete, false);
  const budget = store.budgetReached({ dailyCostLimit: 1, currency: 'CNY' });
  assert.equal(budget.costComplete, false);
  assert.equal(budget.remainingEstimatedCost, null);
  assert.equal(budget.balance, null);
});

test('symlinked or oversized state fails closed without reading another file', t => {
  const { dir } = fixture(t);
  const outside = join(dir, 'outside.json'); writeFileSync(outside, '{"private":"SECRET"}');
  symlinkSync(outside, join(dir, 'state.json'));
  assert.throws(() => createStateStore(dir), /unsafe-state-file/u);
});
