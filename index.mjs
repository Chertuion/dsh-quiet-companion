import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CompanionRuntime } from './lib/runtime.mjs';

export const name = 'quiet-companion';

/** Own one native pet and its model/event/memory lifetime without changing the Host configuration. */
export function apply(ctx) {
  ctx.effect(() => {
    if(process.platform!=='darwin'||process.arch!=='arm64') throw new Error('安静陪伴仅支持 Apple Silicon macOS。');
    const executable=join(dirname(fileURLToPath(import.meta.url)),'native/QuietCompanion.app/Contents/MacOS/QuietCompanion');
    if(!existsSync(executable)) throw new Error('安静陪伴安装包缺少原生组件，请安装完整 GitHub 版本或 tgz。');
    let disposed=false;
    let child;
    const send=message=>{
      if(disposed||!child||child.stdin.destroyed||!child.stdin.writable) return;
      try { child.stdin.write(JSON.stringify(message)+'\n'); } catch { /* The owned helper may already be exiting. */ }
    };
    // Validate private state before starting a process that would need an effect disposer.
    const runtime=new CompanionRuntime(ctx,{send,stateDir:join(process.env.DSH_HOME||join(homedir(),'.dsh'),'quiet-companion')});
    try { child=spawn(executable,[],{stdio:['pipe','pipe','pipe'],windowsHide:true}); }
    catch(error) { void runtime.dispose().catch(()=>{}); throw error; }
    const lines=createInterface({input:child.stdout});
    void runtime.ready.catch(()=>send({type:'status',text:'本地设置或记忆读取失败，请检查插件数据目录；观察尚未开始。'}));
    const pending=new Set();
    lines.on('line',line=>{
      if(disposed||line.length>12*1024*1024) return;
      let message; try { message=JSON.parse(line); } catch { return; }
      const work=runtime.handle(message).catch(()=>send({type:'status',text:'这次操作未完成，请检查模型配置或本机权限。'}));
      pending.add(work); void work.finally(()=>pending.delete(work));
    });
    child.stdin.on('error',()=>{});
    child.stderr.on('data',()=>{ /* Never copy screen, permission, account or native diagnostics into Host logs. */ });
    child.on('error',()=>{ void runtime.dispose().catch(()=>{}); lines.close(); });
    child.on('exit',()=>{ void runtime.dispose().catch(()=>{}); lines.close(); });
    return async()=>{
      if(disposed) return;
      disposed=true;
      const cleanup=runtime.dispose();
      try { if(!child.stdin.destroyed&&child.stdin.writable) child.stdin.write('{"type":"shutdown"}\n'); } catch { /* Already exiting. */ }
      child.stdin.end();
      if(child.exitCode===null&&child.signalCode===null) {
        const exited=new Promise(resolve=>child.once('exit',resolve));
        const term=setTimeout(()=>child.kill('SIGTERM'),2000), kill=setTimeout(()=>child.kill('SIGKILL'),5000);
        let timer;
        const stopped=await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),7000);})]);
        clearTimeout(term); clearTimeout(kill); clearTimeout(timer);
        if(!stopped) throw new Error('安静陪伴原生进程尚未退出，请关闭旧宠物后重试。');
      }
      lines.close();
      await Promise.allSettled([cleanup,...pending]);
    };
  });
}
