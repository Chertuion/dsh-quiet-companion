import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionMemory, expandMemoryQuery } from './memory.mjs';

async function fixture(t, options) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'quiet-companion-memory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const memory = new CompanionMemory(directory, options);
  await memory.ready;
  return { memory, directory };
}

function extractor(makeResponse, { usage, wait, kind = 'stop' } = {}) {
  const calls = [];
  return { calls, async *stream(request) {
    calls.push(request);
    if (wait) await wait;
    const context = JSON.parse(request.messages[0].content[0].text);
    const response = typeof makeResponse === 'function' ? makeResponse(context) : makeResponse;
    yield { type: 'text-delta', index: 0, text: typeof response === 'string' ? response : JSON.stringify(response) };
    if (usage) yield { type: 'usage', usage };
    yield { type: 'finish', reason: { kind } };
  } };
}
const route = { provider: 'fixture', model: 'default' };

test('real MCP graph and Orama persist across restart with private files', async t => {
  const { memory, directory } = await fixture(t);
  await memory.rememberFact('我喜欢安静陪伴，不要频繁打断。', { kind: 'preference', slot: 'interaction.frequency' });
  await memory.rememberTurn('记住我喜欢无糖咖啡。', '好的。');
  const graph = await memory.graph.readGraph();
  assert.equal(graph.entities.some(entity => entity.entityType === 'person'), true);
  assert.equal(graph.relations.some(relation => relation.relationType === 'prefers'), true);
  for (const path of [memory.graphFile, memory.chatsFile]) assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  const restarted = new CompanionMemory(directory);
  await restarted.ready;
  const state = await restarted.snapshot();
  assert.deepEqual(state.counts, { facts: 1, pinned: 1, episodes: 1 });
  assert.equal((await restarted.retrieve('咖啡', { limit: 8 })).some(item => item.kind === 'episode'), true);
});

test('Chinese unigram and bigram expansion retrieves without embeddings', async t => {
  const { memory } = await fixture(t);
  await memory.rememberFact('我喜欢周末去骑自行车。', { source: 'user-chat', pinned: false });
  await memory.rememberFact('我喝咖啡不加糖。', { source: 'user-chat', pinned: false });
  const hits = await memory.retrieve('喝咖啡', { limit: 1 });
  assert.equal(hits[0].text, '我喝咖啡不加糖。');
  assert.match(expandMemoryQuery('咖啡'), /cjk5496x5561/u);
});

test('facts deduplicate, explicit corrections replace slots, and forget removes indexes', async t => {
  const { memory } = await fixture(t);
  await memory.rememberFact('喜欢咖啡', { kind: 'preference', slot: 'drink' });
  await memory.rememberFact('喜欢 咖啡。', { kind: 'preference', slot: 'drink' });
  assert.equal((await memory.snapshot()).counts.facts, 1);
  await memory.rememberFact('现在喜欢茶', { kind: 'preference', slot: 'drink' });
  const state = await memory.snapshot();
  assert.equal(state.counts.facts, 1);
  assert.match(state.factsText, /喜欢茶/u);
  assert.equal((await memory.graph.readGraph()).entities.some(entity => entity.observations.some(value => value.includes('喜欢咖啡'))), false);
  assert.deepEqual(await memory.forget('drink'), { forgotten: 1 });
  assert.deepEqual(await memory.retrieve('茶'), []);
});

test('editor replaces pinned facts only, and result limits include pinned facts', async t => {
  const { memory } = await fixture(t);
  await memory.rememberFact('喜欢读书', { source: 'user-chat', pinned: false });
  await memory.replaceFacts('叫我小龙\n喜欢蓝色');
  await memory.replaceFacts('叫我小龙');
  const state = await memory.snapshot();
  assert.equal(state.counts.facts, 2);
  assert.equal(state.counts.pinned, 1);
  const results = await memory.retrieve('读书', { limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].pinned, true);
  assert.equal(state.factsText, '叫我小龙');
});

test('secrets and encoded media are declined or redacted from graph and chat files', async t => {
  const { memory } = await fixture(t);
  const key = 'sk-DO_NOT_STORE_THIS_SECRET_12345';
  assert.equal((await memory.rememberFact('我的密钥是' + key)).stored, false);
  assert.equal((await memory.rememberFact('data:image/png;base64,' + 'a'.repeat(500))).stored, false);
  await memory.rememberTurn('我的密码是secret123。其他内容正常。', 'API key=' + key);
  const disk = await fs.readFile(memory.chatsFile, 'utf8');
  assert.equal(disk.includes(key), false);
  assert.equal(disk.includes('secret123'), false);
  assert.equal(disk.includes('其他内容正常'), true);
});

