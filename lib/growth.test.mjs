import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionGrowth } from './growth.mjs';
import { foodCatalog, applyFood } from '../third_party/roleplay-game-core.mjs';

const settings={growthEnabled:true,snackRewardsEnabled:true,autoEatEnabled:true,tokensPerSnack:2000};
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'companion-growth-'));
  let clock=Date.parse('2026-11-02T12:00:00Z');
  const events=[];
  const growth=new CompanionGrowth(directory,{now:()=>clock,onEvent:(event,state)=>events.push({event,state})});
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {directory,growth,events,at:()=>clock,tick:ms=>{clock+=ms;},earn:(tokens=2000,id='request-fixture',source='agent',options=settings)=>
    growth.recordUsage({id,totalTokens:tokens,source},options)};
}

test('private atomic growth persists across restart and snapshots never write or expose usage identifiers',t=>{
  const f=fixture(t);
  f.earn(2500,'PRIVATE_USER_REQUEST_ID');
  const file=join(f.directory,'growth.json');
  const before=readFileSync(file,'utf8');
  for(let index=0;index<20;index++) {f.tick(2000);f.growth.snapshot();}
  assert.equal(readFileSync(file,'utf8'),before);
  assert.equal(statSync(f.directory).mode&0o777,0o700);
  assert.equal(statSync(file).mode&0o777,0o600);
  assert.deepEqual(readdirSync(f.directory),['growth.json']);
  assert.equal(before.includes('PRIVATE_USER_REQUEST_ID'),false);
  assert.equal(JSON.stringify(f.growth.snapshot()).includes('usageIds'),false);
  const loaded=new CompanionGrowth(f.directory,{now:f.at});
  assert.equal(loaded.snapshot().snackCount,1);
  assert.equal(loaded.snapshot().stats.trackedTokens,2500);
  assert.equal(loaded.recordUsage({id:'PRIVATE_USER_REQUEST_ID',totalTokens:2500,source:'agent'},settings).accepted,false);
});

test('only actual safe integer token totals from this Host or companion earn rewards',t=>{
  const f=fixture(t);
  for(const [index,totalTokens] of [undefined,null,-1,1.5,NaN,Infinity,'2000',Number.MAX_SAFE_INTEGER+1].entries()) {
    assert.equal(f.growth.recordUsage({id:`bad-${index}`,totalTokens,source:'agent'},settings).accepted,false);
  }
  assert.equal(f.growth.recordUsage({id:'wrong-source',totalTokens:2000,source:'other-application'},settings).accepted,false);
  assert.equal(f.growth.recordUsage({totalTokens:2000,source:'agent'},settings).accepted,false);
  assert.equal(f.earn(1200,'one').earned,0);
  const reward=f.earn(900,'two','companion');
  assert.equal(reward.earned,1);assert.equal(reward.tokenRemainder,100);
  assert.equal(reward.stats.trackedTokens,2100);assert.equal(reward.stats.agentTokens,1200);assert.equal(reward.stats.companionTokens,900);
  assert.equal(f.earn(900,'two','companion').earned,0);
  assert.equal(f.events.filter(item=>item.event.type==='snack-spawned').length,1);
  assert.equal(reward.stats.eatenSnacks,0);
});

test('new virtual snacks wait four seconds before automatic eating and respect actual food effects',t=>{
  const f=fixture(t);
  const earned=f.earn();const snack=earned.snacks[0];
  const before=f.growth.snapshot();
  assert.equal(f.growth.considerMeal({modelRequested:true},settings).reason,'fresh');
  assert.equal(f.growth.snapshot().pendingAutoEatAt,f.at()+4000);
  f.tick(4000);
  const meal=f.growth.considerMeal({modelRequested:true},settings);
  assert.equal(meal.ate,true);assert.equal(meal.stats.eatenSnacks,1);assert.equal(meal.snackCount,0);
  assert.equal(meal.experienceAdded,20);assert.equal(meal.experience,20);
  const expected=applyFood({satiety:before.satiety,mood:before.mood,health:100},snack.kind);
  assert.equal(meal.satiety,Math.round(expected.satiety));assert.equal(meal.mood,Math.round(expected.mood));
  assert.ok(foodCatalog.some(food=>food.id===snack.kind));
  assert.equal(f.events.at(-1).event.type,'snack-eaten');
  assert.equal(f.events.at(-1).event.snackId,snack.id);
  assert.equal(meal.pendingAutoEatAt,null);
});

