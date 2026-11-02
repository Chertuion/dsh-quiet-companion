/** Owner-only Host settings channel. Perception consent stays with explicit native controls. */
const editable=new Set(['observationEnabled','captureIntervalSeconds','snoozeUntil','screenEnabled',
  'videoAudioEnabled','speechLanguage','voiceEnabled','voiceIdentifier','voiceRate','memoryEnabled',
  'agentProgressEnabled','reduceMotion','dynamicSkinEnabled','quietMeetingApps','quietApps',
  'urgentAgentAlerts','dailyTokenBudget','dailyBudget','inputPricePerMillion','outputPricePerMillion',
  'mousePlayEnabled','mousePlayAfterMinutes','growthEnabled','snackRewardsEnabled','autoEatEnabled','tokensPerSnack','growthPanelVisible']);
const bounded=(value,max=16000)=>typeof value==='string'?value.slice(0,max):'';

export function createSettingsHandler({runtime,getHelper,restartHelper}) {
  return async(endpoint,payload,signal,peer)=>{
    if(peer?.principal?.kind!=='owner') return {ok:false,error:{code:'forbidden',message:'只有此 Harness 的所有者可以管理陪伴设置。',details:{}}};
    if(signal?.aborted||peer.signal?.aborted) return {ok:false,error:{code:'aborted',message:'连接已关闭。',details:{}}};
    const snapshot=async()=>({...await runtime.snapshot(),helper:{...(getHelper()?.state||{running:false,starting:false})}});
    try {
      await runtime.ready;
      signal?.throwIfAborted();peer.signal?.throwIfAborted();
      const data=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:{};
      if(endpoint==='snapshot') return {ok:true,value:await snapshot()};
      if(endpoint==='update-settings') {
        const patch={};
        if(data.patch&&typeof data.patch==='object'&&!Array.isArray(data.patch)) {
          for(const [key,value] of Object.entries(data.patch)) if(editable.has(key)) patch[key]=value;
        }
        if(patch.screenEnabled===true&&!runtime.settings.screenEnabled || patch.videoAudioEnabled===true&&!runtime.settings.videoAudioEnabled
          ||patch.mousePlayEnabled===true&&!runtime.settings.mousePlayEnabled) {
          return {ok:false,error:{code:'explicit-consent-required',message:'请使用对应的授权按钮开启此功能。',details:{}}};
        }
        if(patch.screenEnabled===false) patch.consentPair='';
        if(patch.videoAudioEnabled===false) patch.audioConsentPair='';
        await runtime.handle({type:'settings',...patch});
      } else if(endpoint==='action') {
        const action=data.action;
        if(action==='refresh-model') await runtime.refreshRoute(true);
        else if(action==='growth-refresh') await runtime.handle({type:'request-growth'});
        else if(action==='offer-snack'||action==='feed') await runtime.handle({type:'snack-offer',id:bounded(data.id,100)});
        else if(action==='refresh-usage') await runtime.handle({type:'request-usage'});
        else if(action==='memory-save') await runtime.handle({type:'memory-save',text:bounded(data.text)});
        else if(action==='memory-clear') await runtime.handle({type:'memory-clear'});
        else if(action==='memory-forget') {
          const target=bounded(data.text,1000).trim();
          if(!target) throw new Error('请选择要遗忘的记忆。');
          await runtime.handle({type:'chat',text:'/forget '+target});
        } else if(action==='restart-pet') await restartHelper();
        else {
          const actions={'request-screen-permission':'enable-screen','request-audio-permission':'enable-system-audio',
            'request-speech-permission':'enable-system-audio','show-pet':'show','hide-pet':'hide',
            'pause':'pause','resume':'resume','snooze':'snooze','feed':'feed','sleep':'sleep','wake':'wake',
            'set-appearance':'set-appearance','open-native-settings':'open-settings','request-mouse-permission':'enable-mouse-play'};
          const nativeAction=actions[action];
          if(!nativeAction) throw new Error('不支持此操作。');
          const helper=getHelper();
          if(!helper?.state.running) throw new Error('宠物尚未运行，请先重新启动宠物。');
          await runtime.refreshRoute();
          signal?.throwIfAborted();peer.signal?.throwIfAborted();
          if(nativeAction==='enable-screen'&&!runtime.visionAvailable) throw new Error('当前 Harness 默认模型不支持图片，暂时无法开启画面理解。');
          if(['enable-screen','enable-system-audio'].includes(nativeAction)&&!runtime.route) throw new Error('请先在 Harness 中配置默认模型。');
          const command={type:'control',action:nativeAction};
          if(nativeAction==='set-appearance') {
            if(Number.isFinite(data.scale)) command.scale=Math.min(1.6,Math.max(0.6,data.scale));
            if(Number.isFinite(data.opacity)) command.opacity=Math.min(1,Math.max(0.45,data.opacity));
          }
          if(!helper.send(command)) throw new Error('宠物连接已关闭，请重新启动。');
        }
      } else return {ok:false,error:{code:'not-found',message:'未知陪伴设置接口。',details:{}}};
      return {ok:true,value:await snapshot()};
    } catch(error) {
      const safe=new Set(['请选择要遗忘的记忆。','不支持此操作。','宠物尚未运行，请先重新启动宠物。',
        '当前 Harness 默认模型不支持图片，暂时无法开启画面理解。','请先在 Harness 中配置默认模型。','宠物连接已关闭，请重新启动。']);
      return {ok:false,error:{code:'operation-failed',message:safe.has(error?.message)?error.message:'操作未完成，请检查本机组件状态。',details:{}}};
    }
  };
}
