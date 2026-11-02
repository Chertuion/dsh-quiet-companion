/** Read-only, live-only Harness rc5 Agent token usage. Never reads message text or tool data. */
import { createHash } from 'node:crypto';

const FIELDS=['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'];
const CATEGORIES=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'];
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const hash=value=>createHash('sha256').update(value).digest('hex');

/** Missing categories stay absent; reasoning is already part of output, never added twice. */
export function reportedAgentUsage(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)) return null;
  const usage={};
  for(const key of FIELDS) if(count(value[key])!==null) usage[key]=value[key];
  if(!Object.keys(usage).length) return null;
  if(usage.totalTokens===undefined&&CATEGORIES.every(key=>usage[key]!==undefined)) {
    const total=CATEGORIES.reduce((sum,key)=>sum+usage[key],0);
    if(Number.isSafeInteger(total)) usage.totalTokens=total;
  }
  return usage;
}

function settlementUsage(event) {
  const direct=reportedAgentUsage(event.data?.usage);
  if(direct) return direct;
  // rc5 assistant/attempt retains the final usage chunk even when no visible
  // assistant message commits. Only type tags and numeric usage are inspected.
  if(event.type!=='assistant/message'&&event.type!=='assistant/attempt') return null;
  const stream=event.data?.stream;
  if(!Array.isArray(stream)) return null;
  for(let index=stream.length-1;index>=0;index--) {
    const record=stream[index];
    if(record?.type==='chunk'&&record.chunk?.type==='usage') return reportedAgentUsage(record.chunk.usage);
  }
  return null;
}

/**
 * Listen only to new session/event appends, covering all Host Agent scopes,
 * including subagents. No history, projections, Agent inventory or log files
 * are opened. rc5 puts usage on assistant/message (step/end has only turn/step);
 * explicit step/end usage is accepted for compatible future producers.
 * onUsage receives {id,usage,totalTokens:number|null,source:'agent'} with hashed
 * identifiers only. Same-attempt settlements are counted once; a real sequenced
 * llm/retry-started opens another attempt. Unknown totals never become rewards.
 */
export function attachTokenUsage(ctx,onUsage,{maxSessions=256,maxAttemptsPerSession=512}={}) {
  const limit=Number.isSafeInteger(maxSessions)?Math.min(4096,Math.max(1,maxSessions)):256;
  const attemptLimit=Number.isSafeInteger(maxAttemptsPerSession)?Math.min(8192,Math.max(4,maxAttemptsPerSession)):512;
  const records=new Map(),pending=new Set();
  let disposed=false,release,available=false;
  function receive(session,event) {
    if(disposed||!event||!['assistant/message','assistant/attempt','step/end','llm/retry-started'].includes(event.type)) return;
    try {
      const identity=session?.id;
      if(typeof identity!=='string'||!identity||identity.length>4096) return;
      const seq=count(event.seq),firstLive=count(session.firstLiveSeq);
      if(seq!==null&&firstLive!==null&&seq<firstLive) return;
      const sessionKey=hash(identity);
      let record=records.get(sessionKey);
      if(!record) {
        if(records.size>=limit) records.delete(records.keys().next().value);
        record={lastSeq:null,retries:new Map(),settled:new Set()};records.set(sessionKey,record);
      }
      if(seq!==null&&record.lastSeq!==null&&seq<=record.lastSeq) return;
      if(seq!==null) record.lastSeq=seq;
      const turn=count(event.data?.turn),step=count(event.data?.step);
      const stepKey=turn!==null&&step!==null?`${turn}:${step}`:null;
      if(event.type==='llm/retry-started') {
        if(seq!==null&&stepKey) {
          record.retries.set(stepKey,(record.retries.get(stepKey)||0)+1);
          while(record.retries.size>attemptLimit) record.retries.delete(record.retries.keys().next().value);
        }
        return;
      }
      const usage=settlementUsage(event);
      if(!usage) return;
      const attempt=stepKey?`${stepKey}:${record.retries.get(stepKey)||0}`:null;
      if(attempt&&record.settled.has(attempt)) return;
      if(seq===null&&!attempt) return; // An unidentifiable sample cannot be deduplicated safely.
      if(attempt) {
        record.settled.add(attempt);
        while(record.settled.size>attemptLimit) record.settled.delete(record.settled.values().next().value);
      }
      const id='agent-'+hash(`${sessionKey}\0${seq!==null?'seq:'+seq:'attempt:'+attempt}`).slice(0,40);
      const value={id,usage,totalTokens:usage.totalTokens??null,source:'agent'};
      try {
        const result=onUsage?.(value);
        if(result&&typeof result.then==='function') {
          const work=Promise.resolve(result).catch(()=>{});pending.add(work);
          void work.finally(()=>pending.delete(work));
        }
      } catch { /* Token observers must never break the committed Host append. */ }
    } catch { /* Malformed optional usage is unknown, never a fabricated count. */ }
  }
  if(typeof ctx?.on==='function') {
    try {
      const off=ctx.on('session/event',receive);
      release=typeof off==='function'?off:typeof ctx.off==='function'?()=>ctx.off('session/event',receive):null;
      available=true;
    } catch { /* The optional event source is absent in some compositions. */ }
  }
  const dispose=async()=>{
    if(disposed) return;
    disposed=true;
    try {if(release) await release();} finally {records.clear();await Promise.allSettled([...pending]);}
  };
  dispose.available=available;
  return dispose;
}
