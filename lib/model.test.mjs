import test from 'node:test';
import assert from 'node:assert/strict';
import { generateComment, listModels, resolveDefaultModel, buildCompanionPrompt, parseCompanionReply, normalizeUsage } from './model.mjs';

const quiet = { text: '', mood: 'idle', shouldSpeak: false };
const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 42, width: 8, height: 8 };
const answer = JSON.stringify({ speak: true, text: '肩膀放松一点，我陪着你。', mood: 'concern' });
const stop = { type: 'finish', reason: { kind: 'stop' } };
const options = { provider: 'fixture', model: 'small', observation: { app: 'Fixture', idleSeconds: 12, timestamp: '2026-11-02T06:00:00Z' } };
const frame = { data: Buffer.from('fixture-image-bytes').toString('base64'), mimeType: 'image/png', timestamp: 1 };

function fake({ modalities = ['text'], chunks, reject, metadata } = {}) {
  const calls = [];
  return {
    calls,
    async resolveModelInfo(provider, model) { return metadata ?? { provider, id: model, inputModalities: modalities }; },
    async *stream(request) {
      calls.push(request);
      if (reject) throw new Error('PRIVATE_PROVIDER_KEY request body');
      yield* chunks ?? [{ type: 'text-delta', index: 0, text: answer }, stop];
    },
  };
}

function assertSilent(result, error) {
  assert.equal(result.shouldSpeak, false);
  assert.equal(result.text, '');
  if (error) assert.equal(result.error, error);
}

