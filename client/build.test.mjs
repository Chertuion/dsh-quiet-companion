import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
const directory=dirname(fileURLToPath(import.meta.url));
const bundle=await readFile(join(directory,'../client.js'),'utf8');
let React, render;
const reactOwners=process.env.DSH_HARNESS_DIR
  ? [join(process.env.DSH_HARNESS_DIR,'apps/web/package.json'),join(process.env.DSH_HARNESS_DIR,'package.json')]
  : [import.meta.url];
for(const owner of reactOwners) try {
  const require=createRequire(owner);
  React=require('react'); render=require('react-dom/server').renderToStaticMarkup;
  break;
} catch { /* The published client deliberately shares Host React instead of installing its own copy. */ }

test('prebuilt client uses one official lazy factory and only Host baseline externals',()=>{
  let entry;
  new Script(bundle).runInNewContext({window:{__ModuleLoader__:{load:value=>{entry=value;}}}});
  assert.equal(entry.id,'dsh-quiet-companion'); assert.equal(typeof entry.factory,'function');
  assert.equal(/require\(['"]\.\//u.test(bundle),false);
  assert.match(bundle,/--dsw-alias-settings-card-fill/u);
  assert.match(bundle,/settings\.section/u);
  assert.equal(bundle.includes('/Users/'),false);
});

const fixture={settings:{observationEnabled:false,screenEnabled:false,videoAudioEnabled:false,memoryEnabled:true,voiceEnabled:false,
  dynamicSkinEnabled:true,agentProgressEnabled:true,dailyTokenBudget:100000},route:{provider:'fixture',model:'default',label:'默认测试模型',vision:true},
  helper:{running:true,error:'测试组件状态 <not-html>'},native:{scale:1,opacity:1,screenAuthorized:false,audioAuthorized:false,voices:[{id:'voice-fixture',name:'本机测试声音',language:'zh-CN'}]},
  status:'等待明确开启',memory:{factsText:'喜欢安静',counts:{facts:1,pinned:1,episodes:2},facts:[{id:'fact:fixture',text:'喜欢安静 <script>not-code</script>',pinned:true,source:'editor',kind:'fact',slot:'preference',provenance:{quote:'我喜欢安静'}}]},
  usage:{day:'2026-11-02',calls:1,reportedCalls:0,totalTokens:null,inputTokens:null,cacheReadTokens:null,outputTokens:null,estimatedCosts:{}},
  budget:{reached:false},balance:{available:false,reason:'尚未查询账户余额'},agent:{available:true,current:null,activeCount:0,waitingCount:0}};
function pageFor(tab,snapshot=fixture,hooks={}) {
  let registration;
  const effects=[];
  const injectedReact={...React,useState:initial=>React.useState(initial==='companion'?tab:initial)};
  const primitives={Button:({variant,size,children,...props})=>{
    if(typeof children==='string') hooks.buttons?.set(children,props);
    return React.createElement('button',props,children);
  },
    Switch:({checked,label,disabled,onChange,title})=>{
      hooks.switches?.set(label,{checked,disabled,onChange});
      return React.createElement('button',{role:'switch','aria-label':label,'aria-checked':checked,disabled,title,onClick:()=>onChange(!checked)});
    }};
  let entry;
  new Script(bundle).runInNewContext({window:{__ModuleLoader__:{load:value=>{entry=value;}}},AbortController,setInterval,clearInterval});
  const plugin=entry.factory(name=>name==='react'?injectedReact:name==='@deepseek-ai/dsh-client-ui-primitives'?primitives:(()=>{throw new Error('Unexpected external');})());
  plugin.apply({connection:{rpc:{call(){throw new Error('SSR must not access the Host');}}},effect:callback=>{const off=callback();if(typeof off==='function')effects.push(off);},
    on:()=>()=>{},locale:{register:()=>()=>{},bind:()=>()=>'安静陪伴'},
    slots:{inject:(_slot,callback)=>callback(),register:(options,component)=>{registration={options,component};return()=>{};}}});
  assert.equal(registration.options.name,'settings.section'); assert.equal(registration.options.id,'quiet-companion');
  const injected=registration.options.inject();
  const html=render(React.createElement(registration.component,{controller:hooks.controller??injected.controller,
    useSnapshot:()=>({status:'ready',snapshot,busy:false,error:''})}));
  effects.reverse().forEach(off=>off());
  return html;
}
for(const [tab,labels] of [
  ['companion',['应用感知','画面理解','理解系统播放声音','可能保存在本机共享附件缓存']],
  ['appearance',['动态Q版橙发角色','宠物大小','透明度','朗读模型回应','本机测试声音']],
  ['growth',['陪伴成长','零食库存','每份零食所需 token','本 Host Agent 步骤及宠物自身调用','不计其他应用']],
  ['memory',['保存置顶事实','全部事实与来源','用户原文','清空全部陪伴记忆']],
  ['usage',['显示真实任务进度','今日实际用量','未知','每日 token 上限','尚未查询账户余额']],
]) test(`Host React renders a complete ${tab} page without observation or permission side effects`,{skip:!React},()=>{
  const html=pageFor(tab);
  for(const label of labels) {
    // The clean editor initially describes its accepted state instead of offering a redundant write.
    if(label==='保存置顶事实') assert.match(html,/已与本机同步/u);else assert.ok(html.includes(label),`missing ${label}`);
  }
  assert.equal(html.includes('<script>not-code</script>'),false);
  assert.ok(html.includes('重启宠物'));
  assert.ok(html.includes('测试组件状态 &lt;not-html&gt;'));
  if(tab==='companion') {
    assert.equal(html.includes('ja-JP'),false);
    assert.ok(html.includes('待审批事件'));
  }
  if(tab==='appearance') {
    assert.match(html, /aria-label="朗读速度"[^>]*min="0\.3"[^>]*max="0\.65"/u);
  }
  assert.equal(/<input[^>]+type="password"/u.test(html),false);
  assert.equal(html.includes('打开原生设置窗口'),false);
});

test('Agent progress localizes real phases and displays only observed numeric counters',{skip:!React},()=>{
  const html=pageFor('usage',{...fixture,agent:{available:true,activeCount:1,waitingCount:1,current:{
    phase:'waiting-approval',toolName:'exec_command',turn:4,step:7,observedCompletedSteps:3,
  }}});
  for(const label of ['等待审批','工具：exec_command','当前轮次：4','当前步骤：7','已观察完成步骤：3']) assert.ok(html.includes(label),`missing ${label}`);
  assert.equal(html.includes('waiting-approval'),false);
  assert.equal(html.includes('%'),false);
});

test('missing Agent counters stay absent while observed zero remains factual',{skip:!React},()=>{
  const html=pageFor('usage',{...fixture,agent:{available:true,activeCount:1,waitingCount:0,current:{
    phase:'thinking',turn:null,step:undefined,observedCompletedSteps:0,
  }}});
  assert.ok(html.includes('思考中'));
  assert.ok(html.includes('已观察完成步骤：0'));
  assert.equal(html.includes('当前轮次：'),false);
  assert.equal(html.includes('当前步骤：'),false);
});

test('mouse play is off by default and explains its permission, bounds and immediate release',{skip:!React},()=>{
  const html=pageFor('companion');
  assert.match(html,/aria-label="允许撒娇抢鼠标"[^>]*aria-checked="false"/u);
  for(const label of ['默认关闭','最长 1.5 秒','移动鼠标或按 Esc 立即停止','不点击或输入','macOS 辅助功能权限']) assert.ok(html.includes(label),`missing ${label}`);
  assert.match(html,/<input[^>]*min="5"[^>]*max="120"[^>]*value="20"/u);
  assert.ok(html.includes('辅助功能：待读取'));
});

test('mouse play exposes actual native authorization and active state',{skip:!React},()=>{
  const html=pageFor('companion',{...fixture,settings:{...fixture.settings,mousePlayEnabled:true,mousePlayAfterMinutes:45},
    native:{...fixture.native,mouseAuthorized:true,mousePlayActive:true}});
  assert.match(html,/aria-label="允许撒娇抢鼠标"[^>]*aria-checked="true"/u);
  assert.ok(html.includes('辅助功能：已授权 · 状态：正在轻拉鼠标'));
  assert.match(html,/<input[^>]*min="5"[^>]*max="120"[^>]*value="45"/u);
});

test('the normal mouse test button acts only on an explicit click and reports native safety limits',{skip:!React},async()=>{
  const buttons=new Map(),calls=[];
  const ready={...fixture,settings:{...fixture.settings,observationEnabled:true,mousePlayEnabled:true},
    native:{...fixture.native,mousePlayEnabled:true,mouseAuthorized:true,mousePlayActive:false,
      mouseConsentPending:false,permissionRequestInFlight:false,mouseStatus:'原生指针状态。'}};
  const html=pageFor('companion',ready,{buttons,controller:{action:async action=>{calls.push(action);return true;}}});
  const button=buttons.get('试一下鼠标轻拉');
  assert.ok(button);assert.equal(button.disabled,false);assert.deepEqual(calls,[]);
  for(const text of ['原生 30 分钟冷却仍生效','安全条件不满足时不会移动','实际结果以上方原生状态为准','原生指针状态。'])
    assert.ok(html.includes(text));
  await button.onClick();assert.deepEqual(calls,['test-mouse-play']);
});

test('mouse test stays disabled until the helper, both enable flags, AX grant and observation are confirmed',{skip:!React},()=>{
  const ready={...fixture,settings:{...fixture.settings,observationEnabled:true,mousePlayEnabled:true},
    native:{...fixture.native,mousePlayEnabled:true,mouseAuthorized:true,mousePlayActive:false}};
  for(const snapshot of [
    fixture,{...ready,helper:{running:false}},
    {...ready,settings:{...ready.settings,mousePlayEnabled:false}},
    {...ready,settings:{...ready.settings,observationEnabled:false}},
    {...ready,settings:{...ready.settings,snoozeUntil:Date.now()+60_000}},
    ...['mousePlayEnabled','mouseAuthorized'].flatMap(key=>[false,undefined].map(value=>
      ({...ready,native:{...ready.native,[key]:value}}))),
    ...['mouseConsentPending','permissionRequestInFlight','mousePlayActive'].map(key=>
      ({...ready,native:{...ready.native,[key]:true}})),
  ]) {
    const buttons=new Map();pageFor('companion',snapshot,{buttons});
    assert.equal(buttons.get('试一下鼠标轻拉').disabled,true);
  }
});

test('growth renders actual experience, bounded needs, stacked inventory and waiting reason',{skip:!React},()=>{
  const html=pageFor('growth',{...fixture,growth:{level:3,levelTitle:'陪伴伙伴',experience:25,nextLevelExperience:80,stage:'熟悉',
    satiety:75,energy:64,mood:90,snackCount:25,snacks:[{id:'snack-fixture',kind:'小饼干'}],
    stats:{earnedSnacks:30,eatenSnacks:5,trackedTokens:60000},status:'她正在专注，稍后再吃。'}});
  for(const label of ['Lv. 3 · 陪伴伙伴','阶段：熟悉','升级经验：25 / 80','75 / 100','64 / 100','90 / 100','当前库存：25 份',
    '小饼干 · 1','累计获得 30 份 · 已吃 5 份 · 已记录 60,000 token','她正在专注，稍后再吃。']) assert.ok(html.includes(label),`missing ${label}`);
  assert.match(html,/<progress[^>]*value="25"[^>]*max="80"/u);
  assert.match(html,/<input[^>]*min="100"[^>]*max="100000"[^>]*value="2000"/u);
  assert.match(html,/<button(?![^>]*disabled)[^>]*>递一份零食<\/button>/u);
  assert.equal(html.includes('清空成长'),false);
});

test('growth with no snacks disables offering and never invents missing metrics',{skip:!React},()=>{
  const html=pageFor('growth',{...fixture,growth:{snackCount:0,snacks:[],stats:{}}});
  assert.ok(html.includes('当前库存：0 份'));
  assert.match(html,/<button[^>]*disabled=""[^>]*>递一份零食<\/button>/u);
  assert.equal(html.includes('<progress'),false);
  assert.equal(html.includes('<meter'),false);
  assert.equal(html.includes('NaN'),false);
  assert.ok(html.includes('未上报用量不推算'));
  assert.ok(html.includes('不需要额外 API Key 或系统授权'));
  assert.equal(html.includes('购买零食'),false);
});

test('desktop growth panel toggle defaults off and stays independent from growth and snack controls',{skip:!React},()=>{
  const previous=pageFor('growth');
  assert.match(previous,/aria-label="显示桌面成长状态栏"[^>]*aria-checked="false"/u);
  assert.ok(previous.includes('零食仍散落在角色身边'));
  assert.ok(previous.includes('完整成长信息可在这里查看'));
  for(const visible of [true,false]) {
    const html=pageFor('growth',{...fixture,settings:{...fixture.settings,growthEnabled:true,growthPanelVisible:visible}});
    assert.match(html,new RegExp(`aria-label="显示桌面成长状态栏"[^>]*aria-checked="${visible}"`,'u'));
    assert.match(html,/aria-label="启用成长"[^>]*aria-checked="true"/u);
    assert.equal((html.match(/aria-label="显示桌面成长状态栏"/gu)??[]).length,1);
  }
});

test('pending OS permission shows real wait/restart state and blocks repeat enable while allowing cancellation',{skip:!React},()=>{
  const switches=new Map();
  const html=pageFor('companion',{...fixture,native:{...fixture.native,screenPermissionState:'restart-required',
    screenStatus:'系统权限需重启后生效。',screenConsentPending:true,audioConsentPending:true,mouseConsentPending:true,
    permissionsNeedRestart:true,audioAuthorized:false,mouseAuthorized:false}}, {switches});
  for(const label of ['画面理解','理解系统播放声音','允许撒娇抢鼠标']) {
    assert.equal(switches.get(label).checked,false,label);
    assert.equal(switches.get(label).disabled,true,label);
  }
  for(const label of ['系统权限需重启后生效。','重新检查系统权限','重启宠物以应用权限',
    '取消画面开启','取消声音开启','取消鼠标开启']) assert.ok(html.includes(label),label);
  assert.match(html,/<button(?![^>]*disabled)[^>]*>取消画面开启<\/button>/u);
});

test('restarted authorized screen configuration replaces only the exact stale initialization message',{skip:!React},()=>{
  const stale='画面理解未开启；需要同意向当前模型发送画面并获得系统权限。';
  const configured='画面理解已配置；仅在观察开启且有变化时按需采样。';
  for(const helper of [true,{running:true},{alive:true}]) for(const observationEnabled of [false,true]) {
    const html=pageFor('companion',{...fixture,helper,
      settings:{...fixture.settings,screenEnabled:true,observationEnabled},
      native:{...fixture.native,screenEnabled:true,screenAuthorized:true,screenStatus:stale,
        screenConsentPending:false,permissionRequestInFlight:false}});
    assert.ok(html.includes(configured));assert.equal(html.includes(stale),false);
    assert.equal(html.includes('画面理解已配置，但观察已暂停，当前不采集画面。'),!observationEnabled);
    assert.equal(html.includes('已发送关键帧'),false);
  }
});

test('screen feedback preserves errors and all unconfirmed or disconnected restart states',{skip:!React},()=>{
  const stale='画面理解未开启；需要同意向当前模型发送画面并获得系统权限。';
  const configured='画面理解已配置；仅在观察开启且有变化时按需采样。';
  const enabled={...fixture,settings:{...fixture.settings,screenEnabled:true,observationEnabled:true},
    native:{...fixture.native,screenEnabled:true,screenAuthorized:true,screenStatus:stale,
      screenConsentPending:false,permissionRequestInFlight:false}};
  const cases=[
    {...enabled,helper:{running:false}},
    {...enabled,helper:false},
    {...enabled,settings:{...enabled.settings,screenEnabled:false}},
    ...['screenEnabled','screenAuthorized'].flatMap(key=>[false,undefined].map(value=>
      ({...enabled,native:{...enabled.native,[key]:value}}))),
    {...enabled,native:{...enabled.native,screenConsentPending:true}},
    {...enabled,native:{...enabled.native,permissionRequestInFlight:true}},
    ...['系统屏幕权限不可用；请重新检查。','正在等待本次同意。',`${stale} `].map(screenStatus=>
      ({...enabled,native:{...enabled.native,screenStatus}})),
  ];
  for(const snapshot of cases) {
    const html=pageFor('companion',snapshot);
    assert.equal(html.includes(configured),false);
    assert.ok(html.includes(snapshot.native.screenStatus));
  }
});

test('screen frame diagnostics render received local time and escaped source without claiming model success',{skip:!React},()=>{
  const lastReceivedAt=Date.now();
  const html=pageFor('companion',{...fixture,screenFrames:{count:2,lastReceivedAt,sourceApp:'Synthetic Player <private>'}});
  assert.ok(html.includes('45 秒内可用帧：2/3'));
  assert.ok(html.includes(new Date(lastReceivedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})));
  assert.ok(html.includes('来源应用：Synthetic Player &lt;private&gt;'));
  assert.equal(html.includes('已发送关键帧'),false);assert.equal(html.includes('已看到画面'),false);
});

test('screen frame diagnostics stay at zero when disconnected and handle empty or invalid timestamps safely',{skip:!React},()=>{
  for(const snapshot of [fixture,{...fixture,helper:{running:false},screenFrames:{count:3,lastReceivedAt:Date.now(),sourceApp:'Old source'}},
    {...fixture,screenFrames:{count:0,lastReceivedAt:null,sourceApp:''}}]) {
    const html=pageFor('companion',snapshot);
    assert.ok(html.includes('45 秒内可用帧：0/3 · 最近收到：暂无有效帧 · 来源应用：—'));
    assert.equal(html.includes('Old source'),false);
  }
  for(const lastReceivedAt of [null,'not-a-timestamp',Number.NaN,Number.POSITIVE_INFINITY,9e20]) {
    const html=pageFor('companion',{...fixture,screenFrames:{count:1,lastReceivedAt,sourceApp:''}});
    assert.ok(html.includes('45 秒内可用帧：1/3 · 最近收到：未知 · 来源应用：未知'));
    assert.equal(/Invalid Date|NaN/u.test(html),false);
  }
});

test('an explicit off remains available with lost helper/model capability or another pending dialog',{skip:!React},async()=>{
  const switches=new Map(),calls=[];
  const controller={update:async patch=>{calls.push(patch);return true;}};
  pageFor('companion',{...fixture,helper:{running:false},route:{...fixture.route,vision:false},
    settings:{...fixture.settings,screenEnabled:true,videoAudioEnabled:true,mousePlayEnabled:true},
    native:{...fixture.native,permissionRequestInFlight:true}}, {switches,controller});
  for(const [label,key] of [['画面理解','screenEnabled'],['理解系统播放声音','videoAudioEnabled'],['允许撒娇抢鼠标','mousePlayEnabled']]) {
    assert.equal(switches.get(label).checked,true);assert.equal(switches.get(label).disabled,false,label);
    await switches.get(label).onChange(false);assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{[key]:false});
  }
});

test('permission recheck never turns a pending request on by itself and granted state permits explicit continuation',{skip:!React},()=>{
  const switches=new Map();
  const html=pageFor('companion',{...fixture,native:{...fixture.native,screenPermissionState:'granted',screenAuthorized:true,
    audioAuthorized:true,mouseAuthorized:true,screenConsentPending:true,audioConsentPending:true,mouseConsentPending:true}}, {switches});
  for(const label of ['画面理解','理解系统播放声音','允许撒娇抢鼠标']) {
    assert.equal(switches.get(label).checked,false);assert.equal(switches.get(label).disabled,false,label);
  }
  assert.ok(html.includes('点击画面开关继续开启'));
});

test('reenabling application sensing explicitly ends snooze instead of showing an inactive enabled switch',{skip:!React},async()=>{
  const switches=new Map(),calls=[];
  const html=pageFor('companion',{...fixture,settings:{...fixture.settings,snoozeUntil:Date.now()+600000}},
    {switches,controller:{update:async patch=>{calls.push(patch);return true;}}});
  await switches.get('应用感知').onChange(true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{observationEnabled:true,snoozeUntil:0}]);
  assert.ok(html.includes('恢复观察'));assert.ok(html.includes('正在临时安静'));
});

