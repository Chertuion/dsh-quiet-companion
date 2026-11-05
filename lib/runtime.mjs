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
import { MousePlayPolicy } from './mouse-play.mjs';
import { CompanionGrowth } from './growth.mjs';
import { attachTokenUsage, reportedAgentUsage } from './token-snacks.mjs';

const pairOf = route => route ? route.provider + '\u001f' + route.model : '';
const get = (ctx,key) => { try { return typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key]; } catch { return null; } };
const text = (value,max=4000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu,'').slice(0,max) : '';

export class CompanionRuntime {
  constructor(ctx,{send,stateDir,now=Date.now,defaultResolver=resolveDefaultModel,generate=generateComment}={}) {
    this.ctx=ctx; this.send=send; this.stateDir=stateDir; this.now=now;
    this.defaultResolver=defaultResolver; this.generate=generate;
    this.settings={...DEFAULT_SETTINGS}; this.route=null; this.disposed=false; this.initialized=false;
    this.native={}; this.lastStatus='正在启动陪伴组件。'; this.visionAvailable=false;
    this.frames=[]; this.latest=null; this.transcript=''; this.transcriptAt=0; this.lastTranscriptSegment='';
    this.history=[]; this.requests=new Set(); this.request=null; this.routeRefresh=null;
    this.generation=0; this.pendingStart=null; this.pendingDecision=null;
    this.agent={available:false,current:null,sessions:[],activeCount:0,waitingCount:0};
    this.balance={available:false,reason:'点击刷新后查询当前账户余额'};
    this.policy=new AdaptiveEngine({now,visualThreshold:0.06});
    this.mousePlay=new MousePlayPolicy({now});
    this.mealHoldUntil=0;this.modelMealUntil=0;
    this.growth=new CompanionGrowth(join(stateDir,'growth'),{now,onEvent:(event,state)=>{
      this.emit({type:'growth',state:{...state,enabled:this.settings.growthEnabled},event});
    }});
    this.ledger=createStateStore(join(stateDir,'usage'),{now,dayOffsetMinutes:-new Date().getTimezoneOffset()});
    this.memory=new CompanionMemory(join(stateDir,'memory'),{onUsage:usage=>this.recordUsage(usage)});
    this.ready=this.initialize();
  }
  emit(message) { if(!this.disposed) this.send(message); }
  status(value) { this.lastStatus=value; this.emit({type:'status',text:value}); }
  async snapshot() {
    await this.ready;
    const memory=await this.memory.snapshot();
    return {settings:{...this.settings},route:this.route?{...this.route,vision:this.visionAvailable}:null,
      status:this.lastStatus,native:{...this.native},screenFrames:this.frameSummary(),memory,
      usage:this.ledger.dailyUsage(),budget:this.budget(),balance:this.balance,
      agent:this.settings.agentProgressEnabled?this.agent:{available:false,current:null,sessions:[],activeCount:0,waitingCount:0},
      growth:{...this.growth.snapshot(),enabled:this.settings.growthEnabled}};
  }
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
      if(this.initialized) {this.careStep();this.evaluate();}
    },{now:this.now});
    this.tokenDisposer=attachTokenUsage(this.ctx,receipt=>{
      if(this.disposed) return;
      this.growth.recordUsage(receipt,this.settings);this.careStep();
    });
    if(typeof this.ctx?.on==='function') {
      try { this.configDisposer=this.ctx.on('loader/volatile-update',()=>{ void this.refreshRoute().catch(()=>{}); }); }
      catch { /* Optional service change notification; each event still resolves the live default. */ }
    }
    this.initialized=true;
    this.publishSettings(); this.publishUsage(); await this.publishMemory();this.careStep();
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
      this.visionAvailable=usableVision;
      const fingerprint=JSON.stringify([pairOf(route),usableVision,route?.label||'']);
      const changed=fingerprint!==this.routeFingerprint;
      const previous=pairOf(this.route) || pairOf(this.settings);
      if(previous && previous!==pairOf(route)) {
        this.cancel(); this.clearFrames(); this.clearTranscript(); this.latest=null;
        this.settings.screenEnabled=false; this.settings.videoAudioEnabled=false;
        this.settings.consentPair=''; this.settings.audioConsentPair='';
      }
      this.route=route;
      this.routeFingerprint=fingerprint;
      if(!usableVision && this.settings.screenEnabled) {
        this.cancel(); this.clearFrames(); this.latest=null; this.settings.screenEnabled=false; this.settings.consentPair='';
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
    const reported=reportedAgentUsage(usage);
    this.growth.recordUsage({id:randomUUID(),totalTokens:reported?.totalTokens??null,source:'companion'},this.settings);
    this.careStep();
  }
  growthContext(extra={}) {
    return {agent:this.agent,sleeping:this.native.petSleeping===true,
      permissionRequestInFlight:this.native.permissionRequestInFlight===true,
      deferMeal:this.now()<this.mealHoldUntil||this.settings.snoozeUntil>this.now(),
      modelRequested:this.now()<this.modelMealUntil,
      ...extra,
      ...(this.request?{agent:{...this.agent,activeCount:Math.max(1,this.agent.activeCount||0),
        current:{...this.agent.current,phase:'thinking'}}}:{})};
  }
  publishGrowth() {this.emit({type:'growth',state:{...this.growth.snapshot(),enabled:this.settings.growthEnabled}});}
  careStep({tryMeal=true,modelRequested}={}) {
    if(this.disposed||!this.initialized) return;
    const context=this.growthContext(modelRequested===undefined?{}:{modelRequested});
    this.growth.advance(this.settings,context);
    if(tryMeal&&this.growth.considerMeal(context,this.settings).ate) this.modelMealUntil=0;
    this.publishGrowth();
    clearTimeout(this.careTimer);this.careTimer=null;
    if(!this.settings.growthEnabled) return;
    const next=this.growth.snapshot().pendingAutoEatAt;
    const wait=next===null?60_000:Math.max(4500,Math.min(60_000,next-this.now()));
    this.careTimer=setTimeout(()=>{this.careTimer=null;this.careStep();},wait);this.careTimer.unref();
  }
  offerSnack(id) {
    this.mousePlay.interact();
    this.policy.recordUserInteraction(this.now());
    this.growth.interact('feed',this.settings);
    const result=this.growth.considerMeal(this.growthContext(),this.settings,{snackId:text(id,100),manual:true});
    if(result.ate) this.modelMealUntil=0;
    this.publishGrowth();this.careStep({tryMeal:false});
    // Operational feedback stays visible even with the growth sidebar hidden.
    // Native shows this without character speech, TTS, dialogue history or inference.
    this.emit({type:'notice',kind:'snack-offer',text:result.status,reason:result.reason});
    return result;
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
  freshFrames() {
    const now=this.now(),pair=pairOf(this.route);
    if(!screenAllowed(this.settings,this.route,now)) return [];
    return this.frames.filter(frame=>Number.isFinite(frame.timestamp) && frame.timestamp<=now
      && now-frame.timestamp<45_000 && frame.routePair===pair
      && frame.consentPair===this.settings.consentPair).slice(-3);
  }
  frameSummary() {
    const frames=this.freshFrames(),latest=frames.at(-1);
    return {count:frames.length,lastReceivedAt:latest?.timestamp??null,sourceApp:latest?.sourceApp||''};
  }
  pruneFrames() {
    clearTimeout(this.frameExpiryTimer); this.frameExpiryTimer=null;
    this.frames=this.freshFrames();
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
    const work=this.react(options).catch(()=>{
      if(!options.isCurrent||options.isCurrent()) this.status('本次模型调用未完成，请检查 Harness 模型状态。');
    });
    this.requests.add(work); void work.finally(()=>this.requests.delete(work));
    return work;
  }
  async react({userText='',interaction='',decision=null,isCurrent=()=>true}={}) {
    if(this.disposed||!isCurrent()) return;
    const explicit=Boolean(userText||interaction);
    const replyStatus=(value,reason)=>{
      this.status(value);
      // Reuse the existing chat-reply transport, explicitly as silent local system feedback.
      // It must not enter model dialogue history, memory or adaptive speech accounting.
      if(explicit) this.emit({type:'speech',source:'system',text:'系统提示：'+text(value,1000),
        mood:'error',speak:false,reason:text(reason,80)});
    };
    if(this.request) {
      if(!explicit) { this.pendingDecision=decision; return; }
      this.cancel(); await this.request.done;
    }
    const preparationGeneration=this.generation;
    let route=await this.refreshRoute();
    if(this.disposed||!isCurrent()||preparationGeneration!==this.generation) return;
    if(!route) { replyStatus('Harness 默认模型尚未配置，暂时无法生成回应。','model_unavailable'); return; }
    if(this.budget().reached) { replyStatus('已达到今天设置的用量预算；调整预算后可继续模型回应。','budget_reached'); return; }
    if(!explicit && !observationsAllowed(this.settings,this.now())) return;
    // Route resolution is asynchronous: serialize again after it settles.
    while(this.request) {
      if(!explicit) { this.pendingDecision=decision; return; }
      const previous=this.request; this.cancel(); await previous.done;
      if(this.disposed||!isCurrent()) return;
    }
    if(this.budget().reached) { replyStatus('已达到今天设置的用量预算；调整预算后可继续模型回应。','budget_reached'); return; }
    if(decision?.trigger==='video-dialogue' && !this.freshTranscript()) return;
    route=this.route;
    if(!route || typeof get(this.ctx,'llm')?.stream!=='function') {
      replyStatus('Harness 模型服务暂不可用，请稍后再试。','model_unavailable'); return;
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
      if(!isCurrent()) return;
      controller.signal.throwIfAborted();
      let requested=false;
      const llm=get(this.ctx,'llm');
      const trackedLLM=new Proxy(llm,{get(target,key){
        const value=target[key];
        if(key==='stream') return (...args)=>{requested=true; return value.apply(target,args);};
        return typeof value==='function'?value.bind(target):value;
      }});
      const growthState=this.settings.growthEnabled?this.growth.snapshot():null;
      const canChooseSnack=Boolean(growthState&&this.settings.autoEatEnabled&&growthState.snackCount>0);
      const result=await this.generate(trackedLLM,{
        ...route,observation,history:this.history,now:this.now,
        memory:memory.map(item=>item.text),agentProgress:this.settings.agentProgressEnabled?this.agent:undefined,
        growth:growthState?{...growthState,canChooseSnack}:undefined,
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
      if(this.disposed || !isCurrent() || controller.signal.aborted || generation!==this.generation || pair!==pairOf(this.route)) return;
      if(!explicit && !observationsAllowed(this.settings,this.now())) return;
      if(canChooseSnack&&this.settings.growthEnabled&&this.settings.autoEatEnabled&&result.snackAction==='wait') {
        this.mealHoldUntil=this.now()+60_000;this.modelMealUntil=0;
      }
      else if(canChooseSnack&&this.settings.growthEnabled&&this.settings.autoEatEnabled&&result.snackAction==='eat') {
        this.mealHoldUntil=0;this.modelMealUntil=this.now()+60_000;
      }
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
          image_admission_required:'Harness 图像附件服务未就绪。',timeout:'模型请求超时。',aborted:'本次请求已取消。',
          'finish_max-tokens':'本次生成达到输出上限，请重试或在Harness降低推理强度'};
        const formatIssues={response_size:'回复过长',invalid_json:'没有完整的JSON对象',multiple_objects:'返回了多个回复对象',
          invalid_shape:'回复不是对象',invalid_fields:'回复字段不符合约定',invalid_types:'回复字段类型不正确',
          invalid_mood:'情绪字段不符合约定',invalid_snack_action:'零食意图字段不符合约定',
          empty_text:'回复内容为空',text_too_long:'回复超过长度限制',control_characters:'回复含无效控制字符',
          code_fence:'触摸回复混入代码围栏',structured_touch:'触摸回复混入结构化内容',not_chinese:'触摸回复不是自然中文',
          invalid_observation_control:'观察回复控制标签无效',structured_observation:'观察回复混入结构化内容',
          observation_code_fence:'观察回复混入代码围栏',observation_not_chinese:'观察回复不是自然中文'};
        const message=result.error==='invalid_response'
          ?`模型回复格式无效（${formatIssues[result.responseIssue]||'未返回完整回复'}），请重试。`
          :labels[result.error]||`模型未返回可用回应（${text(result.error,80)}）。`;
        replyStatus(message,result.error);
      }
    } finally {
      if(this.request===active) this.request=null;
      finish();
      this.emit({type:'mood',mood:'idle'});
      if(!this.disposed) this.careStep();
      if(this.pendingDecision && !this.disposed) { this.pendingDecision=null; this.evaluate(); }
    }
  }
  async handle(message,{isCurrent=()=>true}={}) {
    await this.ready;
    if(this.disposed || !isCurrent() || !message || typeof message!=='object') return;
    switch(message.type) {
      case 'native-status': {
        const next={};
        for(const key of ['audioStatus','modelStatus','mouseStatus','helperVersion','screenPermissionState','screenStatus']) if(typeof message[key]==='string') next[key]=text(message[key],1200);
        for(const key of ['screenAuthorized','audioAuthorized','permissionRequestInFlight','mouseAuthorized','mousePlayActive','petSleeping',
          'screenConsentPending','audioConsentPending','mouseConsentPending','permissionsNeedRestart',
          'screenEnabled','audioEnabled','mousePlayEnabled']) if(typeof message[key]==='boolean') next[key]=message[key];
        for(const key of ['scale','opacity']) if(Number.isFinite(message[key])) next[key]=message[key];
        if(Array.isArray(message.voices)) next.voices=message.voices.slice(0,500).map(voice=>({
          id:text(voice?.id,240),name:text(voice?.name,240),language:text(voice?.language,32),
        })).filter(voice=>voice.id);
        this.native={...this.native,...next};
        this.careStep();
        break;
      }
      case 'ready': case 'request-models':
        await this.refreshRoute(true);
        if(!isCurrent()) return;
        this.publishUsage(); await this.publishMemory();
        if(!isCurrent()) return;
        this.publishGrowth();
        if(this.settings.agentProgressEnabled) this.emit({type:'agent',...this.agent});
        break;
      case 'settings': {
        const previous=this.settings;
        const hadScreen=screenAllowed(previous,this.route,this.now());
        const routingChanged=['provider','model','useDefaultModel'].some(key=>Object.hasOwn(message,key)&&message[key]!==previous[key]);
        this.cancel(); this.clearTranscript(); this.policy.reset();
        this.settings=normalizeSettings({...previous,...message,provider:this.route?.provider||'',model:this.route?.model||''});
        if(!this.settings.growthEnabled||!this.settings.autoEatEnabled) {this.modelMealUntil=0;this.mealHoldUntil=0;}
        this.mousePlay.interact();
        if(!this.route?.vision || typeof get(this.ctx,'attachments')?.admitPromptContent!=='function') this.settings.screenEnabled=false;
        if(hadScreen && screenAllowed(this.settings,this.route,this.now()) && !routingChanged
            && pairOf(previous)===pairOf(this.settings) && previous.consentPair===this.settings.consentPair) {
          this.pruneFrames(); // Original timestamps and remaining 45-second expiry stay unchanged.
        } else { this.clearFrames(); this.latest=null; }
        this.persistSettings(); this.publishSettings(); this.publishUsage();
        this.careStep();
        if(this.settings.observationEnabled && (!previous.observationEnabled || !previous.screenEnabled&&this.settings.screenEnabled)) {
          this.pendingStart=`start-${this.generation}`;
        }
        if(this.settings.agentProgressEnabled) this.emit({type:'agent',...this.agent});
        else this.emit({type:'agent',available:false,current:null,sessions:[],activeCount:0,waitingCount:0});
        break;
      }
      case 'observation': {
        await this.refreshRoute();
        if(!isCurrent()) return;
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
          const sourceApp=metadataOnly(message).app.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,'').trim().slice(0,80);
          this.frames.push({data:message.screen.data,mimeType:message.screen.mimeType,timestamp:this.now(),sourceApp,
            routePair:pairOf(this.route),consentPair:this.settings.consentPair});
          this.pruneFrames();
        }
        if(previous && !sameApp) {
          clearTimeout(this.settleTimer);
          // Debounce this observed app-change event; this is not a recurring speech timer.
          this.settleTimer=setTimeout(()=>{this.settleTimer=null;this.evaluate();},4700);
          this.settleTimer.unref();
        }
        if(this.mousePlay.evaluate(this.latest,this.settings,{agent:this.agent,native:this.native})) {
          this.emit({type:'control',action:'mouse-play'});
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
          this.mousePlay.interact();
          this.growth.interact('chat',this.settings);this.careStep({tryMeal:false});
          const forget=/^\/(?:forget|忘记)\s+(.+)$/u.exec(userText);
          if(forget) {
            this.history=[]; const result=await this.memory.forget(forget[1]); await this.publishMemory();
            this.status(result.forgotten?'已删除匹配记忆及来源对话。':'没有找到匹配记忆；可在记忆页查看条目或清空。');
          } else await this.launch({userText,isCurrent});
        }
        break;
      case 'interaction':
        if(message.automatic===true) {
          if(['sleep','wake'].includes(message.kind)) this.native.petSleeping=message.kind==='sleep';
          this.careStep();this.evaluate();break;
        }
        // Older helpers can still send feed as an interaction; it is the same
        // local offer intent, never a model-only claim that a meal happened.
        if(message.kind==='feed') { this.offerSnack(message.id); break; }
        if(['head','body','skirt','tail','feed','sleep','wake','drag-hold','landing'].includes(message.kind)) {
          this.mousePlay.interact();
          if(['sleep','wake'].includes(message.kind)) this.native.petSleeping=message.kind==='sleep';
          this.growth.interact(message.kind,this.settings);this.careStep({tryMeal:false});
          this.policy.recordUserInteraction(this.now());
          if(!['drag-hold','landing'].includes(message.kind)) await this.launch({interaction:message.kind,isCurrent});
        }
        break;
      case 'snack-offer':
        this.offerSnack(message.id);
        break;
      case 'request-growth': this.careStep();break;
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
    clearTimeout(this.careTimer);this.careTimer=null;
    await this.ready.catch(()=>{});
    if(typeof this.configDisposer==='function') this.configDisposer();
    if(this.progressDisposer) await this.progressDisposer();
    if(this.tokenDisposer) await this.tokenDisposer();
    await Promise.allSettled([...this.requests,...(this.routeRefresh?[this.routeRefresh]:[])]);
  }
}
