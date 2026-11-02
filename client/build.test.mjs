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
function pageFor(tab,snapshot=fixture) {
  let registration;
  const effects=[];
  const injectedReact={...React,useState:initial=>React.useState(initial==='companion'?tab:initial)};
  const primitives={Button:({variant,size,children,...props})=>React.createElement('button',props,children),
    Switch:({checked,label,disabled,onChange,title})=>React.createElement('button',{role:'switch','aria-label':label,'aria-checked':checked,disabled,title,onClick:()=>onChange(!checked)})};
  let entry;
  new Script(bundle).runInNewContext({window:{__ModuleLoader__:{load:value=>{entry=value;}}},AbortController,setInterval,clearInterval});
  const plugin=entry.factory(name=>name==='react'?injectedReact:name==='@deepseek-ai/dsh-client-ui-primitives'?primitives:(()=>{throw new Error('Unexpected external');})());
  plugin.apply({connection:{rpc:{call(){throw new Error('SSR must not access the Host');}}},effect:callback=>{const off=callback();if(typeof off==='function')effects.push(off);},
    on:()=>()=>{},locale:{register:()=>()=>{},bind:()=>()=>'安静陪伴'},
    slots:{inject:(_slot,callback)=>callback(),register:(options,component)=>{registration={options,component};return()=>{};}}});
  assert.equal(registration.options.name,'settings.section'); assert.equal(registration.options.id,'quiet-companion');
  const injected=registration.options.inject();
  const html=render(React.createElement(registration.component,{controller:injected.controller,
    useSnapshot:()=>({status:'ready',snapshot,busy:false,error:''})}));
  effects.reverse().forEach(off=>off());
  return html;
}
for(const [tab,labels] of [
  ['companion',['应用感知','画面理解','理解系统播放声音','可能保存在本机共享附件缓存']],
  ['appearance',['动态鲸尾女仆','宠物大小','透明度','朗读模型回应','本机测试声音']],
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
