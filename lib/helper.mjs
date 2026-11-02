/** Launch the signed app through LaunchServices, with an owned private duplex bridge. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const states=new Set(['settings','models','status','memory','usage','agent','native-status','mood']);
const timeout=ms=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),ms);timer.unref();});

export function launchNativeHelper({appPath,onMessage=()=>{},onExit=()=>{},preview=false,
  launchProcess,readyTimeoutMs=12_000}={}) {
  let directory,server,socket,launcher,helperPid,authenticated=false,disposed=false,notified=false;
  let resolveReady,rejectReady,resolveExit;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  // Callers may attach after the first asynchronous setup operation.
  void ready.catch(()=>{});
  const exited=new Promise(resolve=>{resolveExit=resolve;});
  const queued=new Map();
  const candidates=new Set();
  const state={running:false,starting:true,launchMode:'launch-services',error:''};
  const notify=reason=>{
    if(notified||disposed) return;
    notified=true; state.running=false;state.starting=false;state.error=reason;
    rejectReady(new Error(reason));
    try {onExit(reason);} catch { /* Keep cleanup independent of observers. */ }
  };
  const write=message=>{
    if(!socket||!authenticated||socket.destroyed||!socket.writable) return false;
    socket.write(JSON.stringify(message)+'\n');return true;
  };
  const send=message=>{
    if(disposed) return false;
    if(write(message)) return true;
    if(state.starting&&states.has(message.type)) queued.set(message.type,message);
    return false;
  };
  const deadline=setTimeout(()=>{
    notify('宠物启动超时，请在陪伴设置中重新启动。');void dispose();
  },readyTimeoutMs);deadline.unref();
  const initialized=(async()=>{
    directory=await mkdtemp('/private/tmp/qc-');await chmod(directory,0o700);
    if(disposed) return;
    const path=join(directory,'bridge.sock'),token=randomUUID();
    server=createServer(candidate=>{
      if(socket||disposed) {candidate.destroy();return;}
      candidates.add(candidate);
      let buffer='';
      candidate.setEncoding('utf8');
      candidate.on('error',()=>{});
      candidate.on('data',chunk=>{
        if(disposed) {candidate.destroy();return;}
        buffer+=chunk;
        if(Buffer.byteLength(buffer)>12*1024*1024) {candidate.destroy();return;}
        while(buffer.includes('\n')) {
          if(disposed) {candidate.destroy();return;}
          const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);
          let message;try {message=JSON.parse(line);} catch {continue;}
          if(!authenticated) {
            if(message?.type!=='ready') continue;
            if(message.ipcToken!==token||!Number.isSafeInteger(message.pid)||message.pid<=1||message.pid===process.pid) {
              candidate.destroy();return;
            }
            socket=candidate;authenticated=true;helperPid=message.pid;
            state.running=true;state.starting=false;clearTimeout(deadline);
            server.close();
            for(const value of queued.values()) write(value);
            queued.clear();resolveReady({...state});
          }
          if(candidate!==socket) {candidate.destroy();return;}
          // Tokens and process ids are transport facts, never published to the UI or model.
          const {ipcToken,pid,parentPid,...publicMessage}=message;
          try {onMessage(publicMessage);} catch { /* Contain malformed observer behavior. */ }
        }
      });
      candidate.on('close',()=>{candidates.delete(candidate);if(candidate===socket) notify('宠物已退出；可在此重新启动。');});
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
    await chmod(path,0o600);
    if(disposed) return;
    const args=['-n','-W','-g',appPath,'--stdin','/dev/null','--stdout','/dev/null','--stderr','/dev/null',
      '--args','--ipc-socket',path,'--ipc-token',token,...(preview?['--preview']:[])];
    launcher=launchProcess?launchProcess({socketPath:path,token,args})
      :spawn('/usr/bin/open',args,{stdio:'ignore',windowsHide:true});
    launcher.once('error',()=>{resolveExit();notify('无法通过 macOS 启动宠物，请重新安装完整插件。');});
    launcher.once('exit',code=>{
      resolveExit();if(!disposed) notify(code===0?'宠物已退出；可在此重新启动。':'macOS 未能启动宠物，请检查安装状态。');
    });
  })().catch(()=>{notify('宠物本机连接初始化失败，请重新启动。');void dispose();});
  let disposing;
  function dispose() {
    if(disposing) return disposing;
    disposed=true;state.running=false;state.starting=false;clearTimeout(deadline);queued.clear();
    rejectReady(new Error('helper-disposed'));
    disposing=(async()=>{
      await initialized.catch(()=>{});
      if(authenticated&&socket&&!socket.destroyed) {
        try {write({type:'shutdown'});} catch { /* Already closing. */ }
      }
      // Unauthenticated peers must not hold the server or a launch attempt alive.
      for(const candidate of candidates) if(candidate!==socket) candidate.destroy();
      if(launcher&&launcher.exitCode===null&&launcher.signalCode===null) {
        const stopped=await Promise.race([exited.then(()=>true),timeout(2000)]);
        if(!stopped&&helperPid) {try {process.kill(helperPid,'SIGTERM');} catch { /* Already stopped. */ }}
        const terminated=stopped||await Promise.race([exited.then(()=>true),timeout(1500)]);
        if(!terminated&&helperPid) {try {process.kill(helperPid,'SIGKILL');} catch { /* Already stopped. */ }}
        if(!terminated) {
          await Promise.race([exited,timeout(1000)]);
          if(launcher.exitCode===null&&launcher.signalCode===null) launcher.kill('SIGTERM');
          await Promise.race([exited,timeout(1000)]);
        }
      }
      for(const candidate of candidates) candidate.destroy();
      socket?.destroy();server?.close();
      if(directory) await rm(directory,{recursive:true,force:true});
    })();
    return disposing;
  }
  return {ready,send,dispose,state,get pid(){return helperPid;}};
}