test('automatic hunger is <=60, model request can allow <=75, and manual never forces an overfull meal',t=>{
  const f=fixture(t);f.earn(6000);f.tick(4000);
  assert.equal(f.growth.considerMeal({},settings).reason,'full');
  assert.equal(f.growth.considerMeal({modelRequested:true},settings).ate,true);
  f.tick(90_000);
  assert.equal(f.growth.considerMeal({},settings,{manual:true}).reason,'full');
  f.tick(6*60*60*1000);
  assert.equal(f.growth.considerMeal({},settings,{manual:true}).ate,true);
});

test('task work, approvals, permissions, sleep and model wait defer eating without dropping food',t=>{
  const f=fixture(t);f.earn(4000);f.tick(6*60*60*1000);
  for(const [context,reason] of [
    [{agent:{current:{phase:'tool'},activeCount:1}},'busy'],
    [{agent:{current:{phase:'waiting-approval'},activeCount:1}},'awaiting-confirmation'],
    [{agent:{current:{phase:'waiting-user'}}},'awaiting-confirmation'],
    [{permissionRequestInFlight:true},'awaiting-confirmation'],
    [{sleeping:true},'resting'],
    [{sleeping:false,deferMeal:true},'model-wait'],
  ]) {
    const result=f.growth.considerMeal(context,settings,{manual:true});
    assert.equal(result.reason,reason);assert.equal(result.snackCount,2);
    assert.ok(result.pendingAutoEatAt>=f.at()+60_000);
  }
  assert.equal(f.growth.considerMeal({sleeping:false},settings).ate,true);
});

test('manual offering can bypass auto-off and fresh delay but not cooldown or missing inventory selection',t=>{
  const f=fixture(t);f.earn(4000);
  const autoOff={...settings,autoEatEnabled:false};
  assert.equal(f.growth.considerMeal({},autoOff).reason,'auto-disabled');
  assert.equal(f.growth.considerMeal({},autoOff,{snackId:'not-a-snack',manual:true}).reason,'snack-unavailable');
  const snack=f.growth.snapshot().snacks[0];
  const meal=f.growth.considerMeal({},autoOff,{snackId:snack.id,manual:true});
  assert.equal(meal.ate,true);assert.equal(meal.snackCount,1);
  // Meals may become overfull; irrespective of that, another immediate request never eats again.
  assert.equal(f.growth.considerMeal({},autoOff,{manual:true}).ate,false);
  assert.equal(f.growth.snapshot().stats.eatenSnacks,1);
  assert.equal(f.growth.snapshot().pendingAutoEatAt,null);
});

test('awake manual offering restores three energy at low energy while automatic eating and sleeping meals still wait',t=>{
  const f=fixture(t);f.earn(4000);
  f.growth.state.energy=8;f.growth.state.satiety=10;
  const id=f.growth.snapshot().snacks[0].id;
  const automatic=f.growth.considerMeal({sleeping:false},settings);
  assert.equal(automatic.reason,'resting');assert.equal(automatic.stats.eatenSnacks,0);
  assert.equal(automatic.snackCount,2);assert.ok(automatic.pendingAutoEatAt>=f.at()+60_000);
  assert.equal(f.growth.considerMeal({sleeping:true},settings,{snackId:id,manual:true}).reason,'resting');
  const manual=f.growth.considerMeal({sleeping:false},settings,{snackId:id,manual:true});
  assert.equal(manual.ate,true);assert.equal(manual.snackId,id);
  assert.equal(manual.energy,11);assert.equal(f.growth.state.energy,8+3);
  assert.equal(manual.snackCount,1);assert.equal(manual.stats.eatenSnacks,1);
  assert.equal(f.events.filter(item=>item.event.type==='snack-eaten').length,1);
  assert.equal(f.growth.considerMeal({sleeping:false},settings).reason,'resting');
});

test('meal cooldown remains factual while hunger is low enough to eat again',t=>{
  const f=fixture(t);f.earn(10000);f.tick(6*60*60*1000);
  assert.equal(f.growth.considerMeal({},settings).ate,true);
  assert.equal(f.growth.considerMeal({modelRequested:true},settings,{manual:true}).reason,'cooldown');
  f.tick(90_000);
  assert.equal(f.growth.considerMeal({},settings,{manual:true}).ate,true);
});