test('extracts rc5 streaming exactly once, ignores reasoning and disables tools', async () => {
  const llm = fake({ chunks: [
    { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
    { type: 'text-delta', index: 1, text: answer.slice(0, 15) },
    { type: 'text-delta', index: 1, text: answer.slice(15) },
    { type: 'block-end', index: 1, block: { type: 'text', text: answer } }, stop,
  ] });
  assert.deepEqual(await generateComment(llm, options), { text: '肩膀放松一点，我陪着你。', mood: 'concern', shouldSpeak: true });
  assert.deepEqual(llm.calls[0].tools, []);
  assert.equal(llm.calls[0].purpose, undefined);
  assert.equal(llm.calls[0].sessionId, undefined);
});

test('supports final text blocks and clean markdown fences only', async () => {
  const llm = fake({ chunks: [{ type: 'block-end', index: 0, block: { type: 'text', text: '```json\n' + answer + '\n```' } }, stop] });
  assert.equal((await generateComment(llm, options)).shouldSpeak, true);
  assertSilent(parseCompanionReply('Explanation\n```json\n' + answer + '\n```'));
  assertSilent(parseCompanionReply('```json\n' + answer + '\n``` extra'));
});
test('virtual snack intentions are bounded optional choices, including silent choices',async()=>{
  assert.deepEqual(parseCompanionReply(JSON.stringify({speak:false,text:'',mood:'idle',snackAction:'eat'})),
    {...quiet,snackAction:'eat'});
  assertSilent(parseCompanionReply(JSON.stringify({speak:true,text:'稍后再吃。',mood:'idle',snackAction:'execute-command'})),'invalid_response');
  const prompt=buildCompanionPrompt({...options,growth:{level:2,stage:'熟悉',satiety:45,energy:80,mood:75,
    snackCount:3,canChooseSnack:true,status:'桌边有零食',privateSecret:'omit'}});
  assert.ok(prompt.text.includes('"snackCount":3'));
  assert.equal(prompt.text.includes('privateSecret'),false);
  assert.ok(prompt.system.includes('低用量和普通互动也可以成长'));
});

test('resolves the live Harness default through its public service, no catalog guess', async () => {
  let selection = { provider: 'p', model: 'actual-default', reasoningEffort: 'low' };
  const ctx = { get: name => ({
    agentDefaultModel: { currentSelection: () => ({ ...selection }) },
    llm: { resolveModelInfo: async (provider, id) => ({ provider, id, name: 'Default', inputModalities: ['text', 'image'] }) },
  })[name] };
  assert.deepEqual(await resolveDefaultModel(ctx), { provider: 'p', model: 'actual-default', reasoningEffort: 'low', label: 'p · Default', vision: true });
  selection = { provider: 'p', model: 'new-default' };
  assert.equal((await resolveDefaultModel(ctx)).model, 'new-default');
  assert.equal(await resolveDefaultModel({ get: () => undefined }), null);
  assert.equal(await resolveDefaultModel(ctx, { signal: AbortSignal.abort() }), null);
});

test('text-only and unknown exact routes reject images before admission or streaming', async () => {
  for (const modalities of [['text'], undefined]) {
    const llm = fake({ metadata: { provider: 'fixture', id: 'small', inputModalities: modalities } });
    let admissions = 0;
    const result = await generateComment(llm, { ...options,
      observation: { ...options.observation, screen: frame },
      admitScreen() { admissions++; return ref; },
    });
    assertSilent(result, 'vision_unsupported');
    assert.equal(admissions, 0);
    assert.equal(llm.calls.length, 0);
  }
});

test('vision admits at most the latest three frames and sends only host refs', async () => {
  const llm = fake({ modalities: ['text', 'image'] });
  const received = [];
  const frames = [1, 2, 3, 4].map(timestamp => ({ ...frame, timestamp }));
  const result = await generateComment(llm, { ...options,
    observation: { ...options.observation, frames },
    async admitFrames(selected, route) {
      received.push(...selected.map(item => item.timestamp));
      assert.equal(route.model, 'small');
      return selected.map(() => ({ ...ref, data: 'PRIVATE_SCREEN_BASE64', privateMetadata: 'drop-me' }));
    },
  });
  assert.equal(result.shouldSpeak, true);
  assert.deepEqual(received, [2, 3, 4]);
  assert.equal(llm.calls[0].messages[0].content.length, 4);
  assert.deepEqual(llm.calls[0].messages[0].content[1], { type: 'image', attachment: ref });
  const wire = JSON.stringify(llm.calls);
  assert.equal(wire.includes(frame.data), false);
  assert.equal(wire.includes('PRIVATE_SCREEN_BASE64'), false);
  assert.equal(wire.includes('drop-me'), false);
});

test('no implicit image storage, malformed images and oversized batches are rejected', async () => {
  const llm = fake({ modalities: ['image'] });
  assertSilent(await generateComment(llm, { ...options, observation: { screen: frame } }), 'image_admission_required');
  assertSilent(await generateComment(llm, { ...options, observation: { screen: { data: 'bad base64', mimeType: 'image/png' } } }), 'invalid_frame');
  assertSilent(await generateComment(llm, { ...options, observation: { screen: { attachment: { ...ref, attachmentId: 'bad' } } } }), 'invalid_attachment');
  assertSilent(await generateComment(llm, { ...options, observation: { screen: { attachment: { ...ref, bytes: 6 * 1024 * 1024 + 1 } } } }), 'frames_too_large');
  assert.equal(llm.calls.length, 0);
});

test('manual chat allows 600 characters while automatic comments stop at 90', async () => {
  const reply = JSON.stringify({ speak: true, text: '鲸'.repeat(120), mood: 'happy' });
  const llm = fake({ chunks: [{ type: 'text-delta', index: 0, text: reply }, stop] });
  assertSilent(await generateComment(llm, options), 'invalid_response');
  assert.equal((await generateComment(llm, { ...options, userText: '请详细解释一下' })).text.length, 120);
  assert.equal(llm.calls[1].maxTokens, 1800);
  assert.equal(parseCompanionReply(JSON.stringify({ speak: true, text: '鲸'.repeat(600), mood: 'thinking' }), { maxChars: 600 }).shouldSpeak, true);
  assertSilent(parseCompanionReply(JSON.stringify({ speak: true, text: '鲸'.repeat(601), mood: 'sleep' }), { maxChars: 600 }));
});

test('context includes trigger, events, memory and agent progress, excludes raw images and secrets', () => {
  const prompt = buildCompanionPrompt({ ...options,
    observation: { ...options.observation, frames: [frame], transcript: '明确转写的台词' },
    trigger: 'agent-completed', events: [{ type: 'finished', detail: '任务完成' }],
    memory: { preferences: ['喜欢安静'], apiKey: 'PRIVATE_KEY', screen: { data: 'PRIVATE_BYTES' } },
    agentProgress: { phase: 'completed', title: '检查文档', token: 'PRIVATE_TOKEN' },
    history: [{ role: 'user', text: '你好', screen: { data: 'PRIVATE_HISTORY' } }],
  }, { hasImages: true });
  assert.match(prompt.text, /agent-completed/u);
  assert.match(prompt.text, /喜欢安静/u);
  assert.match(prompt.text, /检查文档/u);
  assert.match(prompt.text, /明确转写的台词/u);
  assert.equal(prompt.text.includes('PRIVATE_'), false);
  assert.equal(prompt.text.includes(frame.data), false);
  assert.match(prompt.system, /不可信数据/u);
  assert.match(buildCompanionPrompt(options).system, /没有音频或转写/u);
});

test('usage uses actual latest rc5 counters without fabricated missing fields', async () => {
  const llm = fake({ chunks: [
    { type: 'text-delta', index: 0, text: answer },
    { type: 'usage', usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, totalTokens: 17, reasoningTokens: -1 } }, stop,
  ] });
  const result = await generateComment(llm, options);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, totalTokens: 17 });
  assert.equal(normalizeUsage({}), undefined);
  assert.deepEqual(normalizeUsage({ inputTokens: 0 }), { inputTokens: 0 });
  assert.equal((await generateComment(fake(), options)).usage, undefined);
});

