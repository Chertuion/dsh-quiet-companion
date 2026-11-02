import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachTokenUsage,reportedAgentUsage } from './token-snacks.mjs';

function fixture(callback) {
  const events=new EventEmitter(),received=[];
  const ctx={on(name,listener){events.on(name,listener);return()=>events.off(name,listener);},
    get(){throw new Error('History or inventory must not be consulted');}};
  const dispose=attachTokenUsage(ctx,value=>{received.push(value);return callback?.(value);});
  const emit=(session,type,data,seq)=>events.emit('session/event',session,{type,data,seq});
  return {events,received,dispose,emit};
}
const usage={inputTokens:10,outputTokens:3,cacheReadTokens:4,cacheWriteTokens:2,reasoningTokens:2,totalTokens:19};
test('rc5 live assistant settlements report actual disjoint totals without text, names or identifiers',async t=>{
  const f=fixture();t.after(f.dispose);
  const data={turn:1,step:1,usage};
  Object.defineProperty(data,'message',{get(){throw new Error('Message text must not be read');}});
  Object.defineProperty(data,'stream',{get(){throw new Error('Direct usage needs no stream');}});
  f.emit({id:'private-session-name',firstLiveSeq:0},'assistant/message',data,3);
  assert.equal(f.received.length,1);assert.deepEqual(f.received[0].usage,usage);
  assert.equal(f.received[0].totalTokens,19);assert.equal(f.received[0].source,'agent');
  assert.match(f.received[0].id,/^agent-[a-f0-9]{40}$/);
  assert.equal(JSON.stringify(f.received).includes('private-session-name'),false);
});
test('attachment never replays history and ignores seed or duplicate sequence and same-attempt events',async t=>{
  const f=fixture();t.after(f.dispose);const s={id:'s',firstLiveSeq:5};
  assert.equal(f.received.length,0);
  f.emit(s,'assistant/message',{turn:1,step:1,usage},4);
  f.emit(s,'assistant/message',{turn:1,step:1,usage},6);
  f.emit(s,'assistant/message',{turn:1,step:1,usage},6);
  f.emit(s,'step/end',{turn:1,step:1,usage},7);
  f.emit(s,'assistant/message',{turn:1,step:2,usage},8);
  assert.equal(f.received.length,2);
});
test('all Host sessions and subagents count independently with turn/step fallback',async t=>{
  const f=fixture();t.after(f.dispose);
  for(const id of ['parent','child']) {
    f.emit({id},'assistant/message',{turn:1,step:1,usage});
    f.emit({id},'assistant/message',{turn:1,step:1,usage});
  }
  assert.equal(f.received.length,2);assert.notEqual(f.received[0].id,f.received[1].id);
});
test('retry settlements count separately and inspect only the last reported usage chunk',async t=>{
  const f=fixture();t.after(f.dispose);const s={id:'retry'};
  const stream=[{type:'text-chunks',get texts(){throw new Error('Never read text chunks');}},
    {type:'chunk',chunk:{type:'usage',usage:{totalTokens:5}}},{type:'chunk',chunk:{type:'usage',usage:{totalTokens:7}}}];
  f.emit(s,'assistant/attempt',{turn:1,step:1,stream},2);
  f.emit(s,'llm/retry-started',{turn:1,step:1},3);
  f.emit(s,'llm/retry-started',{turn:1,step:1},3);
  f.emit(s,'assistant/message',{turn:1,step:1,usage:{totalTokens:11}},4);
  assert.deepEqual(f.received.map(item=>item.totalTokens),[7,11]);
});
test('missing counters remain unknown and reasoning never inflates output',()=>{
  assert.deepEqual(reportedAgentUsage({inputTokens:10,outputTokens:3,reasoningTokens:8}),{inputTokens:10,outputTokens:3,reasoningTokens:8});
  assert.deepEqual(reportedAgentUsage({inputTokens:10,outputTokens:3,cacheReadTokens:4,cacheWriteTokens:2,reasoningTokens:8}),
    {inputTokens:10,outputTokens:3,cacheReadTokens:4,cacheWriteTokens:2,reasoningTokens:8,totalTokens:19});
  assert.equal(reportedAgentUsage({totalTokens:NaN,inputTokens:-1}),null);
  assert.deepEqual(reportedAgentUsage({totalTokens:17,inputTokens:10,outputTokens:3}),{inputTokens:10,outputTokens:3,totalTokens:17});
});
test('plain rc5 step/end and non-usage events never invent food',async t=>{
  const f=fixture();t.after(f.dispose);const s={id:'s'};
  f.emit(s,'step/end',{turn:1,step:1},1);
  f.emit(s,'tool/call',{turn:1,step:1,arguments:'ignored',usage},2);
  f.emit(s,'assistant/message',{turn:1,step:2,usage:{inputTokens:10}},3);
  assert.equal(f.received.length,1);assert.equal(f.received[0].totalTokens,null);
  assert.deepEqual(f.received[0].usage,{inputTokens:10});
});
test('callback failures are contained and async disposal removes the subscription',async()=>{
  const f=fixture(()=>Promise.reject(new Error('observer fixture failure')));
  assert.doesNotThrow(()=>f.emit({id:'s'},'assistant/message',{turn:1,step:1,usage},1));
  await f.dispose();assert.equal(f.events.listenerCount('session/event'),0);
  f.emit({id:'s'},'assistant/message',{turn:1,step:2,usage},2);assert.equal(f.received.length,1);
});
