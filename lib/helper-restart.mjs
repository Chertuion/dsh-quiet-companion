/** Restart only the transport; saved consent and explicit feature choices remain authoritative. */
export function clearHelperTransientState(runtime) {
  runtime.cancel();runtime.clearFrames();runtime.clearTranscript();
  runtime.latest=null;runtime.pendingStart=null;
  // Do not mistake a disconnected helper for an OS permission denial or wake a resting pet.
  const petSleeping=runtime.native?.petSleeping;
  runtime.native={screenEnabled:false,audioEnabled:false,mousePlayEnabled:false,mousePlayActive:false,
    screenConsentPending:false,audioConsentPending:false,mouseConsentPending:false,permissionRequestInFlight:false,
    screenPermissionState:'unavailable',screenStatus:'宠物组件未连接，当前不采集画面。',
    audioStatus:'宠物组件未连接，当前不采集声音。',mouseStatus:'宠物组件未连接，指针互动未运行。',
    ...(typeof petSleeping==='boolean'?{petSleeping}:{})};
}

export function createHelperRestarter({runtime,detach,start,isDisposed=()=>false}) {
  let pending;
  return {
    get pending() {return pending;},
    restart() {
      if(pending) return pending;
      pending=(async()=>{
        await runtime.ready;
        if(isDisposed()) return;
        // Revoke the old transport before dispose can publish its final messages.
        const previous=detach();
        clearHelperTransientState(runtime);
        await previous?.dispose();
        if(!isDisposed()) await start();
      })().finally(()=>{pending=undefined;});
      return pending;
    },
  };
}
