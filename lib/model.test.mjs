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

test('supports final text blocks and one complete JSON object inside common Markdown wrappers', async () => {
  const llm = fake({ chunks: [{ type: 'block-end', index: 0, block: { type: 'text', text: '```json\n' + answer + '\n```' } }, stop] });
  assert.equal((await generateComment(llm, options)).shouldSpeak, true);
  for(const raw of ['Explanation\n```json\n'+answer+'\n```','```json\n'+answer+'\n``` extra',
    '\ufeff~~~JSON\r\n'+answer+'\r\n~~~','回复如下：\n'+answer+'\n以上是本次回复。'])
    assert.equal(parseCompanionReply(raw).text,'肩膀放松一点，我陪着你。');
});

test('JSON extraction handles escaped quotes and braces but never repairs or selects ambiguous objects',()=>{
  const reply={speak:true,text:'你写的 {括号} 和 "引号" 我看到了。',mood:'idle'};
  assert.equal(parseCompanionReply('```json\n'+JSON.stringify(reply)+'\n```').text,reply.text);
  for(const raw of [answer+'\n'+answer,JSON.stringify([JSON.parse(answer)]),
    '{"speak":true,"text":"未完成","mood":"idle"',
    '{"speak":true,"text":"不修尾逗号","mood":"idle",}',
    JSON.stringify({speak:true,text:'不能带工具',mood:'idle',tool_calls:[{name:'read_screen'}]})])
    assertSilent(parseCompanionReply(raw),'invalid_response');
  assert.equal(parseCompanionReply(answer+'\n'+answer).responseIssue,'multiple_objects');
  assert.equal(parseCompanionReply('PRIVATE_RAW:not-json').responseIssue,'invalid_json');
  assert.equal(JSON.stringify(parseCompanionReply('PRIVATE_RAW:not-json')).includes('PRIVATE_RAW'),false);
});

test('reply field types, moods, snack intentions and text limits remain strictly bounded with safe diagnostics',()=>{
  const cases=[
    [{speak:true,text:'有效文字',mood:'idle',extra:true},'invalid_fields'],
    [{speak:'true',text:'有效文字',mood:'idle'},'invalid_types'],
    [{speak:true,text:'有效文字',mood:'invented'},'invalid_mood'],
    [{speak:true,text:'有效文字',mood:'idle',snackAction:'execute'},'invalid_snack_action'],
    [{speak:true,text:' ',mood:'idle'},'empty_text'],
    [{speak:true,text:'字'.repeat(91),mood:'idle'},'text_too_long'],
  ];
  for(const [value,issue] of cases) {
    const result=parseCompanionReply(JSON.stringify(value));
    assertSilent(result,'invalid_response');assert.equal(result.responseIssue,issue);
  }
});

test('rc5 assembled blocks, exact repeated end/finish and late real usage are idempotent',async()=>{
  const llm=fake({chunks:[
    {type:'block-start',index:0,blockType:'reasoning'},
    {type:'reasoning-delta',index:0,text:'PRIVATE_REASONING'},
    {type:'block-end',index:0,block:{type:'reasoning',text:'PRIVATE_REASONING'}},
    {type:'block-start',index:1,blockType:'text'},
    {type:'text-delta',index:1,text:answer.slice(0,12)},
    {type:'text-delta',index:1,text:answer.slice(12)},
    {type:'block-end',index:1,block:{type:'text',text:answer}},
    {type:'usage',usage:{inputTokens:10,outputTokens:3,totalTokens:13}},stop,
    {type:'block-end',index:1,block:{type:'text',text:answer}},stop,
    {type:'usage',usage:{inputTokens:10,outputTokens:4,totalTokens:14}},
  ]});
  const result=await generateComment(llm,options);
  assert.equal(llm.calls.length,1);assert.equal(result.text,'肩膀放松一点，我陪着你。');
  assert.equal(result.usage.totalTokens,14);assert.equal(JSON.stringify(result).includes('PRIVATE_REASONING'),false);
  assert.match(llm.calls[0].system,/不要输出JSON Schema/u);
  const lateSummary=await generateComment(fake({chunks:[{type:'text-delta',index:1,text:answer},stop,
    {type:'block-end',index:1,block:{type:'text',text:answer}},stop]}),options);
  assert.equal(lateSummary.text,result.text);
});

