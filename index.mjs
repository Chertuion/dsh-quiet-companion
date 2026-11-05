import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompanionRuntime } from './lib/runtime.mjs';
import { launchNativeHelper } from './lib/helper.mjs';
import { createHelperRestarter, clearHelperTransientState } from './lib/helper-restart.mjs';
import { createSettingsHandler } from './lib/settings-rpc.mjs';
import { registerSettingsChannel } from './lib/host-channel.mjs';

export const name='quiet-companion';
export const inject=['connection','webServer'];

/** Own one independent native app and an owner-only Harness settings surface. */
export function apply(ctx) {
  ctx.effect(()=>{
    if(process.platform!=='darwin'||process.arch!=='arm64') throw new Error('安静陪伴仅支持 Apple Silicon macOS。');
    const appPath=join(dirname(fileURLToPath(import.meta.url)),'native/QuietCompanion.app');
    if(!existsSync(join(appPath,'Contents/MacOS/QuietCompanion'))) throw new Error('安静陪伴安装包缺少原生组件，请重新安装。');
    let disposed=false,helper;
    const pending=new Set();
    const runtime=new CompanionRuntime(ctx,{send:message=>helper?.send(message),
      stateDir:join(process.env.DSH_HOME||join(homedir(),'.dsh'),'quiet-companion')});
    const receive=(message,source)=>{
      const isCurrent=()=>!disposed&&helper===source;
      if(!isCurrent()) return;
      const work=runtime.handle(message,{isCurrent}).catch(()=>{
        if(isCurrent()) runtime.status('这次操作未完成，请检查模型配置或本机权限。');
      });
      pending.add(work);void work.finally(()=>pending.delete(work));
    };
    const start=()=>{
      const current=launchNativeHelper({appPath,onMessage:message=>receive(message,current),onExit:reason=>{
        if(disposed||helper!==current) return;
        helper=undefined;
        clearHelperTransientState(runtime);runtime.status(reason+' 当前不采集画面或声音。');
        void current.dispose();
      }});
      helper=current;
      void current.ready.catch(()=>{if(!disposed&&helper===current) runtime.status(current.state.error||'宠物尚未启动，请重试。');});
      return current.ready;
    };
    void runtime.ready.catch(()=>runtime.status('本地设置或记忆读取失败，观察尚未开始。'));
    const restarter=createHelperRestarter({runtime,start,isDisposed:()=>disposed,
      detach:()=>{const previous=helper;helper=undefined;return previous;}});
    const handler=createSettingsHandler({runtime,getHelper:()=>helper,restartHelper:restarter.restart});
    let stopChannel;
    try {stopChannel=registerSettingsChannel(ctx,handler);}
    catch(error) {void runtime.dispose().catch(()=>{});throw error;}
    void start().catch(()=>{});
    return async()=>{
      if(disposed) return;
      disposed=true;
      const stoppingRuntime=runtime.dispose();
      await Promise.allSettled([stoppingRuntime,stopChannel?.(),helper?.dispose(),...(restarter.pending?[restarter.pending]:[]),...pending]);
    };
  });
}