test('every settings switch sends its own boolean and reflects the Host echo without granting other features',{skip:!React},async()=>{
  const cases=[['companion','应用感知','observationEnabled'],['companion','会议中减少主动打扰','quietMeetingApps'],
    ['companion','优先提醒任务待确认','urgentAgentAlerts'],['appearance','动态Q版橙发角色','dynamicSkinEnabled'],
    ['appearance','减少动态效果','reduceMotion'],['appearance','朗读模型回应','voiceEnabled'],['appearance','语音口型','lipSyncEnabled'],
    ['growth','启用成长','growthEnabled'],['growth','显示桌面成长状态栏','growthPanelVisible'],
    ['growth','按 token 获得零食','snackRewardsEnabled'],['growth','允许自动吃零食','autoEatEnabled'],
    ['memory','使用记忆','memoryEnabled'],['usage','显示真实任务进度','agentProgressEnabled']];
  for(const [tab,label,key] of cases) {
    let settings={...fixture.settings};const calls=[];
    const controller={update:async patch=>{calls.push(patch);settings={...settings,...patch};return true;}};
    for(const value of [true,false]) {
      const switches=new Map();pageFor(tab,{...fixture,settings},{controller,switches});
      await switches.get(label).onChange(value);
      assert.equal(calls.at(-1)[key],value,label+' write');
      const echoed=new Map();pageFor(tab,{...fixture,settings},{controller,switches:echoed});
      assert.equal(echoed.get(label).checked,value,label+' echo');
      assert.equal(settings.screenEnabled,false);assert.equal(settings.videoAudioEnabled,false);
      assert.notEqual(settings.mousePlayEnabled,true);
    }
  }
});

test('protected enable switches dispatch distinct native consent actions instead of saving true booleans',{skip:!React},async()=>{
  const switches=new Map(),actions=[];
  pageFor('companion',fixture,{switches,controller:{action:async action=>{actions.push(action);return true;},
    update:()=>{throw new Error('Enabling a protected feature must not save a true patch.');}}});
  for(const label of ['画面理解','理解系统播放声音','允许撒娇抢鼠标']) await switches.get(label).onChange(true);
  assert.deepEqual(actions,['request-screen-permission','request-audio-permission','request-mouse-permission']);
});
