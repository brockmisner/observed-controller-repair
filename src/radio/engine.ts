import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bearingDegrees,clamp } from '../geo/haversine.js';
import { radioRecordSchema,positionSchema,recordKey,type Position,type RadioRecord } from './schema.js';
import { SpatialIndex } from './spatial.js';

export const radioOptionsSchema=z.object({
  tenantId:z.string().min(1).max(200),imageId:z.string().min(1).max(200),sessionId:z.string().uuid(),
  datasetRevision:z.string().min(1).max(200),mcc:z.string().regex(/^\d{3}$/),mnc:z.string().regex(/^\d{2,3}$/),
  wifiRadiusM:z.number().min(1).max(1000).default(120),cellRadiusM:z.number().min(100).max(50000).default(3000),
  bluetoothRadiusM:z.number().min(1).max(1000).default(60),
  // Scenario cache intervals, not claims about Android's permission to request scans.
  wifiIntervalMs:z.number().int().min(1000).max(1800000).default(30000),
  bluetoothIntervalMs:z.number().int().min(1000).max(1800000).default(30000),
  handoverMarginDb:z.number().min(0).max(20).default(4),timeToTriggerMs:z.number().int().min(0).max(30000).default(4000),
  handoverEvent:z.enum(['A3','A5']).default('A3'),a5ServingDbm:z.number().min(-140).max(-44).default(-110),
  a5NeighborDbm:z.number().min(-140).max(-44).default(-100),
  maxContinuityGapMs:z.number().int().min(1000).max(120000).default(5000),
}).strict();
export type RadioOptions=z.infer<typeof radioOptionsSchema>;
type Wifi={bssid:string;ssid:string;frequencyMHz:number;rssiDbm:number;sampleElapsedMs:number};
type Bluetooth={address:string;name:string|null;rssiDbm:number;sampleElapsedMs:number};
type Cell={identity:NonNullable<RadioRecord['cell']>;identifier:string;frequencyMHz:number;rsrpDbm:number;rsrqDb:null;sinrDb:null;
  timingAdvance:null;registered:boolean;distanceM:number;sampleElapsedMs:number};
export type RadioFrame={version:1;synthetic:true;tenantId:string;imageId:string;sessionId:string;datasetRevision:string;
  sequence:number;elapsedMs:number;position:Position;wifi:Wifi[];cells:Cell[];bluetooth:Bluetooth[]|null;bluetoothAction:'HOLD'|'REPLACE';
  warnings:string[];handover:{from:string|null;to:string|null}|null};

function unit(text:string) {return (createHash('sha256').update(text).digest().readUInt32BE(0)+1)/4294967297;}
function normal(seed:string,bucket:number) {return Math.sqrt(-2*Math.log(unit(`${seed}:${bucket}:a`)))*Math.cos(2*Math.PI*unit(`${seed}:${bucket}:b`));}
function fading(seed:string,time:number) {
  const t=time/10000,b=Math.floor(t),x=t-b,s=x*x*(3-2*x);
  return clamp((normal(seed,b)*(1-s)+normal(seed,b+1)*s)*2,-6,6);
}
export function modeledPower(record:RadioRecord,position:Position,distanceM:number,frequencyMHz:number,variationDb:number):number {
  const p=record.propagation;
  const reference=p??{referenceDbm:-40,referenceDistanceM:1,exponent:3,referenceFrequencyMHz:2400};
  let attenuation=0;
  if(p?.azimuthDeg!=null&&p.beamwidthDeg!=null) {
    const direction=bearingDegrees(record.lat,record.lng,position.lat,position.lng);
    const difference=Math.abs(((direction-p.azimuthDeg+540)%360)-180);
    attenuation=Math.min(p.maxAttenuationDb??25,12*(difference/p.beamwidthDeg)**2);
  }
  return reference.referenceDbm-10*reference.exponent*Math.log10(Math.max(reference.referenceDistanceM,distanceM)/reference.referenceDistanceM)
    -20*Math.log10(frequencyMHz/reference.referenceFrequencyMHz)-attenuation+variationDb;
}

