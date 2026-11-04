/** Private virtual companion growth. No model/network, purchases, credentials or captured content. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync, readFileSync, openSync, writeFileSync,
  closeSync, fsyncSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { foodCatalog, applyFood, axisTier, repeatDimOf } from '../third_party/roleplay-game-core.mjs';

const MAX=Number.MAX_SAFE_INTEGER;
const LIMITS={entities:64,dedup:2048,bytes:512*1024,offline:6*60*60*1000,meal:90_000,fresh:4000,interaction:300_000};
const SOURCES=new Set(['agent','companion']);
const INTERACTIONS=new Set(['head','body','tail','skirt','feed','sleep','wake','chat','user-message','drag-hold','landing']);
const ACTIVE=new Set(['running','thinking','replying','working','tool']);
const safe=value=>Number.isSafeInteger(value)&&value>=0;
const sum=(a,b)=>a>MAX-b?MAX:a+b;
const clamp=(value,lo=0,hi=100)=>Math.min(hi,Math.max(lo,value));
const number=(value,fallback,lo=0,hi=100)=>Number.isFinite(value)?clamp(value,lo,hi):fallback;
const clone=value=>JSON.parse(JSON.stringify(value));
const threshold=level=>100+25*(level-1);
const configOf=value=>({growthEnabled:value?.growthEnabled!==false,snackRewardsEnabled:value?.snackRewardsEnabled!==false,
  autoEatEnabled:value?.autoEatEnabled!==false,tokensPerSnack:Number.isFinite(value?.tokensPerSnack)
    ?Math.round(clamp(value.tokensPerSnack,100,100000)):2000});
const stageOf=experience=>experience>=1200?'相伴':['初识','熟悉','默契'][axisTier(experience/12)-1];

/** Synchronous single-owner state. snapshot() never writes; only numeric, enum and hashed-id facts persist. */
export class CompanionGrowth {
  constructor(directory,{now=Date.now,onEvent=()=>{}}={}) {
    if(typeof directory!=='string'||!directory) throw new Error('invalid-growth-directory');
    this.directory=resolve(directory);this.file=join(this.directory,'growth.json');this.now=now;this.onEvent=onEvent;
    this.context={};this.status='陪伴成长已就绪。';
    const at=this.time();
    this.state={version:1,level:1,experience:0,totalExperience:0,satiety:72,energy:82,mood:78,
      lastAdvancedAt:at,lastMealAt:null,lastInteractionAt:null,sleeping:false,paused:false,
      snacks:[],reserveSnacks:0,reserveCreatedAt:at,tokenRemainder:0,usageIds:[],recentInteractions:[],
      stats:{earnedSnacks:0,eatenSnacks:0,trackedTokens:0,agentTokens:0,companionTokens:0,interactions:0},config:configOf({})};
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    if(lstatSync(this.directory).isSymbolicLink()) throw new Error('unsafe-growth-directory');
    chmodSync(this.directory,0o700);
    if(existsSync(this.file)) this.load();else this.persist();
    this.lastSavedAt=at;
  }
  time() { const value=this.now();return Number.isFinite(value)&&value>=0&&value<8.64e15?Math.floor(value):Date.now(); }
  load() {
    const info=lstatSync(this.file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>LIMITS.bytes) throw new Error('unsafe-growth-file');
    chmodSync(this.file,0o600);
    let input;try {input=JSON.parse(readFileSync(this.file,'utf8'));}catch {throw new Error('unreadable-growth-file');}
    if(input?.version!==1) throw new Error('unsupported-growth-version');
    const state=this.state;
    state.level=safe(input.level)&&input.level>=1?Math.min(input.level,10000):1;
    state.experience=safe(input.experience)?Math.min(input.experience,threshold(state.level)-1):0;
    state.totalExperience=safe(input.totalExperience)?input.totalExperience:state.experience;
    for(const key of ['satiety','energy','mood']) state[key]=number(input[key],state[key]);
    state.lastAdvancedAt=safe(input.lastAdvancedAt)?Math.min(input.lastAdvancedAt,this.time()):this.time();
    for(const key of ['lastMealAt','lastInteractionAt']) state[key]=safe(input[key])?input[key]:null;
    state.sleeping=input.sleeping===true;state.paused=input.paused===true;
    state.config=configOf(input.config);
    state.reserveSnacks=safe(input.reserveSnacks)?Math.min(input.reserveSnacks,MAX-LIMITS.entities):0;
    state.reserveCreatedAt=safe(input.reserveCreatedAt)?input.reserveCreatedAt:this.time();
    state.tokenRemainder=safe(input.tokenRemainder)?Math.min(input.tokenRemainder,100000):0;
    state.usageIds=Array.isArray(input.usageIds)?[...new Set(input.usageIds.filter(value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)))].slice(-LIMITS.dedup):[];
    state.snacks=(Array.isArray(input.snacks)?input.snacks:[]).slice(0,LIMITS.entities).flatMap(item=>{
      if(typeof item?.id!=='string'||!/^snack-[a-f0-9-]{36}$/u.test(item.id)||!foodCatalog.some(food=>food.id===item.foodId)) return [];
      return [{id:item.id,foodId:item.foodId,createdAt:safe(item.createdAt)?item.createdAt:this.time()}];
    });
    state.snacks=state.snacks.filter((item,index,array)=>array.findIndex(other=>other.id===item.id)===index);
    for(const key of Object.keys(state.stats)) state.stats[key]=safe(input.stats?.[key])?input.stats[key]:0;
    state.recentInteractions=(Array.isArray(input.recentInteractions)?input.recentInteractions:[]).slice(-3)
      .filter(item=>INTERACTIONS.has(item?.kind)).map(item=>({kind:item.kind,bond:1}));
    if(!state.config.growthEnabled) state.paused=true;
  }
  persist() {
    const staging=join(this.directory,`.growth-${randomUUID()}.tmp`);
    const contents=JSON.stringify(this.state)+'\n';
    if(Buffer.byteLength(contents)>LIMITS.bytes) throw new Error('growth-state-too-large');
    let descriptor;
    try {
      descriptor=openSync(staging,'wx',0o600);writeFileSync(descriptor,contents,'utf8');fsyncSync(descriptor);
      closeSync(descriptor);descriptor=undefined;renameSync(staging,this.file);chmodSync(this.file,0o600);
      this.lastSavedAt=this.time();
    } finally {
      if(descriptor!==undefined) closeSync(descriptor);
      try {unlinkSync(staging);}catch { /* Already atomically promoted, or never created. */ }
    }
  }
  physiology(at=this.time()) {
    const state=this.state;
    if(state.paused||!state.config.growthEnabled) return {satiety:state.satiety,energy:state.energy,mood:state.mood};
    const hours=Math.min(LIMITS.offline,Math.max(0,at-state.lastAdvancedAt))/3_600_000;
    // Gentle, bounded variation: no health, death, level loss or absence penalty exists.
    return {satiety:clamp(state.satiety-hours*(state.sleeping?1.5:3)),
      energy:clamp(state.energy+hours*(state.sleeping?8:-2)),mood:clamp(state.mood-hours*.5)};
  }
  advance(settings,context) {
    const at=this.time(),state=this.state,next=configOf(settings??state.config);
    const changed=JSON.stringify(next)!==JSON.stringify(state.config);
    if(context&&typeof context==='object') {
      this.context={deferMeal:context.deferMeal===true,modelRequested:context.modelRequested===true,
        permissionRequestInFlight:context.permissionRequestInFlight===true,
        sleeping:typeof context.sleeping==='boolean'?context.sleeping:this.context.sleeping===true,
        waiting:context.agent?.current?.waitingApproval===true||context.agent?.current?.waitingUser===true
          ||['waiting-approval','waiting-user'].includes(context.agent?.current?.phase),
        busy:ACTIVE.has(context.agent?.current?.phase)||(safe(context.agent?.activeCount)&&context.agent.activeCount>0)};
    }
    if(state.config.growthEnabled&&!state.paused) Object.assign(state,this.physiology(at));
    state.lastAdvancedAt=at;
    state.paused=!next.growthEnabled;state.config=next;
    const sleeping=this.context.sleeping===true;
    const sleepChanged=state.sleeping!==sleeping;
    state.sleeping=sleeping;
    if(changed||sleepChanged||at-this.lastSavedAt>=60_000) this.persist();
    return this.snapshot();
  }
  snapshot() {
    const state=this.state,physiology=this.physiology();
    const stage=stageOf(state.totalExperience);
    const snacks=state.snacks.map(item=>{
      const food=foodCatalog.find(food=>food.id===item.foodId);
      return {id:item.id,kind:food.id,name:food.name,nutrition:food.satiety,createdAt:item.createdAt};
    });
    return {level:state.level,experience:state.experience,nextLevelExperience:threshold(state.level),totalExperience:state.totalExperience,
      stage,levelTitle:{初识:'初识伙伴',熟悉:'安静伙伴',默契:'默契伙伴',相伴:'长久相伴'}[stage],
      satiety:Math.round(physiology.satiety),energy:Math.round(physiology.energy),mood:Math.round(physiology.mood),
      snacks,snackCount:sum(state.snacks.length,state.reserveSnacks),reserveSnacks:state.reserveSnacks,
      stats:{...state.stats},lastMealAt:state.lastMealAt,status:this.status,
      tokenRemainder:state.tokenRemainder,pendingAutoEatAt:this.pendingAutoEatAt(physiology)};
  }
  pendingAutoEatAt(physiology=this.physiology()) {
    const state=this.state,config=state.config,at=this.time();
    if(!config.growthEnabled||!config.autoEatEnabled||!state.snacks.length&&!state.reserveSnacks) return null;
    const births=state.snacks.map(snack=>snack.createdAt);
    if(state.reserveSnacks) births.push(state.reserveCreatedAt);
    const earliest=Math.min(...births)+LIMITS.fresh;
    let next=Math.max(at,earliest,state.lastMealAt===null?0:state.lastMealAt+LIMITS.meal);
    const context=this.context;
    const satietyLimit=context.modelRequested?75:60;
    if(physiology.satiety>satietyLimit||physiology.energy<=12||state.sleeping||context.waiting||context.busy
      ||context.permissionRequestInFlight||context.deferMeal) next=Math.max(next,at+60_000);
    return next;
  }
  event(type,extra={}) {
    const event={id:randomUUID(),type,...extra};
    try {
      const result=this.onEvent(clone(event),this.snapshot());
      if(result&&typeof result.catch==='function') void result.catch(()=>{});
    }catch { /* Presentation cannot undo a committed meal/reward. */ }
  }
  addExperience(amount) {
    const state=this.state,previous=state.level;
    state.totalExperience=sum(state.totalExperience,amount);state.experience+=amount;
    while(state.experience>=threshold(state.level)&&state.level<10000) {
      state.experience-=threshold(state.level);state.level++;
    }
    if(state.level===10000) state.experience=Math.min(state.experience,threshold(state.level)-1);
    return state.level>previous?{level:state.level,previousLevel:previous}:null;
  }
  materialize() {
    const state=this.state;
    const count=Math.min(LIMITS.entities-state.snacks.length,state.reserveSnacks);
    for(let index=0;index<count;index++) {
      const food=foodCatalog[(state.stats.earnedSnacks+state.snacks.length)%foodCatalog.length];
      state.snacks.push({id:'snack-'+randomUUID(),foodId:food.id,createdAt:state.reserveCreatedAt});
    }
    state.reserveSnacks-=count;
  }
  recordUsage({id,totalTokens,source}={},settings) {
    this.advance(settings);
    const state=this.state;
    const rejected=()=>({...this.snapshot(),accepted:false,earned:0});
    if(typeof id!=='string'||!id||id.length>16384||!safe(totalTokens)||!SOURCES.has(source)) return rejected();
    const digest=createHash('sha256').update(source+'\u001f'+id).digest('hex');
    if(state.usageIds.includes(digest)) return rejected();
    state.usageIds.push(digest);state.usageIds=state.usageIds.slice(-LIMITS.dedup);
    if(!state.config.growthEnabled) {this.persist();return rejected();}
    // Refuse an unrepresentable aggregate rather than presenting a saturated value as an exact count.
    if(state.stats.trackedTokens>MAX-totalTokens) {this.persist();return {...rejected(),reason:'counter-overflow'};}
    state.stats.trackedTokens=sum(state.stats.trackedTokens,totalTokens);
    const sourceKey=source==='agent'?'agentTokens':'companionTokens';
    state.stats[sourceKey]=sum(state.stats[sourceKey],totalTokens);
    let earned=0;
    if(state.config.snackRewardsEnabled) {
      const threshold=state.config.tokensPerSnack;
      const remainder=state.tokenRemainder+(totalTokens%threshold);
      earned=Math.floor(totalTokens/threshold)+Math.floor(remainder/threshold);
      state.tokenRemainder=remainder%threshold;
      if(earned) {
        state.stats.earnedSnacks=sum(state.stats.earnedSnacks,earned);
        state.reserveSnacks=Math.min(MAX-LIMITS.entities,sum(state.reserveSnacks,earned));
        // A newer reserve batch delays older reserve items conservatively rather than aging new food early.
        state.reserveCreatedAt=this.time();this.materialize();
        this.status=`获得 ${earned.toLocaleString('zh-CN')} 份虚拟零食，稍后可以递给她。`;
      }
    }
    this.persist();
    if(earned) {
      const snack=state.snacks.at(-1);
      this.event('snack-spawned',{count:earned,snackId:snack?.id,kind:snack?.foodId});
    }
    return {...this.snapshot(),accepted:true,earned};
  }
  considerMeal(context={},settings, {snackId,manual=false}={}) {
    this.advance(settings,context);
    const state=this.state,at=this.time();
    const wait=(reason,status)=>{this.status=status;return {...this.snapshot(),ate:false,reason};};
    if(!state.config.growthEnabled) return wait('disabled','成长已暂停，已有记录与零食会保留。');
    if(!state.snacks.length&&!state.reserveSnacks) return wait('empty','还没有零食，日常互动也可以增加成长。');
    if(!manual&&!state.config.autoEatEnabled) return wait('auto-disabled','自动吃零食已关闭，可以手动递一份。');
    if(this.context.permissionRequestInFlight) return wait('awaiting-confirmation','正在等待系统权限确认，确认完成后再递零食。');
    if(this.context.waiting) return wait('awaiting-confirmation','任务正在等待审批或回答，处理后再递零食。');
    if(this.context.busy) return wait('busy','正在专注处理任务，稍后再吃。');
    if(state.sleeping) return wait('resting','正在睡觉，叫醒后再递零食。');
    if(!manual&&state.energy<=12) return wait('resting','精力较低，自动进食暂缓；醒着时可以手动递零食。');
    if(this.context.deferMeal) return wait('model-wait','想先等一等，稍后再考虑零食。');
    const limit=manual?80:this.context.modelRequested?75:60;
    if(state.satiety>limit) return wait('full',`现在有点饱（饱腹 ${Math.round(state.satiety)}/100），先把零食留着。`);
    if(state.lastMealAt!==null&&at-state.lastMealAt<LIMITS.meal) {
      const seconds=Math.ceil((LIMITS.meal-(at-state.lastMealAt))/1000);
      return wait('cooldown',`刚刚吃过一份，距离下次可进食还需 ${seconds} 秒。`);
    }
    this.materialize();
    let index;
    if(typeof snackId==='string'&&snackId) index=state.snacks.findIndex(snack=>snack.id===snackId);
    else index=state.snacks.findIndex(snack=>manual||at-snack.createdAt>=LIMITS.fresh);
    if(index<0) return wait(snackId?'snack-unavailable':'fresh',snackId?'这份零食已不在库存中。':'零食刚刚准备好，稍后再吃。');
    const snack=state.snacks[index];
    if(!manual&&at-snack.createdAt<LIMITS.fresh) return wait('fresh','零食刚刚准备好，稍后再吃。');
    const food=foodCatalog.find(food=>food.id===snack.foodId);
    // Actually reuse the MIT food restoration rules. Its health/price system is deliberately not part of this pet.
    const restored=applyFood({satiety:state.satiety,mood:state.mood,health:100},food.id);
    state.satiety=restored.satiety;state.mood=restored.mood;state.energy=clamp(state.energy+3);
    state.snacks.splice(index,1);state.stats.eatenSnacks=sum(state.stats.eatenSnacks,1);state.lastMealAt=at;
    const level=this.addExperience(20);this.materialize();
    this.status=`已吃一份${food.name}，陪伴经验增加 20。`;
    this.persist();this.event('snack-eaten',{snackId:snack.id,kind:food.id,count:1});
    if(level) this.event('level-up',level);
    return {...this.snapshot(),ate:true,reason:'ate',snackId:snack.id,experienceAdded:20};
  }
  interact(kind,settings) {
    this.advance(settings);
    const state=this.state,at=this.time();
    // Sleep/wake changes the actual care state immediately. The five-minute
    // interaction cooldown limits rewards, never the user's lifecycle intent.
    if(kind==='sleep'||kind==='wake') {
      const sleeping=kind==='sleep';
      const changed=state.sleeping!==sleeping||this.context.sleeping!==sleeping;
      state.sleeping=sleeping;this.context.sleeping=sleeping;
      if(changed) {
        this.status=sleeping?'已切换为休息状态，精力会逐步恢复。':'已切换为清醒状态。';
        this.persist();
      }
    }
    if(!state.config.growthEnabled||!INTERACTIONS.has(kind)
      ||state.lastInteractionAt!==null&&at-state.lastInteractionAt<LIMITS.interaction) {
      return {...this.snapshot(),accepted:false,experienceAdded:0};
    }
    if(state.lastInteractionAt===null||at-state.lastInteractionAt>=30*60_000) state.recentInteractions=[];
    const multiplier=repeatDimOf(state.recentInteractions,'bond',1);
    const experienceAdded=Math.max(1,Math.round(5*multiplier));
    state.recentInteractions.push({kind,bond:1});state.recentInteractions=state.recentInteractions.slice(-3);
    state.lastInteractionAt=at;state.stats.interactions=sum(state.stats.interactions,1);
    state.mood=clamp(state.mood+Math.max(1,Math.round(2*multiplier)));
    const level=this.addExperience(experienceAdded);
    this.status='这次互动已经记入陪伴成长。';this.persist();this.event('interaction',{kind,experienceAdded});
    if(level) this.event('level-up',level);
    return {...this.snapshot(),accepted:true,experienceAdded};
  }
}
