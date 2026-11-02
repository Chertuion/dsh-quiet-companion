/** Opt-in, event-gated local affection gesture. Never generates clicks or model requests. */
export class MousePlayPolicy {
  constructor({now=Date.now}={}) {this.now=now;this.lastInteraction=now();this.lastPlayed=null;}
  interact() {this.lastInteraction=this.now();}
  evaluate(observation,settings,{agent,native}={}) {
    const now=this.now();
    if(!settings.mousePlayEnabled||!settings.observationEnabled||settings.snoozeUntil>now
      ||native?.mouseAuthorized!==true||native?.permissionRequestInFlight||native?.mousePlayActive) return false;
    if(!observation||observation.idleSeconds>90) return false;
    const app=`${observation.bundleId||''} ${observation.app||''}`.toLowerCase();
    if(/securityagent|loginwindow|systempreferences|system settings|keychain|密码|授权|腾讯会议|飞书会议|zoom|facetime|webex|teams|meeting/u.test(app)) return false;
    if(settings.quietApps?.some(value=>value&&(value.toLowerCase()===observation.bundleId?.toLowerCase()
      ||value.toLowerCase()===observation.app?.toLowerCase()))) return false;
    if(['waiting-approval','waiting-user'].includes(agent?.current?.phase)) return false;
    if(now-this.lastInteraction<(settings.mousePlayAfterMinutes||20)*60_000
      ||this.lastPlayed!==null&&now-this.lastPlayed<30*60_000) return false;
    this.lastPlayed=now;
    return true;
  }
}
