/** Scenario visibility policy. Distances are test inputs, not measured RF coverage. */
export class WifiVisibility {
  private visible=new Set<string>();
  constructor(private readonly p:{entryDbm:number;exitDbm:number;entryM:number;exitM:number}){
    if(!Object.values(p).every(Number.isFinite)||p.exitDbm>p.entryDbm||p.entryM<=0||p.exitM<p.entryM)throw new Error('Invalid Wi-Fi hysteresis thresholds');
  }
  update(id:string,signal:number,distance:number){
    if(!id||!Number.isFinite(signal)||!Number.isFinite(distance)||distance<0)throw new Error('Invalid visibility candidate');
    const existing=this.visible.has(id),present=signal>=(existing?this.p.exitDbm:this.p.entryDbm)&&distance<=(existing?this.p.exitM:this.p.entryM);
    if(present)this.visible.add(id);else this.visible.delete(id);return present;
  }
  retain(ids:ReadonlySet<string>){for(const id of this.visible)if(!ids.has(id))this.visible.delete(id);}
}
export interface ArrivalEvidence {nowMs:number;sampledMs:number;distanceM:number;speedMps:number|null;accuracyM:number|null;terminal:boolean}
/** An explicit desired connection, never evidence of Android association. One instance per device boot/session. */
export class DestinationIntent {
  private last=-1;private lastSample=-1;private since:number|null=null;private exiting:number|null=null;
  private phase:'TRAVELING'|'ARRIVAL_PENDING'|'ARRIVED'|'DEPARTING'='TRAVELING';
  constructor(private readonly bssid:string,private readonly p={entryM:25,exitM:40,dwellMs:15000,exitDwellMs:10000,maxGapMs:2000,maxAgeMs:2000,maxSpeedMps:0.8,maxAccuracyM:25}){
    if(!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bssid)||['00:00:00:00:00:00','ff:ff:ff:ff:ff:ff','02:00:00:00:00:00'].includes(bssid))throw new Error('Invalid destination BSSID');
    if(!Object.values(p).every(n=>Number.isFinite(n)&&n>0)||p.exitM<=p.entryM)throw new Error('Invalid arrival thresholds');
  }
  snapshot(){return{phase:this.phase,desiredBssid:this.phase==='ARRIVED'||this.phase==='DEPARTING'?this.bssid:null,connected:false as const,evidenceClass:'CONNECTION_INTENT' as const};}
  update(f:ArrivalEvidence){
    if(!Number.isSafeInteger(f.nowMs)||f.nowMs<0||f.nowMs<this.last)throw new Error('Arrival clock regression');
    const gap=this.last>=0&&f.nowMs-this.last>this.p.maxGapMs;this.last=f.nowMs;
    const fresh=Number.isSafeInteger(f.sampledMs)&&f.sampledMs>=0&&f.sampledMs>this.lastSample&&f.sampledMs<=f.nowMs&&f.nowMs-f.sampledMs<=this.p.maxAgeMs;
    if(gap){this.since=null;this.exiting=null;this.phase='TRAVELING';}
    if(fresh)this.lastSample=f.sampledMs;
    const usable=fresh&&Number.isFinite(f.distanceM)&&f.distanceM>=0&&f.accuracyM!==null&&Number.isFinite(f.accuracyM)&&f.accuracyM>=0&&f.accuracyM<=this.p.maxAccuracyM;
    if(!usable){this.since=null;this.exiting=null;this.phase='TRAVELING';return this.snapshot();}
    if(this.phase==='ARRIVED'||this.phase==='DEPARTING'){
      if(f.distanceM>this.p.exitM){this.exiting??=f.nowMs;this.phase='DEPARTING';if(f.nowMs-this.exiting>=this.p.exitDwellMs){this.phase='TRAVELING';this.since=null;this.exiting=null;}}
      else{this.phase='ARRIVED';this.exiting=null;}return this.snapshot();
    }
    const stopped=f.speedMps!==null&&Number.isFinite(f.speedMps)&&f.speedMps>=0&&f.speedMps<this.p.maxSpeedMps;
    if(f.terminal&&stopped&&f.distanceM<=this.p.entryM){this.since??=f.nowMs;this.phase=f.nowMs-this.since>=this.p.dwellMs?'ARRIVED':'ARRIVAL_PENDING';}
    else{this.since=null;this.phase='TRAVELING';}
    return this.snapshot();
  }
}