test('bounded turns and graph eviction use actual graph/index removal', async t => {
  const { memory } = await fixture(t, { maxFacts: 2, maxEpisodes: 2 });
  await memory.rememberFact('低优先级猫', { source: 'user-chat', pinned: false, importance: 0.1 });
  await memory.rememberFact('重要狗', { source: 'user-chat', pinned: false, importance: 0.9 });
  await memory.rememberFact('置顶鲸鱼', { pinned: true });
  for (let i = 0; i < 3; i++) await memory.rememberTurn(`第${i}回合`, `回答${i}`);
  const snapshot = await memory.snapshot();
  assert.equal(snapshot.counts.facts, 2);
  assert.equal(snapshot.counts.episodes, 2);
  assert.equal(snapshot.text.includes('低优先级猫'), false);
  assert.equal((await memory.graph.readGraph()).entities.length, 3);
});

test('consolidation uses host stream, validates user evidence, and returns real usage', async t => {
  const recorded = [];
  const { memory } = await fixture(t, { onUsage: usage => recorded.push(usage) });
  const turn = await memory.rememberTurn('请记住我喜欢喝无糖咖啡。', '助手虚构：你喜欢蹦极。');
  const usage = { inputTokens: 120, outputTokens: 70, totalTokens: 190 };
  const llm = extractor(context => ({ facts: [
    { text: '用户喜欢无糖咖啡', slot: 'drink', kind: 'preference', importance: 0.9, keywords: ['咖啡'], evidence: { turnId: context.turns[0].id, quote: '我喜欢喝无糖咖啡' } },
    { text: '用户喜欢蹦极', slot: 'sport', kind: 'preference', importance: 1, evidence: { turnId: turn.id, quote: '你喜欢蹦极' } },
  ], replaceSlots: [] }), { usage });
  const result = await memory.consolidate(llm, route);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(recorded, [usage]);
  assert.deepEqual(llm.calls[0].tools, []);
  assert.equal(llm.calls[0].sessionId, undefined);
  const state = await memory.snapshot();
  assert.match(state.text, /无糖咖啡/u);
  assert.equal(state.text.includes('蹦极'), false);
  assert.equal(state.facts[0].provenance.turnId, turn.id);
  assert.equal((await memory.consolidate(llm, route)).pending, 0);
  assert.equal(llm.calls.length, 1);
});

test('learned slot changes require an explicit evidenced correction', async t => {
  const { memory } = await fixture(t);
  await memory.rememberFact('用户喜欢咖啡', { slot: 'drink' });
  await memory.rememberTurn('我现在不再喝咖啡，改成喝茶。', '明白。');
  const llm = extractor(context => ({ facts: [{ text: '用户现在喝茶', slot: 'drink', kind: 'preference', importance: 0.9,
    evidence: { turnId: context.turns[0].id, quote: '我现在不再喝咖啡，改成喝茶' } }], replaceSlots: ['drink'] }));
  assert.equal((await memory.consolidate(llm, route)).updated, 1);
  assert.equal((await memory.snapshot()).counts.facts, 1);
  assert.equal((await memory.snapshot()).counts.pinned, 1);
  assert.match((await memory.summary()).text, /喝茶/u);
});

test('forget removes a learned fact and its evidence episode so retrieval cannot revive it', async t => {
  const { memory } = await fixture(t);
  await memory.rememberTurn('记住我喜欢无糖咖啡。', '我记住了。');
  const llm = extractor(context => ({ facts: [{ text: '用户喜欢无糖咖啡', slot: 'drink', kind: 'preference',
    evidence: { turnId: context.turns[0].id, quote: '我喜欢无糖咖啡' } }], replaceSlots: [] }));
  await memory.consolidate(llm, route);
  const result = await memory.forget('drink');
  assert.equal(result.forgotten, 2);
  assert.deepEqual(await memory.retrieve('咖啡'), []);
  assert.equal((await memory.snapshot()).pendingTurns, 0);
});

test('clear during an extraction prevents forgotten data from returning after restart', async t => {
  const { memory, directory } = await fixture(t);
  await memory.rememberTurn('记住我喜欢鲸鱼。', '好的。');
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const llm = extractor(context => ({ facts: [{ text: '喜欢鲸鱼', slot: 'pet', evidence: { turnId: context.turns[0].id, quote: '我喜欢鲸鱼' } }], replaceSlots: [] }), { wait });
  const pending = memory.consolidate(llm, route);
  while (!llm.calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  await memory.clear();
  release();
  assert.equal((await pending).added, 0);
  assert.equal((await memory.snapshot()).counts.facts, 0);
  const restarted = new CompanionMemory(directory);
  await restarted.ready;
  assert.deepEqual((await restarted.snapshot()).counts, { facts: 0, pinned: 0, episodes: 0 });
  assert.deepEqual(await restarted.retrieve('鲸鱼'), []);
});

test('malformed extraction and provider errors add no fabricated facts', async t => {
  const { memory } = await fixture(t);
  await memory.rememberTurn('你好', '你好');
  const result = await memory.consolidate(extractor('not json'), route);
  assert.equal(result.error, 'invalid_extraction');
  assert.equal((await memory.snapshot()).counts.facts, 0);
  const failed = await memory.consolidate(extractor({ facts: [], replaceSlots: [] }, { kind: 'error' }), route);
  assert.equal(failed.error, 'model_extraction_failed');
});
