import test from 'node:test';
import assert from 'node:assert/strict';
import { generateComment, listModels } from './model.mjs';

const quiet = { text: '', mood: 'idle', shouldSpeak: false };
const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 42, width: 8, height: 8 };
const answer = JSON.stringify({ speak: true, text: '肩膀放松一点，我陪着你。', mood: 'concern' });
const stop = { type: 'finish', reason: { kind: 'stop' } };
const options = { provider: 'fixture', model: 'small', observation: { app: 'Fixture', idleSeconds: 12, timestamp: '2026-11-02T06:00:00Z' } };

function fake({ modalities = ['text'], chunks, reject, metadata } = {}) {
  const calls = [];
  return {
    calls,
    async resolveModelInfo(provider, model) { return metadata ?? { provider, id: model, inputModalities: modalities }; },
    async *stream(request) {
      calls.push(request);
      if (reject) throw new Error('private provider error with request body');
      yield* chunks ?? [{ type: 'text-delta', index: 0, text: answer }, stop];
    },
  };
}

test('extracts rc5 text streaming once and ignores reasoning', async () => {
  const llm = fake({ chunks: [
    { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
    { type: 'text-delta', index: 1, text: answer.slice(0, 15) },
    { type: 'text-delta', index: 1, text: answer.slice(15) },
    { type: 'block-end', index: 1, block: { type: 'text', text: answer } },
    { type: 'usage', usage: {} }, stop,
  ] });
  assert.deepEqual(await generateComment(llm, options), { text: '肩膀放松一点，我陪着你。', mood: 'concern', shouldSpeak: true });
  assert.deepEqual(llm.calls[0].tools, []);
  assert.equal(llm.calls[0].purpose, undefined);
  assert.equal(llm.calls[0].sessionId, undefined);
});

test('supports final text blocks without duplicating delta content', async () => {
  const llm = fake({ chunks: [{ type: 'block-end', index: 0, block: { type: 'text', text: answer } }, stop] });
  assert.equal((await generateComment(llm, options)).shouldSpeak, true);
});

test('text-only and unknown routes never admit or transmit screenshots', async () => {
  for (const modalities of [['text'], undefined]) {
    const llm = fake({ metadata: { provider: 'fixture', id: 'small', inputModalities: modalities } });
    let admissions = 0;
    await generateComment(llm, { ...options,
      observation: { ...options.observation, screen: { data: 'PRIVATE_SCREEN_BASE64', mimeType: 'image/png' } },
      admitScreen() { admissions++; return ref; },
    });
    assert.equal(admissions, 0);
    assert.equal(llm.calls[0].messages[0].content.length, 1);
    assert.equal(JSON.stringify(llm.calls).includes('PRIVATE_SCREEN_BASE64'), false);
    assert.match(llm.calls[0].messages[0].content[0].text, /"screenAttached":false/u);
  }
});

test('vision gate uses exact metadata, and sends only rc5 attachment reference', async () => {
  const llm = fake({ modalities: ['text', 'image'] });
  let admissions = 0;
  const result = await generateComment(llm, { ...options,
    observation: { ...options.observation, screen: { data: 'PRIVATE_SCREEN_BASE64', mimeType: 'image/png' } },
    admitScreen(screen, route) {
      admissions++;
      assert.equal(screen.data, 'PRIVATE_SCREEN_BASE64');
      assert.equal(route.model, 'small');
      return { ...ref, data: screen.data, privateMetadata: 'drop-me' };
    },
  });
  assert.equal(result.shouldSpeak, true);
  assert.equal(admissions, 1);
  assert.deepEqual(llm.calls[0].messages[0].content[1], { type: 'image', attachment: ref });
  assert.equal(JSON.stringify(llm.calls).includes('PRIVATE_SCREEN_BASE64'), false);
  assert.equal(JSON.stringify(llm.calls).includes('drop-me'), false);
});

test('no implicit image storage callback or use of malformed refs', async () => {
  for (const screen of [{ data: 'NEVER_STORED', mimeType: 'image/png' }, { attachment: { ...ref, attachmentId: 'bad' } }]) {
    const llm = fake({ modalities: ['image'] });
    await generateComment(llm, { ...options, observation: { ...options.observation, screen } });
    assert.equal(llm.calls[0].messages[0].content.length, 1);
    assert.equal(JSON.stringify(llm.calls).includes('NEVER_STORED'), false);
  }
});

test('malformed, overlong, coercive and failed results stay silent', async () => {
  const outputs = ['not json', '```json\n' + answer + '\n```',
    JSON.stringify({ speak: true, text: 'a'.repeat(56), mood: 'idle' }),
    JSON.stringify({ speak: true, text: '不许你离开我', mood: 'shy' }),
    JSON.stringify({ speak: true, text: 'hi', mood: 'idle', extra: true }),
    JSON.stringify({ speak: false, text: 'silence', mood: 'idle' }),
  ];
  for (const output of outputs) {
    assert.deepEqual(await generateComment(fake({ chunks: [{ type: 'text-delta', index: 0, text: output }, stop] }), options), quiet);
  }
  for (const kind of ['error', 'aborted', 'tool-calls', 'max-tokens']) {
    assert.deepEqual(await generateComment(fake({ chunks: [{ type: 'text-delta', index: 0, text: answer }, { type: 'finish', reason: { kind } }] }), options), quiet);
  }
  assert.deepEqual(await generateComment(fake({ reject: true }), options), quiet);
  assert.deepEqual(await generateComment(fake({ chunks: [{ type: 'text-delta', index: 0, text: answer }] }), options), quiet);
});

test('cancelled calls do not infer or admit images; history is text-only', async () => {
  const llm = fake({ modalities: ['image'] });
  assert.deepEqual(await generateComment(llm, { ...options, signal: AbortSignal.abort() }), quiet);
  assert.equal(llm.calls.length, 0);
  await generateComment(llm, { ...options, history: [{ role: 'user', text: '你好', screen: { data: 'PRIVATE' } }] });
  assert.equal(JSON.stringify(llm.calls).includes('PRIVATE'), false);
  assert.match(llm.calls[0].system, /不可信数据/u);
});

test('model discovery isolates provider failures and treats unknown vision as false', async () => {
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
