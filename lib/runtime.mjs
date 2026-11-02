/** Companion orchestration: model replies, event-gated perception, remembered conversation and task facts. */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, normalizeSettings, metadataOnly, observationsAllowed, screenAllowed } from './controller.mjs';
import { resolveDefaultModel, generateComment } from './model.mjs';
import { AdaptiveEngine } from './adaptive.mjs';
import { attachAgentProgress } from './activity.mjs';
import { createStateStore } from './storage.mjs';
import { CompanionMemory } from './memory.mjs';
import { readBalance } from './balance.mjs';

const pairOf = route => route ? route.provider + '\u001f' + route.model : '';
const get = (ctx,key) => { try { return typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key]; } catch { return null; } };
const text = (value,max=4000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu,'').slice(0,max) : '';

export class CompanionRuntime {
  constructor(ctx,{send,stateDir,now=Date.now,defaultResolver=resolveDefaultModel,generate=generateComment}={}) {
    this.ctx=ctx; this.send=send; this.stateDir=stateDir; this.now=now;
    this.defaultResolver=defaultResolver; this.generate=generate;
    this.settings={...DEFAULT_SETTINGS}; this.route=null; this.disposed=false; this.initialized=false;
    this.frames=[]; this.latest=null; this.transcript=''; this.transcriptAt=0; this.lastTranscriptSegment='';
    this.history=[]; this.requests=new Set(); this.request=null; this.routeRefresh=null;
    this.generation=0; this.pendingStart=null; this.pendingDecision=null;
    this.agent={available:false,current:null,sessions:[],activeCount:0,waitingCount:0};
    this.balance={available:false,reason:'点击刷新后查询当前账户余额'};
    this.policy=new AdaptiveEngine({now,visualThreshold:0.06});
    this.ledger=createStateStore(join(stateDir,'usage'),{now,dayOffsetMinutes:-new Date().getTimezoneOffset()});
    this.memory=new CompanionMemory(join(stateDir,'memory'),{onUsage:usage=>this.recordUsage(usage)});
    this.ready=this.initialize();
  }
  emit(message) { if(!this.disposed) this.send(message); }
  status(value) { this.emit({type:'status',text:value}); }
  async initialize() {
    mkdirSync(this.stateDir,{recursive:true,mode:0o700});
    const file=join(this.stateDir,'settings.json');
    try { if(existsSync(file)) this.settings=normalizeSettings(JSON.parse(readFileSync(file,'utf8'))); }
    catch { this.status('设置读取失败，已暂停观察并使用默认配置。'); }
    await this.memory.ready;
    if(this.disposed) return;
    await this.refreshRoute();
    if(this.disposed) return;
    this.progressDisposer=attachAgentProgress(this.ctx,snapshot=>{
      this.agent=snapshot;
      if(this.settings.agentProgressEnabled) this.emit({type:'agent',...snapshot});
      if(this.initialized) this.evaluate();
    },{now:this.now});
    if(typeof this.ctx?.on==='function') {
      try { this.configDisposer=this.ctx.on('loader/volatile-update',()=>{ void this.refreshRoute().catch(()=>{}); }); }
      catch { /* Optional service change notification; each event still resolves the live default. */ }
    }
    this.initialized=true;
    this.publishSettings(); this.publishUsage(); await this.publishMemory();
  }
  persistSettings() {
    const staging=join(this.stateDir,`.settings-${randomUUID()}.tmp`);
    writeFileSync(staging,JSON.stringify(this.settings,null,2)+'\n',{mode:0o600});
    renameSync(staging,join(this.stateDir,'settings.json'));
  }
  publishSettings() { this.emit({type:'settings',settings:this.settings}); }
  async refreshRoute(forcePublish=false) {
    if(this.routeRefresh) return this.routeRefresh;
    this.routeRefresh=(async()=>{
      const route=await this.defaultResolver(this.ctx);
      if(this.disposed) return null;
      const attachments=get(this.ctx,'attachments');
      const usableVision=Boolean(route?.vision && typeof attachments?.admitPromptContent==='function');
      const fingerprint=JSON.stringify([pairOf(route),usableVision,route?.label||'']);
      const changed=fingerprint!==this.routeFingerprint;
      const previous=pairOf(this.route) || pairOf(this.settings);
      if(previous && previous!==pairOf(route)) {
        this.cancel(); this.clearFrames(); this.clearTranscript();
        this.settings.screenEnabled=false; this.settings.videoAudioEnabled=false;
        this.settings.consentPair=''; this.settings.audioConsentPair='';
      }
      this.route=route;
      this.routeFingerprint=fingerprint;
      if(!usableVision && this.settings.screenEnabled) {
        this.cancel(); this.clearFrames(); this.settings.screenEnabled=false; this.settings.consentPair='';
      }
      this.settings=normalizeSettings({...this.settings,provider:route?.provider||'',model:route?.model||''});
      if(changed||forcePublish) {
        this.emit({type:'models',models:route?[{...route,vision:usableVision}]:[],
          defaultProvider:route?.provider||'',defaultModel:route?.model||''});
        this.publishSettings();
        this.status(route ? `跟随 Harness 默认模型：${route.label}。${usableVision?'画面理解可用；按需开启观察。':'此默认模型暂不支持画面，文字与本机音频转写仍可用。'}`
          : '请先在 Harness 中配置默认模型；宠物的模型回应会使用该配置。');
      }
      return route;
    })().finally(()=>{this.routeRefresh=null;});
    return this.routeRefresh;
  }
  prices() {
    return this.settings.inputPricePerMillion>0 && this.settings.outputPricePerMillion>0 ? {
      currency:'CNY',inputPerMillion:this.settings.inputPricePerMillion,outputPerMillion:this.settings.outputPricePerMillion,
    } : undefined;
  }
  budget() { return this.ledger.budgetReached({dailyTokenLimit:this.settings.dailyTokenBudget,
    dailyCostLimit:this.settings.dailyBudget,currency:'CNY'}); }
  recordUsage(usage,{allowUnknown=false}={}) {
    if((!usage || !Object.keys(usage).length)&&!allowUnknown) return;
    this.ledger.recordUsage(usage,{prices:this.prices(),id:randomUUID()});
    this.publishUsage();
  }
  publishUsage() { this.emit({type:'usage',usage:this.ledger.dailyUsage(),budget:this.budget(),balance:this.balance}); }
  async publishMemory() { if(!this.disposed) this.emit({type:'memory',...(await this.memory.snapshot())}); }
  cancel() {
    this.generation++; this.request?.controller.abort(); this.pendingDecision=null;
    clearTimeout(this.settleTimer); this.settleTimer=null;
  }
  audioAllowed() {
    return observationsAllowed(this.settings,this.now()) && this.settings.videoAudioEnabled
      && this.settings.audioConsentPair===pairOf(this.route);
  }
  clearFrames() {
    clearTimeout(this.frameExpiryTimer); this.frameExpiryTimer=null; this.frames=[];
  }
  pruneFrames() {
    clearTimeout(this.frameExpiryTimer); this.frameExpiryTimer=null;
    this.frames=this.frames.filter(frame=>this.now()-frame.timestamp<45_000).slice(-3);
    if(this.frames.length) {
      this.frameExpiryTimer=setTimeout(()=>this.pruneFrames(),Math.max(1,45_000-(this.now()-this.frames[0].timestamp)));
      this.frameExpiryTimer.unref();
    }
  }
  clearTranscript() { this.transcript=''; this.transcriptAt=0; this.lastTranscriptSegment=''; }
  freshTranscript() {
    if(this.transcript && this.now()-this.transcriptAt>=60_000) this.clearTranscript();
    return this.audioAllowed()?this.transcript:'';
  }
  observation() {
    const base=observationsAllowed(this.settings,this.now()) && this.latest ? {...this.latest}
      : {app:'应用观察已暂停',bundleId:'',idleSeconds:0,timestamp:new Date(this.now()).toISOString()};
    if(screenAllowed(this.settings,this.route,this.now())) {
      this.pruneFrames();
      if(this.frames.length) base.frames=[...this.frames];
    }
    const transcript=this.freshTranscript();
    if(transcript) base.transcript=transcript;
    return base;
  }
  evaluate() {
    if(!this.initialized || this.disposed || !this.latest) return;
    const observation={...this.latest};
    const transcript=this.freshTranscript();
    if(transcript) observation.transcriptFingerprint=createHash('sha256').update(transcript).digest('hex');
    const decision=this.policy.evaluate(observation,this.settings,{
      agent:this.agent,budgetReached:this.budget().reached,audioAllowed:this.audioAllowed(),
      visualAllowed:screenAllowed(this.settings,this.route,this.now()),
      ...(this.pendingStart?{userInteractionId:this.pendingStart}:{}),
    });
    this.pendingStart=null;
    if(!decision.shouldAnalyze) return;
    if(this.request) { this.pendingDecision=decision; return; }
    this.launch({decision});
  }
  launch(options) {
    const work=this.react(options).catch(()=>this.status('本次模型调用未完成，请检查 Harness 模型状态。'));
    this.requests.add(work); void work.finally(()=>this.requests.delete(work));
    return work;
  }
  async react({userText='',interaction='',decision=null}={}) {
    if(this.disposed) return;
    const explicit=Boolean(userText||interaction);
    if(this.request) {
      if(!explicit) { this.pendingDecision=decision; return; }
      this.cancel(); await this.request.done;
    }
    let route=await this.refreshRoute();
    if(this.disposed) return;
    if(!route) { this.status('Harness 默认模型尚未配置，暂时无法生成回应。'); return; }
    if(this.budget().reached) { this.status('已达到今天设置的用量预算；调整预算后可继续模型回应。'); return; }
    if(!explicit && !observationsAllowed(this.settings,this.now())) return;
    // Route resolution is asynchronous: serialize again after it settles.
    while(this.request) {
      if(!explicit) { this.pendingDecision=decision; return; }
      const previous=this.request; this.cancel(); await previous.done;
      if(this.disposed) return;
    }
    if(this.budget().reached) { this.status('已达到今天设置的用量预算；调整预算后可继续模型回应。'); return; }
    if(decision?.trigger==='video-dialogue' && !this.freshTranscript()) return;
    route=this.route;
    if(!route || typeof get(this.ctx,'llm')?.stream!=='function') {
      this.status('Harness 模型服务暂不可用，请稍后再试。'); return;
    }
    const controller=new AbortController();
    const generation=this.generation, pair=pairOf(route);
    let finish;
    const done=new Promise(resolve=>{finish=resolve;});
    const active={controller,done}; this.request=active;
    if(decision) this.policy.recordAnalysis(decision,this.now());
    if(explicit) this.policy.recordUserInteraction(this.now());
    this.emit({type:'mood',mood:'thinking'});
    const observation=this.observation();
    const query=[userText,interaction,observation.app,observation.transcript,this.agent.current?.toolName].filter(Boolean).join(' ');
    try {
      const memory=this.settings.memoryEnabled ? await this.memory.retrieve(query,{limit:8}) : [];
      controller.signal.throwIfAborted();
      let requested=false;
      const llm=get(this.ctx,'llm');
      const trackedLLM=new Proxy(llm,{get(target,key){
        const value=target[key];
        if(key==='stream') return (...args)=>{requested=true; return value.apply(target,args);};
        return typeof value==='function'?value.bind(target):value;
      }});
      const result=await this.generate(trackedLLM,{
        ...route,observation,history:this.history,
        memory:memory.map(item=>item.text),agentProgress:this.settings.agentProgressEnabled?this.agent:undefined,
        trigger:interaction?`user-${interaction}`:(decision?.trigger||'user-message'),userText,
        events:interaction?[{type:'interaction',kind:interaction}]:undefined,
        signal:controller.signal,
        admitFrames:async frames=>{
          if(this.disposed || generation!==this.generation || pair!==pairOf(this.route)
              || !screenAllowed(this.settings,this.route,this.now())) throw new Error('observation-consent-ended');
          const store=get(this.ctx,'attachments');
          if(typeof store?.admitPromptContent!=='function') throw new Error('attachment-service-unavailable');
          const parts=await store.admitPromptContent(frames.map(frame=>({type:'image',mediaType:frame.mimeType,data:frame.data})));
          controller.signal.throwIfAborted();
          return parts.map(part=>part.attachment);
        },
      });
      this.recordUsage(result.usage,{allowUnknown:requested});
      if(this.disposed || controller.signal.aborted || generation!==this.generation || pair!==pairOf(this.route)) return;
      if(!explicit && !observationsAllowed(this.settings,this.now())) return;
      if(result.shouldSpeak) {
        this.policy.recordSpeech(decision||{},this.now());
        if(userText) this.history.push({role:'user',text:userText});
        this.history.push({role:'assistant',text:result.text}); this.history=this.history.slice(-12);
        this.emit({type:'speech',text:result.text,mood:result.mood,speak:this.settings.voiceEnabled});
        if(this.settings.memoryEnabled && userText) {
          await this.memory.rememberTurn(userText,result.text,{timestamp:this.now()});
          await this.publishMemory();
          const snapshot=await this.memory.snapshot();
          if((snapshot.pendingTurns>=4 || /记住|记得|我喜欢|我不喜欢|以后|更正/u.test(userText)) && !this.budget().reached) {
            // Consolidation uses only user dialogue evidence; no screen or system audio is stored as a fact.
            let extractionRequested=false;
            const extractionLLM=new Proxy(llm,{get(target,key){
              const value=target[key];
              if(key==='stream') return (...args)=>{extractionRequested=true; return value.apply(target,args);};
              return typeof value==='function'?value.bind(target):value;
            }});
            const extraction=await this.memory.consolidate(extractionLLM,route,controller.signal);
            if(extractionRequested&&!extraction.usage) this.recordUsage(undefined,{allowUnknown:true});
            await this.publishMemory();
          }
        }
      } else if(result.error) {
        const labels={vision_unsupported:'当前 Harness 默认模型不支持图片，请在 Harness 中切换支持图片的默认模型。',
          image_admission_required:'Harness 图像附件服务未就绪。',timeout:'模型请求超时。',aborted:'本次请求已取消。'};
        this.status(labels[result.error]||`模型未返回可用回应（${text(result.error,80)}）。`);
      }
    } finally {
      if(this.request===active) this.request=null;
      finish();
      this.emit({type:'mood',mood:'idle'});
      if(this.pendingDecision && !this.disposed) { this.pendingDecision=null; this.evaluate(); }
    }
  }
  async handle(message) {
    await this.ready;
    if(this.disposed || !message || typeof message!=='object') return;
    switch(message.type) {
      case 'ready': case 'request-models':
        await this.refreshRoute(true); this.publishUsage(); await this.publishMemory();
        if(this.settings.agentProgressEnabled) this.emit({type:'agent',...this.agent});
        break;
      case 'settings': {
        const previous=this.settings;
        this.cancel(); this.clearFrames(); this.clearTranscript(); this.latest=null; this.policy.reset();
        this.settings=normalizeSettings({...previous,...message,provider:this.route?.provider||'',model:this.route?.model||''});
        if(!this.route?.vision || typeof get(this.ctx,'attachments')?.admitPromptContent!=='function') this.settings.screenEnabled=false;
        this.persistSettings(); this.publishSettings(); this.publishUsage();
        if(this.settings.observationEnabled && (!previous.observationEnabled || !previous.screenEnabled&&this.settings.screenEnabled)) {
          this.pendingStart=`start-${this.generation}`;
        }
        if(this.settings.agentProgressEnabled) this.emit({type:'agent',...this.agent});
        else this.emit({type:'agent',available:false,current:null,sessions:[],activeCount:0,waitingCount:0});
        break;
      }
      case 'observation': {
        await this.refreshRoute();
        if(!observationsAllowed(this.settings,this.now())) return;
        const previous=this.latest;
        const acceptedFrame=screenAllowed(this.settings,this.route,this.now()) && message.screen
          && typeof message.screen.data==='string' && message.screen.data.length<8*1024*1024
          && ['image/jpeg','image/png','image/webp'].includes(message.screen.mimeType);
        const sameApp=previous?.bundleId===message.bundleId;
        const digest=acceptedFrame?createHash('sha256').update(message.screen.data).digest('hex')
          :(sameApp?previous?.visualFingerprint||'':'');
        this.latest={...metadataOnly(message),
          visualFingerprint:text(message.visualFingerprint,128)||digest,
          visualChange:Number.isFinite(message.visualChange)?Math.max(0,Math.min(1,message.visualChange)):0};
        if(acceptedFrame) {
          this.frames.push({data:message.screen.data,mimeType:message.screen.mimeType,timestamp:this.now()});
          this.pruneFrames();
        }
        if(previous && !sameApp) {
          clearTimeout(this.settleTimer);
          // Debounce this observed app-change event; this is not a recurring speech timer.
          this.settleTimer=setTimeout(()=>{this.settleTimer=null;this.evaluate();},4700);
          this.settleTimer.unref();
        }
        this.evaluate(); break;
      }
      case 'transcript':
        if(this.audioAllowed() && message.source==='system-audio' && message.onDevice===true && typeof message.text==='string') {
          this.freshTranscript();
          const segment=text(message.text,2000).replace(/\s+/gu,' ').trim();
          if(!segment || segment===this.lastTranscriptSegment) break;
          this.lastTranscriptSegment=segment;
          this.transcript=(this.transcript+' '+segment).trim().slice(-3000); this.transcriptAt=this.now(); this.evaluate();
        }
        break;
      case 'chat':
        if(text(message.text).trim()) {
          const userText=text(message.text).trim(); this.cancel();
          const forget=/^\/(?:forget|忘记)\s+(.+)$/u.exec(userText);
          if(forget) {
            this.history=[]; const result=await this.memory.forget(forget[1]); await this.publishMemory();
            this.status(result.forgotten?'已删除匹配记忆及来源对话。':'没有找到匹配记忆；可在记忆页查看条目或清空。');
          } else await this.launch({userText});
        }
        break;
      case 'interaction':
        if(message.automatic===true) { this.evaluate(); break; }
        if(['head','body','tail','feed','sleep','wake','drag-hold','landing'].includes(message.kind)) {
          this.policy.recordUserInteraction(this.now());
          if(!['drag-hold','landing'].includes(message.kind)) await this.launch({interaction:message.kind});
        }
        break;
      case 'request-memory': await this.publishMemory(); break;
      case 'memory-save':
        this.cancel(); this.history=[]; await this.memory.replaceFacts(text(message.text,16000)); await this.publishMemory(); break;
      case 'memory-clear':
        this.cancel(); this.history=[]; await this.memory.clear(); await this.publishMemory(); break;
      case 'request-usage':
        this.balance=await readBalance(this.ctx,this.route); this.publishUsage(); break;
      case 'quit': this.cancel(); break;
      default: break;
    }
  }
  async dispose() {
    this.disposed=true; this.cancel(); this.clearFrames(); this.clearTranscript(); this.history=[];
    await this.ready.catch(()=>{});
    if(typeof this.configDisposer==='function') this.configDisposer();
    if(this.progressDisposer) await this.progressDisposer();
    await Promise.allSettled([...this.requests,...(this.routeRefresh?[this.routeRefresh]:[])]);
  }
}