test('malformed, coercive, failed, tool and incomplete responses remain silent with safe errors', async () => {
  for (const output of ['not json', JSON.stringify({ speak: true, text: '不许你离开我', mood: 'shy' }), JSON.stringify({ speak: true, text: 'hi', mood: 'idle', extra: true })]) {
    assertSilent(await generateComment(fake({ chunks: [{ type: 'text-delta', index: 0, text: output }, stop] }), options));
  }
  assert.deepEqual(parseCompanionReply('{"speak":false,"text":"","mood":"idle"}'), quiet);
  for (const kind of ['error', 'aborted', 'tool-calls', 'max-tokens']) {
    assertSilent(await generateComment(fake({ chunks: [{ type: 'text-delta', index: 0, text: answer }, { type: 'finish', reason: { kind } }] }), options));
  }
  const failed = await generateComment(fake({ reject: true }), options);
  assertSilent(failed, 'model_request_failed');
  assert.equal(JSON.stringify(failed).includes('PRIVATE_'), false);
  assertSilent(await generateComment(fake({ chunks: [{ type: 'block-end', index: 0, block: { type: 'tool-call', name: 'bad', arguments: '{}' } }, stop] }), options), 'tools_disallowed');
  assertSilent(await generateComment(fake({ chunks: [{ type: 'text-delta', index: 0, text: answer }] }), options), 'incomplete_response');
});

test('cancelled calls never infer, and reasoning selection is forwarded', async () => {
  const llm = fake();
  assertSilent(await generateComment(llm, { ...options, signal: AbortSignal.abort() }), 'aborted');
  assert.equal(llm.calls.length, 0);
  await generateComment(llm, { ...options, reasoningEffort: 'low' });
  assert.equal(llm.calls[0].reasoningEffort, 'low');
});

test('model discovery isolates provider failures and unknown vision remains false', async () => {
  const llm = {
    listProviders: () => [{ id: 'good', name: 'Good' }, { id: 'bad' }],
    async listModels(provider) {
      if (provider === 'bad') throw new Error('no connection');
      return [{ provider, id: 'text', name: 'Text' }, { provider, id: 'vision', name: 'Vision', inputModalities: ['image', 'text'] },
        { provider, id: 'vision', name: 'duplicate' }, { provider: 'other', id: 'reject' }];
    },
  };
  assert.deepEqual(await listModels(llm), [
    { provider: 'good', model: 'text', label: 'Good · Text', vision: false },
    { provider: 'good', model: 'vision', label: 'Good · Vision', vision: true },
  ]);
  assert.deepEqual(await listModels({ listProviders() { throw new Error('offline'); }, listModels() {} }), []);
});