test('bounded inventory keeps all whole reward counts in reserve and promotes after consumption',t=>{
  const f=fixture(t);const rewarded=f.earn(2000*1000);
  assert.equal(rewarded.snackCount,1000);assert.equal(rewarded.snacks.length,64);assert.equal(rewarded.reserveSnacks,936);
  assert.equal(rewarded.stats.earnedSnacks,1000);
  assert.equal(f.growth.considerMeal({},settings,{manual:true}).ate,true);
  const after=f.growth.snapshot();
  assert.equal(after.snackCount,999);assert.equal(after.snacks.length,64);assert.equal(after.reserveSnacks,935);
  const loaded=new CompanionGrowth(f.directory,{now:f.at});assert.equal(loaded.snapshot().snackCount,999);
  assert.ok(readFileSync(join(f.directory,'growth.json')).length<512*1024);
});

test('growth off freezes metabolism and rewards, preserves history, and does not backfill disabled usage',t=>{
  const f=fixture(t);f.earn();
  const disabled={...settings,growthEnabled:false};
  const before=f.growth.advance(disabled);
  f.tick(24*60*60*1000);
  assert.equal(f.growth.snapshot().satiety,before.satiety);
  const ignored=f.earn(4000,'while-disabled','agent',disabled);
  assert.equal(ignored.accepted,false);assert.equal(ignored.snackCount,1);assert.equal(ignored.stats.trackedTokens,2000);
  assert.equal(f.growth.considerMeal({},disabled,{manual:true}).reason,'disabled');
  const resumed=f.growth.advance(settings);
  assert.equal(resumed.satiety,before.satiety);assert.equal(resumed.energy,before.energy);
  assert.equal(f.earn(4000,'while-disabled').accepted,false);
  assert.equal(f.growth.snapshot().stats.earnedSnacks,1);
});

test('reward switch does not accumulate a disabled-period backlog and threshold settings are clamped',t=>{
  const f=fixture(t);
  f.earn(5000,'no-rewards','agent',{...settings,snackRewardsEnabled:false});
  assert.equal(f.growth.snapshot().snackCount,0);assert.equal(f.growth.snapshot().tokenRemainder,0);
  assert.equal(f.earn(1000,'enabled-again').earned,0);
  assert.equal(f.earn(1000,'next').earned,1);
  assert.equal(f.earn(100,'low-clamp','agent',{...settings,tokensPerSnack:1}).earned,1);
  assert.equal(f.earn(100000,'high-clamp','agent',{...settings,tokensPerSnack:1e12}).earned,1);
});

test('gentle offline variation caps at six hours; sleeping recovers energy without level loss',t=>{
  const f=fixture(t),before=f.growth.snapshot();
  f.tick(30*24*60*60*1000);
  const offline=f.growth.snapshot();
  assert.equal(offline.satiety,before.satiety-18);assert.equal(offline.energy,before.energy-12);
  assert.equal(offline.level,before.level);assert.equal(offline.experience,before.experience);
  f.growth.advance(settings,{sleeping:true});f.tick(2*60*60*1000);
  assert.ok(f.growth.snapshot().energy>offline.energy);
  assert.equal(f.growth.considerMeal({sleeping:true},settings).ate,false);
});

test('interactions grow without any token spend and are globally rate-limited for five minutes',t=>{
  const f=fixture(t);
  const first=f.growth.interact('head',settings);
  assert.equal(first.accepted,true);assert.equal(first.experienceAdded,5);assert.equal(first.stats.trackedTokens,0);
  assert.equal(f.growth.interact('body',settings).accepted,false);
  f.tick(5*60_000);
  const next=f.growth.interact('tail',settings);
  assert.equal(next.accepted,true);assert.equal(next.experienceAdded,3);
  assert.equal(f.growth.interact('PRIVATE_SCREEN_TEXT',settings).accepted,false);
  const disabled=f.growth.interact('head',{...settings,growthEnabled:false});assert.equal(disabled.accepted,false);
  assert.equal(f.growth.snapshot().stats.interactions,2);
});