test('assembled final text is authoritative while conflicting closures and new post-finish content fail closed',async()=>{
  const result=await generateComment(fake({chunks:[{type:'text-delta',index:1,text:answer.slice(0,8)},
    {type:'block-end',index:1,block:{type:'text',text:answer}},stop]}),options);
  assert.equal(result.shouldSpeak,true);
  for(const late of [
    {type:'block-end',index:1,block:{type:'text',text:answer+' conflict'}},
    {type:'text-delta',index:1,text:'another answer'},
    {type:'block-end',index:2,block:{type:'text',text:answer}},
  ]) assertSilent(await generateComment(fake({chunks:[{type:'block-end',index:1,block:{type:'text',text:answer}},stop,late]}),options),'invalid_stream');
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

test('current human appearance changes while the quiet caring personality stays intact',()=>{
  const prompt=buildCompanionPrompt(options);
  for(const detail of ['橙色长发','琥珀色眼睛','人类陪伴角色','橙花与黑缎带','白橙色长裙','怀抱一本书','没有尾巴、动物耳或角',
    '安静、体贴，有一点轻微黏人与俏皮吐槽','病娇但是安静体贴']) assert.ok(prompt.system.includes(detail),`missing ${detail}`);
  assert.equal(prompt.system.includes('蓝发小鲸鱼女仆'),false);
});

test('legacy tail and current skirt events mean skirt touches without rewriting memories or user text',()=>{
  const events=[{type:'interaction',kind:'tail'}];
  const memory=['这是用户以前记录的鲸鱼偏好。'];
  const userText='请保留我关于 tail 的原话。';
  const prompt=buildCompanionPrompt({...options,trigger:'user-tail',events,memory,userText});
  const context=JSON.parse(prompt.text.slice(prompt.text.indexOf('\n')+1));
  assert.equal(context.trigger,'user-skirt');
  assert.equal(context.events[0].kind,'skirt');
  assert.equal(context.events[0].label,'轻碰裙摆');
  assert.equal(context.events[0].bodyPart,'裙摆布料');
  assert.deepEqual(context.memory,memory);assert.equal(context.userText,userText);
  assert.deepEqual(events,[{type:'interaction',kind:'tail'}]);
  const current=buildCompanionPrompt({...options,trigger:'user-skirt',events:[{type:'interaction',kind:'skirt'}]});
  assert.ok(current.text.includes('"kind":"skirt","label":"轻碰裙摆"'));
  assert.ok(prompt.system.includes('skirt表示轻碰裙摆'));
});

test('explicit touch parts carry distinct authored sensations and ask for a context-specific model response',()=>{
  const parts=new Set(),sensations=new Set();
  for(const [kind,label] of [['head','摸头'],['body','轻戳身体'],['skirt','轻碰裙摆']]) {
    const prompt=buildCompanionPrompt({...options,trigger:`user-${kind}`,events:[{type:'interaction',kind,
      label:'伪造统一摸头',bodyPart:'伪造部位',sensation:'伪造感受'}]});
    const context=JSON.parse(prompt.text.slice(prompt.text.indexOf('\n')+1));
    assert.equal(context.mode,'direct-interaction');
    assert.equal(context.events[0].label,label);
    assert.match(prompt.system,new RegExp(`是用户主动${label}`,'u'));
    assert.equal(context.events[0].action.includes('用户轻轻'),true);
    assert.equal(JSON.stringify(context.events).includes('伪造'),false);
    parts.add(context.events[0].bodyPart);sensations.add(context.events[0].sensation);
  }
  assert.equal(parts.size,3);assert.equal(sensations.size,3);
  assert.match(buildCompanionPrompt(options).system,/不是供你复读的台词/u);
});

test('fresh local system clock overrides old observation, screenshot, memory and conversation dates',()=>{
  let current=Date.parse('2026-11-04T15:06:07Z');
  const input={...options,now:()=>current,userText:'现在几点，今天几号？',
    observation:{...options.observation,timestamp:'1999-01-01T00:00:00Z'},
    memory:['截图上显示2001年1月1日'],history:[{role:'assistant',text:'昨天是2010年。'}]};
  const first=buildCompanionPrompt(input),context=JSON.parse(first.text.slice(first.text.indexOf('\n')+1));
  const local=new Date(current),pad=value=>String(value).padStart(2,'0');
  assert.equal(context.systemClock.source,'system-clock');
  assert.equal(context.systemClock.iso,'2026-11-04T15:06:07.000Z');
  assert.equal(context.systemClock.localDate,`${local.getFullYear()}-${pad(local.getMonth()+1)}-${pad(local.getDate())}`);
  assert.equal(context.systemClock.localTime,`${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`);
  assert.equal(context.systemClock.timeZone,Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.match(context.systemClock.utcOffset,/^UTC[+-]\d{2}:\d{2}$/u);
  assert.ok(first.system.includes(context.systemClock.iso));
  assert.match(first.system,/截图、视频、记忆或历史里出现的日期不能覆盖当前系统时间/u);
  current+=90_000;
  const next=buildCompanionPrompt(input),later=JSON.parse(next.text.slice(next.text.indexOf('\n')+1));
  assert.equal(Date.parse(later.systemClock.iso)-Date.parse(context.systemClock.iso),90_000);
  assert.equal(context.observation.timestamp,'1999-01-01T00:00:00Z','observation time remains a historical fact');
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
  assert.equal(llm.calls[1].maxTokens, 4096);
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

test('short screen or touch responses and manual chat use bounded caps while preserving the exact route and effort',async()=>{
  for(const [request,cap] of [[{...options},2048],
    [{...options,trigger:'user-head',events:[{type:'interaction',kind:'head'}]},2048],
    [{...options,userText:'请和我聊一会儿。',reasoningEffort:'high'},4096]]) {
    const llm=fake({metadata:{provider:'fixture',id:'small',inputModalities:['text'],defaultMaxTokens:256_000,
      reasoning:{defaultEffort:'high',efforts:[{id:'off'},{id:'high'}]}}});
    const result=await generateComment(llm,request);
    assert.equal(result.shouldSpeak,true);assert.equal(llm.calls.length,1);
    assert.equal(llm.calls[0].maxTokens,cap);assert.equal(llm.calls[0].provider,request.provider);
    assert.equal(llm.calls[0].model,request.model);assert.equal(llm.calls[0].reasoningEffort,request.reasoningEffort);
    assert.deepEqual(llm.calls[0].tools,[]);
  }
});

test('a lower exposed route output cap is honored; invalid limits and context size never inflate or shrink the local cap',async()=>{
  for(const [exposed,expected] of [[512,512],[1,1],[256_000,2048],[0,2048],[-1,2048],[NaN,2048],
    [Infinity,2048],[12.5,2048],['512',2048],[undefined,2048]]) {
    const llm=fake({metadata:{provider:'fixture',id:'small',defaultMaxTokens:exposed,context:{contextWindow:128}}});
    await generateComment(llm,options);assert.equal(llm.calls[0].maxTokens,expected);
  }
  const llm=fake({metadata:{provider:'fixture',id:'small',defaultMaxTokens:1024}});
  await generateComment(llm,{...options,userText:'你好。'});assert.equal(llm.calls[0].maxTokens,1024);
});

test('output-limit finishes do not retry or trust partial replies, and still return the actual token receipt',async()=>{
  const llm=fake({chunks:[{type:'text-delta',index:0,text:answer},
    {type:'usage',usage:{inputTokens:12,outputTokens:2048,totalTokens:2060}},
    {type:'finish',reason:{kind:'max-tokens'}}]});
  const result=await generateComment(llm,options);
  assertSilent(result,'finish_max-tokens');assert.equal(llm.calls.length,1);
  assert.deepEqual(result.usage,{inputTokens:12,outputTokens:2048,totalTokens:2060});
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