/** Each instance owns exactly one physical phone/session. The shared index has no runtime state. */
export class RadioEngine {
  readonly options:Readonly<RadioOptions>;
  private index:SpatialIndex<RadioRecord>;
  private last?:RadioFrame;
  private lastInput?:string;
  private wifi:Wifi[]=[];
  private bluetooth:Bluetooth[]=[];
  private wifiAt=-Infinity;
  private bluetoothAt=-Infinity;
  private wifiWarnings:string[]=[];
  private bluetoothWarnings:string[]=[];
  private serving:string|null=null;
  private candidate:{key:string;since:number}|null=null;
  private seed:string;
  constructor(records:unknown,options:unknown) {
    this.options=Object.freeze(radioOptionsSchema.parse(options));
    const parsed=z.array(radioRecordSchema).max(10000).parse(records);
    if(new Set(parsed.map(recordKey)).size!==parsed.length)throw new Error('Duplicate radio identities');
    this.index=new SpatialIndex(parsed);
    this.seed=`${this.options.tenantId}:${this.options.imageId}:${this.options.sessionId}`;
  }
  frame(position:Position,elapsedMs:number,sequence:number,phase:'MOVING'|'ARRIVED'='MOVING'):RadioFrame {
    position=positionSchema.parse(position);
    if(!Number.isSafeInteger(elapsedMs)||elapsedMs<0||!Number.isSafeInteger(sequence)||sequence<0)throw new Error('Invalid simulation clock');
    if(!['MOVING','ARRIVED'].includes(phase))throw new Error('Invalid movement phase');
    const input=JSON.stringify([position,elapsedMs,sequence,phase]);
    if(this.last&&input===this.lastInput)return structuredClone(this.last);
    if(this.last&&(sequence<=this.last.sequence||elapsedMs<=this.last.elapsedMs))throw new Error('Radio frame replay or clock regression');
    if(this.last&&elapsedMs-this.last.elapsedMs>this.options.maxContinuityGapMs)this.candidate=null;
    const variation=(r:RadioRecord)=>fading(`${this.seed}:${recordKey(r)}`,elapsedMs);
    if(elapsedMs-this.wifiAt>=this.options.wifiIntervalMs) {
      this.wifi=[];this.wifiWarnings=[];this.wifiAt=elapsedMs;
      for(const {record:r,distanceM} of this.index.within(position,this.options.wifiRadiusM)) {
        if(r.kind!=='WIFI')continue;
        if(!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(r.identifier)||!r.ssid||!r.frequencyMHz){this.wifiWarnings.push(`WIFI_METADATA_MISSING:${r.identifier}`);continue;}
        const power=modeledPower(r,position,distanceM,r.frequencyMHz,variation(r));
        if(power>=-90)this.wifi.push({bssid:r.identifier.toLowerCase(),ssid:r.ssid,frequencyMHz:r.frequencyMHz,rssiDbm:Math.round(clamp(power,-127,0)),sampleElapsedMs:elapsedMs});
      }
      this.wifi.sort((a,b)=>b.rssiDbm-a.rssiDbm||a.bssid.localeCompare(b.bssid));
    }
    if(phase==='ARRIVED'&&(this.last?.bluetoothAction!=='REPLACE'||elapsedMs-this.bluetoothAt>=this.options.bluetoothIntervalMs)) {
      this.bluetooth=[];this.bluetoothWarnings=[];this.bluetoothAt=elapsedMs;
      for(const {record:r,distanceM} of this.index.within(position,this.options.bluetoothRadiusM)) {
        if(r.kind!=='BLUETOOTH')continue;
        if(!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(r.identifier)){this.bluetoothWarnings.push(`BLUETOOTH_METADATA_MISSING:${r.identifier}`);continue;}
        const power=modeledPower(r,position,distanceM,r.frequencyMHz??2402,variation(r));
        if(power>=-95)this.bluetooth.push({address:r.identifier.toLowerCase(),name:r.bluetooth?.name??r.ssid??null,rssiDbm:Math.round(clamp(power,-127,0)),sampleElapsedMs:elapsedMs});
      }
      this.bluetooth.sort((a,b)=>b.rssiDbm-a.rssiDbm||a.address.localeCompare(b.address));
    }
    const warnings=[...this.wifiWarnings,...(phase==='ARRIVED'?this.bluetoothWarnings:[])];
    const cells:Cell[]=[];
    for(const {record:r,distanceM} of this.index.within(position,this.options.cellRadiusM)) {
      if(r.kind!=='CELL')continue;
      if(!r.cell||!r.frequencyMHz||!r.propagation){warnings.push(`CELL_METADATA_MISSING:${r.identifier}`);continue;}
      if(r.cell.mcc!==this.options.mcc||r.cell.mnc!==this.options.mnc)continue;
      if(r.propagation.azimuthDeg==null||r.propagation.beamwidthDeg==null)warnings.push(`SECTOR_UNKNOWN:${r.identifier}`);
      const power=modeledPower(r,position,distanceM,r.frequencyMHz,variation(r));
      const minimum=r.cell.rat==='LTE'?-140:-156,maximum=r.cell.rat==='LTE'?-43:-31;
      if(power<minimum)continue;
      cells.push({identity:r.cell,identifier:recordKey(r),frequencyMHz:r.frequencyMHz,rsrpDbm:Math.round(clamp(power,minimum,maximum)),
        rsrqDb:null,sinrDb:null,timingAdvance:null,registered:false,distanceM:Math.round(distanceM),sampleElapsedMs:elapsedMs});
    }
    cells.sort((a,b)=>b.rsrpDbm-a.rsrpDbm||a.identifier.localeCompare(b.identifier));
    const previous=this.serving,current=cells.find(c=>c.identifier===this.serving),best=cells[0];
    if(!current) {this.serving=best?.identifier??null;this.candidate=null;}
    else if(best&&best.identifier!==current.identifier&&best.identity.rat===current.identity.rat) {
      const qualifies=this.options.handoverEvent==='A3'
        ?best.rsrpDbm>current.rsrpDbm+this.options.handoverMarginDb
        :current.rsrpDbm<this.options.a5ServingDbm&&best.rsrpDbm>this.options.a5NeighborDbm;
      if(!qualifies)this.candidate=null;
      else {
        if(this.candidate?.key!==best.identifier)this.candidate={key:best.identifier,since:elapsedMs};
        if(elapsedMs-this.candidate.since>=this.options.timeToTriggerMs){this.serving=best.identifier;this.candidate=null;}
      }
    } else this.candidate=null;
    for(const c of cells)c.registered=c.identifier===this.serving;
    if(!cells.length)warnings.push('NO_ELIGIBLE_CELL');
    const frame:RadioFrame={version:1,synthetic:true,tenantId:this.options.tenantId,imageId:this.options.imageId,sessionId:this.options.sessionId,
      datasetRevision:this.options.datasetRevision,sequence,elapsedMs,position,wifi:this.wifi,cells,bluetooth:phase==='ARRIVED'?this.bluetooth:null,bluetoothAction:phase==='ARRIVED'?'REPLACE':'HOLD',
      warnings:[...new Set(warnings)],handover:previous===this.serving?null:{from:previous,to:this.serving}};
    this.last=structuredClone(frame);this.lastInput=input;return structuredClone(frame);
  }
}