test('sleep and wake persist immediately inside the reward cooldown without granting any extra experience',t=>{
  const f=fixture(t);const first=f.growth.interact('head',settings);
  const experience=first.totalExperience,lastInteraction=f.growth.state.lastInteractionAt;
  const sleep=f.growth.interact('sleep',settings);
  assert.equal(sleep.experienceAdded,0);assert.equal(sleep.totalExperience,experience);
  assert.equal(f.growth.state.sleeping,true);assert.equal(f.growth.context.sleeping,true);
  assert.equal(JSON.parse(readFileSync(join(f.directory,'growth.json'),'utf8')).sleeping,true);
  f.tick(1000);
  const wake=f.growth.interact('wake',settings);
  assert.equal(wake.experienceAdded,0);assert.equal(wake.totalExperience,experience);
  assert.equal(f.growth.state.sleeping,false);assert.equal(f.growth.context.sleeping,false);
  const persisted=JSON.parse(readFileSync(join(f.directory,'growth.json'),'utf8'));
  assert.equal(persisted.sleeping,false);assert.equal(persisted.totalExperience,experience);
  assert.equal(persisted.lastInteractionAt,lastInteraction);assert.equal(persisted.stats.interactions,1);
  assert.deepEqual(persisted.recentInteractions.map(item=>item.kind),['head']);
  const loaded=new CompanionGrowth(f.directory,{now:f.at});
  assert.equal(loaded.state.sleeping,false);assert.equal(loaded.state.totalExperience,experience);
});

test('new skirt interactions preserve existing tail records and growth across restart without a migration',t=>{
  const f=fixture(t);
  assert.equal(f.growth.interact('tail',settings).accepted,true);
  f.tick(5*60_000);
  const loaded=new CompanionGrowth(f.directory,{now:f.at});
  const next=loaded.interact('skirt',settings);
  assert.equal(next.accepted,true);assert.equal(next.stats.interactions,2);assert.equal(next.totalExperience,8);
  const stored=JSON.parse(readFileSync(join(f.directory,'growth.json'),'utf8'));
  assert.deepEqual(stored.recentInteractions.map(item=>item.kind),['tail','skirt']);
});

test('experience thresholds progress gradually and stages represent familiarity rather than body growth',t=>{
  const f=fixture(t);
  for(let index=0;index<50;index++) {
    f.tick(31*60_000);f.growth.interact('head',settings);
  }
  const value=f.growth.snapshot();
  assert.equal(value.totalExperience,250);assert.ok(value.level>1);assert.ok(value.nextLevelExperience>100);
  assert.ok(value.experience<value.nextLevelExperience);assert.equal(value.stage,'初识');
  assert.ok(f.events.some(item=>item.event.type==='level-up'));
  assert.equal(value.stats.trackedTokens,0);
});

test('raw extra fields never persist and unsafe state paths fail closed',t=>{
  const f=fixture(t);
  f.growth.recordUsage({id:'PRIVATE_KEY_SHAPED_ID',totalTokens:2000,source:'agent',screen:'PRIVATE_SCREEN',apiKey:'PRIVATE_KEY'},settings);
  f.growth.considerMeal({agent:{current:{phase:'tool',toolArguments:'PRIVATE_ARGUMENTS'}},transcript:'PRIVATE_DIALOGUE'},settings);
  const saved=readFileSync(join(f.directory,'growth.json'),'utf8');
  assert.equal(/PRIVATE_/u.test(saved),false);
  const unsafe=join(f.directory,'unsafe');symlinkSync(f.directory,unsafe);
  assert.throws(()=>new CompanionGrowth(unsafe),/unsafe-growth-directory/u);
  const outside=join(f.directory,'outside.json');writeFileSync(outside,'{}');
  rmSync(join(f.directory,'growth.json'));symlinkSync(outside,join(f.directory,'growth.json'));
  assert.throws(()=>new CompanionGrowth(f.directory),/unsafe-growth-file/u);
});

test('hashed dedup, safe arithmetic and persisted schema remain bounded under many events',t=>{
  const f=fixture(t);
  const large=f.earn(Number.MAX_SAFE_INTEGER,'large');
  assert.ok(Number.isSafeInteger(large.snackCount));assert.ok(Number.isSafeInteger(large.stats.trackedTokens));
  assert.ok(Number.isSafeInteger(large.stats.earnedSnacks));assert.equal(large.snacks.length,64);
  assert.equal(f.earn(1,'would-overflow').reason,'counter-overflow');
  assert.equal(f.growth.snapshot().stats.trackedTokens,Number.MAX_SAFE_INTEGER);
  // Exercise load sanitization with an intentionally oversized legacy dedup array, without 2100 fsyncs.
  const file=join(f.directory,'growth.json'),saved=JSON.parse(readFileSync(file,'utf8'));
  saved.usageIds=Array.from({length:2200},(_,index)=>index.toString(16).padStart(64,'0'));
  writeFileSync(file,JSON.stringify(saved));
  const loaded=new CompanionGrowth(f.directory,{now:f.at});
  loaded.recordUsage({id:'bounded',source:'companion',totalTokens:1},settings);
  const persisted=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(persisted.usageIds.length,2048);assert.ok(statSync(file).size<512*1024);
});
