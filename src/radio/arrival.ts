import { createHash } from 'node:crypto';
import { z } from 'zod';
import { haversineMeters } from '../geo/haversine.js';
import { positionSchema,type Position } from './schema.js';
import type { RadioFrame } from './engine.js';

const fixSchema=positionSchema.extend({bootId:z.string().min(1).max(200),elapsedMs:z.number().int().nonnegative(),
  accuracyM:z.number().finite().min(0),speedMps:z.number().finite().nonnegative()}).strict();
const signal=z.number().finite().min(-200).max(30);
const reportSchema=z.object({
  imageId:z.string().min(1),sessionId:z.string().uuid(),bootId:z.string().min(1),frameHash:z.string().regex(/^[a-f0-9]{64}$/),
  observedElapsedMs:z.number().int().nonnegative(),scope:z.literal('ANDROID_API_READBACK'),
  wifi:z.array(z.object({bssid:z.string(),ssid:z.string(),frequencyMHz:z.number().positive(),rssiDbm:signal,timestampUs:z.number().int().nonnegative()}).strict()).max(10000).nullable(),
  cells:z.array(z.object({identifier:z.string(),registered:z.boolean(),rsrpDbm:signal}).strict()).max(10000).nullable(),
  bluetooth:z.array(z.object({address:z.string(),rssiDbm:signal}).strict()).max(10000).nullable(),
}).strict();
export type ArrivalState='MOVING'|'SETTLING'|'READY_TO_APPLY'|'AWAITING_READBACK'|'VERIFIED'|'BLOCKED';
export const hashFrame=(frame:RadioFrame)=>createHash('sha256').update(JSON.stringify(frame)).digest('hex');

/** Pure lifecycle gate. Its inputs must come from an authenticated phone adapter, not API acceptance. */
export class ArrivalGate {
  state:ArrivalState='MOVING';
  reason:string|null=null;
  private started?:number;
  private latest?:z.infer<typeof fixSchema>;
  private bootId?:string;
  private expected?:RadioFrame;
  private issuedAt?:number;
  readonly destination:Position;
  constructor(readonly imageId:string,readonly sessionId:string,destination:Position,
    readonly dwellMs=30000,readonly radiusM=30) {
    this.destination=positionSchema.parse(destination);
    z.string().min(1).parse(imageId);z.string().uuid().parse(sessionId);
    if(!Number.isFinite(dwellMs)||dwellMs<1000||!Number.isFinite(radiusM)||radiusM<=0)throw new Error('Invalid arrival criteria');
  }
  observeFix(raw:unknown,nowElapsedMs:number):ArrivalState {
    const f=fixSchema.parse(raw);
    if(!Number.isSafeInteger(nowElapsedMs)||nowElapsedMs<0)throw new Error('Invalid phone clock');
    if(this.state==='BLOCKED')return this.state;
    if(this.bootId&&this.bootId!==f.bootId)return this.block('PHONE_RESTARTED');
    this.bootId=f.bootId;
    if(f.elapsedMs>nowElapsedMs||nowElapsedMs-f.elapsedMs>5000)return this.block('LOCATION_STALE');
    if(this.latest&&f.elapsedMs<=this.latest.elapsedMs)return this.block('LOCATION_REPLAY');
    const gap=this.latest?f.elapsedMs-this.latest.elapsedMs:0;
    this.latest=f;
    const arrived=f.accuracyM<=30&&f.speedMps<=1&&haversineMeters(f.lat,f.lng,this.destination.lat,this.destination.lng)<=this.radiusM;
    if(!arrived||gap>5000) {
      this.started=undefined;
      if(this.expected)return this.block('ARRIVAL_LOST');
      this.state='MOVING';return this.state;
    }
    this.started??=f.elapsedMs;
    if(!this.expected)this.state=f.elapsedMs-this.started>=this.dwellMs?'READY_TO_APPLY':'SETTLING';
    return this.state;
  }
  prepare(frame:RadioFrame,nowElapsedMs:number):string {
    if(this.state!=='READY_TO_APPLY'||!this.latest||nowElapsedMs<this.latest.elapsedMs||nowElapsedMs-this.latest.elapsedMs>5000)throw new Error('Fresh stationary arrival required');
    if(frame.imageId!==this.imageId||frame.sessionId!==this.sessionId)throw new Error('Wrong phone or session');
    if(haversineMeters(frame.position.lat,frame.position.lng,this.latest.lat,this.latest.lng)>this.radiusM)throw new Error('Environment position mismatch');
    // Missing metadata cannot be silently certified as a complete radio environment.
    if(frame.warnings.length)throw new Error('Resolve radio coverage and metadata warnings before application');
    if(frame.bluetoothAction!=='REPLACE'||frame.bluetooth===null)throw new Error('Arrival Bluetooth frame required');
    this.expected=structuredClone(frame);this.issuedAt=nowElapsedMs;this.state='AWAITING_READBACK';
    return hashFrame(this.expected);
  }
  verify(raw:unknown,nowElapsedMs:number):ArrivalState {
    const report=reportSchema.parse(raw),expected=this.expected;
    if(this.state!=='AWAITING_READBACK'||!expected)throw new Error('No pending environment application');
    if(!Number.isSafeInteger(nowElapsedMs)||nowElapsedMs<0)throw new Error('Invalid phone clock');
    if(report.imageId!==this.imageId||report.sessionId!==this.sessionId||report.bootId!==this.bootId||report.frameHash!==hashFrame(expected))return this.block('READBACK_IDENTITY_MISMATCH');
    if(report.observedElapsedMs<this.issuedAt!||report.observedElapsedMs>nowElapsedMs||nowElapsedMs-report.observedElapsedMs>5000||nowElapsedMs-this.issuedAt!>60000)return this.block('READBACK_STALE');
    if(!this.latest||nowElapsedMs-this.latest.elapsedMs>5000)return this.block('LOCATION_STALE');
    if(report.wifi===null||report.cells===null||report.bluetooth===null)return this.block('RADIO_READBACK_UNAVAILABLE');
    const equal=<T,U>(want:T[],got:U[],key1:(r:T)=>string,key2:(r:U)=>string,matches:(a:T,b:U)=>boolean)=>{
      const map=new Map(got.map(r=>[key2(r),r]));
      return map.size===got.length&&got.length===want.length&&want.every(a=>{const b=map.get(key1(a));return b!==undefined&&matches(a,b);});
    };
    const wifi=equal(expected.wifi,report.wifi,a=>a.bssid,a=>a.bssid.toLowerCase(),(a,b)=>a.ssid===b.ssid&&a.frequencyMHz===b.frequencyMHz&&Math.abs(a.rssiDbm-b.rssiDbm)<=3&&b.timestampUs>=this.issuedAt!*1000&&b.timestampUs<=report.observedElapsedMs*1000);
    const cell=equal(expected.cells,report.cells,a=>a.identifier,a=>a.identifier,(a,b)=>a.registered===b.registered&&Math.abs(a.rsrpDbm-b.rsrpDbm)<=3);
    const bt=equal(expected.bluetooth??[],report.bluetooth,a=>a.address,a=>a.address.toLowerCase(),(a,b)=>Math.abs(a.rssiDbm-b.rssiDbm)<=3);
    if(!wifi||!cell||!bt)return this.block('RADIO_MISMATCH');
    this.state='VERIFIED';this.reason=null;return this.state;
  }
  private block(reason:string):ArrivalState {this.state='BLOCKED';this.reason=reason;return this.state;}
}
