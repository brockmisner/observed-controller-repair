import { createHmac, timingSafeEqual } from 'node:crypto';

/** A test-state/read-only protocol. Deliberately NOT the frozen duoplus.radio applier protocol. */
export const ENVIRONMENT_PROTOCOL = 'stakeout.environment';
export const ENVIRONMENT_VERSION = 1;
export const ENVIRONMENT_MAX_BYTES = 131072;
export type EnvironmentRole = 'observer' | 'lab';
export type Availability = 'MEASURED' | 'UNAVAILABLE' | 'NOT_YET_MEASURED';
export interface EnvironmentChallenge {
  protocol: typeof ENVIRONMENT_PROTOCOL; version: 1; type: 'challenge'; imageId: string;
  bootId: string; instanceId: string; role: EnvironmentRole; nonce: string;
}
export interface LocationSample {
  provider: string; lat: number; lng: number; accuracyM: number | null;
  speedMps: number | null; bearingDeg: number | null; sampledBootMs: number; isMock: boolean;
}
export interface WifiSample { bssid: string; ssid: string; frequencyMHz: number; rssiDbm: number; sampledBootMs: number }
export interface CellSample {
  rat: 'LTE' | 'NR'; mcc: string | null; mnc: string | null; areaCode: number | null;
  cellId: number | null; pci: number | null; registered: boolean; rsrpDbm: number | null; sampledBootMs: number;
}
export interface BluetoothSample { address: string; name: string | null; rssiDbm: number; sampledBootMs: number }
export interface RadioBlock<T> {
  availability: Availability; reason?: string; collectionMethod?: string; entries: T[] | null;
  truncated?: boolean; unsupportedCount?: number;
}
export interface WifiConnection {
  availability: Availability; reason?: string; bssid: string | null; ssid: string | null; rssiDbm: number | null;
}
export interface EnvironmentReport {
  protocol: typeof ENVIRONMENT_PROTOCOL; version: 1; type: 'observation'; imageId: string;
  bootId: string; instanceId: string; requestId: string; sequence: number; phoneBootMs: number;
  wallMs: number; bootCount: number; packageName: string; evidenceClass: 'ANDROID_API_READBACK';
  location: {availability: Availability; reason?: string; samples: LocationSample[] | null};
  wifi: RadioBlock<WifiSample> & {connection: WifiConnection};
  cells: RadioBlock<CellSample>; bluetooth: RadioBlock<BluetoothSample>;
}
export class EnvironmentProtocolError extends Error {}
const bad = (label: string): never => { throw new EnvironmentProtocolError(`Invalid environment ${label}`); };
function record(raw: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(label);
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(k => !fields.includes(k))) return bad(`${label} field`);
  return value;
}
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return bad(label);
  return value;
}
function number(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) return bad(label);
  return value;
}
function nullableNumber(value: unknown, label: string, min: number, max: number, integer = false): number | null {
  return value === null ? null : number(value, label, min, max, integer);
}
function bool(value: unknown, label: string): boolean { return typeof value === 'boolean' ? value : bad(label); }
function mac(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value) || ['00:00:00:00:00:00','ff:ff:ff:ff:ff:ff','02:00:00:00:00:00'].includes(value)) return bad(label);
  return value;
}
function availability(value: unknown): Availability {
  if (value !== 'MEASURED' && value !== 'UNAVAILABLE' && value !== 'NOT_YET_MEASURED') return bad('availability');
  return value;
}
function sampled(value: unknown, now: number): number { return number(value, 'sample timestamp', 0, now, true); }
function secret(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(value)) return bad('credential');
  return Buffer.from(value, 'hex');
}
export function signPayload(key: string, nonce: string, direction: 'request' | 'response', payload: string): string {
  if (!/^[a-f0-9]{64}$/.test(nonce) || !['request','response'].includes(direction)) return bad('signature context');
  return createHmac('sha256', secret(key)).update(`${direction}\n${nonce}\n${payload}`, 'utf8').digest('hex');
}
export function verifyPayload(key: string, nonce: string, direction: 'request' | 'response', payload: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  try { return timingSafeEqual(Buffer.from(signPayload(key, nonce, direction, payload), 'hex'), Buffer.from(signature, 'hex')); }
  catch { return false; }
}
export function parseChallenge(raw: unknown, expectedImageId: string, expectedRole: EnvironmentRole): EnvironmentChallenge {
  const v = record(raw, ['protocol','version','type','imageId','bootId','instanceId','role','nonce'], 'challenge');
  if (v.protocol !== ENVIRONMENT_PROTOCOL || v.version !== 1 || v.type !== 'challenge' || v.imageId !== expectedImageId || v.role !== expectedRole) return bad('challenge identity');
  text(v.imageId, 'image'); text(v.bootId, 'boot'); text(v.instanceId, 'instance');
  if (typeof v.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(v.nonce)) return bad('nonce');
  return v as unknown as EnvironmentChallenge;
}
function block<T>(raw: unknown, now: number, parse: (raw: unknown, now: number) => T, extra: string[] = []): RadioBlock<T> {
  const v = record(raw, ['availability','reason','collectionMethod','entries','truncated','unsupportedCount', ...extra], 'radio block');
  const state = availability(v.availability);
  if (v.reason !== undefined) text(v.reason, 'reason', 120);
  if (v.collectionMethod !== undefined && !['PLATFORM_CACHE','SCAN_CALLBACK','ANDROID_API'].includes(String(v.collectionMethod))) return bad('collection method');
  if (v.truncated !== undefined) bool(v.truncated, 'truncation');
  if (v.unsupportedCount !== undefined) number(v.unsupportedCount, 'unsupported count', 0, 10000, true);
  if (state === 'MEASURED') {
    if (!Array.isArray(v.entries) || v.entries.length > 512) return bad('radio entries');
    v.entries.forEach(entry => parse(entry, now));
  } else if (v.entries !== null || !v.reason) return bad('unavailable radio entries');
  return v as unknown as RadioBlock<T>;
}
function wifi(raw: unknown, now: number): WifiSample {
  const v=record(raw,['bssid','ssid','frequencyMHz','rssiDbm','sampledBootMs'],'Wi-Fi sample');
  mac(v.bssid,'BSSID');
  if(typeof v.ssid!=='string'||v.ssid.length>128) return bad('SSID');
  number(v.frequencyMHz,'frequency',1,100000,true);number(v.rssiDbm,'RSSI',-127,0);sampled(v.sampledBootMs,now);
  return v as unknown as WifiSample;
}
function cell(raw: unknown, now: number): CellSample {
  const v=record(raw,['rat','mcc','mnc','areaCode','cellId','pci','registered','rsrpDbm','sampledBootMs'],'cell sample');
  if(v.rat!=='LTE'&&v.rat!=='NR') return bad('cell technology');
  if(v.mcc!==null&&(typeof v.mcc!=='string'||!/^\d{3}$/.test(v.mcc)))return bad('MCC');
  if(v.mnc!==null&&(typeof v.mnc!=='string'||!/^\d{2,3}$/.test(v.mnc)))return bad('MNC');
  nullableNumber(v.areaCode,'area code',0,v.rat==='LTE'?65535:16777215,true);
  nullableNumber(v.cellId,'cell ID',0,v.rat==='LTE'?268435455:68719476735,true);
  nullableNumber(v.pci,'PCI',0,v.rat==='LTE'?503:1007,true);
  bool(v.registered,'registered');nullableNumber(v.rsrpDbm,'RSRP',-160,-20);sampled(v.sampledBootMs,now);
  return v as unknown as CellSample;
}
function bluetooth(raw: unknown, now: number): BluetoothSample {
  const v=record(raw,['address','name','rssiDbm','sampledBootMs'],'Bluetooth sample');mac(v.address,'Bluetooth address');
  if(v.name!==null&&(typeof v.name!=='string'||v.name.length>256))return bad('Bluetooth name');
  number(v.rssiDbm,'Bluetooth RSSI',-127,0);sampled(v.sampledBootMs,now);return v as unknown as BluetoothSample;
}
export function validateReport(raw: unknown, challenge: EnvironmentChallenge, requestId: string): EnvironmentReport {
  const v=record(raw,['protocol','version','type','imageId','bootId','instanceId','requestId','sequence','phoneBootMs','wallMs','bootCount','packageName','evidenceClass','location','wifi','cells','bluetooth'],'observation');
  if(v.protocol!==ENVIRONMENT_PROTOCOL||v.version!==1||v.type!=='observation'||v.evidenceClass!=='ANDROID_API_READBACK')return bad('observation version');
  if(v.imageId!==challenge.imageId||v.bootId!==challenge.bootId||v.instanceId!==challenge.instanceId||v.requestId!==requestId||challenge.role!=='observer')return bad('observation identity');
  if(!/^[a-f0-9]{32}$/.test(requestId))return bad('request ID');
  if(v.packageName!=='net.stakeout.environment.observer')return bad('observer package');
  number(v.sequence,'sequence',0,Number.MAX_SAFE_INTEGER,true);number(v.wallMs,'wall clock',0,Number.MAX_SAFE_INTEGER,true);number(v.bootCount,'boot count',0,Number.MAX_SAFE_INTEGER,true);
  const now=number(v.phoneBootMs,'phone clock',0,Number.MAX_SAFE_INTEGER,true);
  const loc=record(v.location,['availability','reason','samples'],'location block');const state=availability(loc.availability);
  if(loc.reason!==undefined)text(loc.reason,'location reason',120);
  if(state==='MEASURED') {
    if(!Array.isArray(loc.samples)||loc.samples.length>16||!loc.samples.length)return bad('location samples');
    loc.samples.forEach(raw=>{const f=record(raw,['provider','lat','lng','accuracyM','speedMps','bearingDeg','sampledBootMs','isMock'],'location sample');
      text(f.provider,'provider',40);number(f.lat,'latitude',-90,90);number(f.lng,'longitude',-180,180);
      nullableNumber(f.accuracyM,'accuracy',0,100000);nullableNumber(f.speedMps,'speed',0,10000);nullableNumber(f.bearingDeg,'bearing',0,360);
      sampled(f.sampledBootMs,now);bool(f.isMock,'mock status');});
  } else if(loc.samples!==null||!loc.reason)return bad('location availability');
  const w=block(v.wifi,now,wifi,['connection']) as RadioBlock<WifiSample>&{connection:unknown};
  const c=record(w.connection,['availability','reason','bssid','ssid','rssiDbm'],'Wi-Fi connection');
  availability(c.availability);if(c.reason!==undefined)text(c.reason,'connection reason',120);
  if(c.availability==='MEASURED')mac(c.bssid,'associated BSSID');else if(c.bssid!==null||!c.reason)return bad('redacted connection');
  if(c.ssid!==null&&(typeof c.ssid!=='string'||c.ssid.length>128))return bad('connection SSID');
  nullableNumber(c.rssiDbm,'connection RSSI',-127,0);
  block(v.cells,now,cell);block(v.bluetooth,now,bluetooth);
  return structuredClone(v) as unknown as EnvironmentReport;
}
/** Both arguments MUST be from the same device boot. Wall time is never substituted. */
export function sampleAge(phoneBootMs: number, sampledBootMs: number): number | null {
  if(!Number.isSafeInteger(phoneBootMs)||!Number.isSafeInteger(sampledBootMs)||sampledBootMs<0||sampledBootMs>phoneBootMs)return null;
  return phoneBootMs-sampledBootMs;
}
export function summarizeReport(report: EnvironmentReport, receivedAgeMs: number) {
  number(receivedAgeMs,'receipt age',0);
  const newest=report.location.samples?.reduce<LocationSample|null>((best,f)=>!best||f.sampledBootMs>best.sampledBootMs?f:best,null)??null;
  const age=newest?sampleAge(report.phoneBootMs,newest.sampledBootMs):null;
  const wifiAges=report.wifi.entries?.map(w=>sampleAge(report.phoneBootMs,w.sampledBootMs)).filter((v):v is number=>v!==null)??[];
  return {
    imageId:report.imageId,bootId:report.bootId,instanceId:report.instanceId,sequence:report.sequence,
    evidenceClass:report.evidenceClass,androidRadioApplied:false as const,physicalRfVerified:false as const,
    location:{availability:report.location.availability,ageMs:age===null?null:age+receivedAgeMs,isMock:newest?.isMock??null,
      point:newest?{lat:newest.lat,lng:newest.lng}:null,accuracyM:newest?.accuracyM??null,speedMps:newest?.speedMps??null,
      fresh:age!==null&&age+receivedAgeMs<=5000,reason:report.location.reason??null},
    wifi:{availability:report.wifi.availability,connection:report.wifi.connection,count:report.wifi.entries?.length??null,
      oldestAgeMs:wifiAges.length?Math.max(...wifiAges)+receivedAgeMs:null,newestAgeMs:wifiAges.length?Math.min(...wifiAges)+receivedAgeMs:null,
      reason:report.wifi.reason??null,collectionMethod:report.wifi.collectionMethod??null,truncated:report.wifi.truncated??false},
    cells:{availability:report.cells.availability,count:report.cells.entries?.length??null,reason:report.cells.reason??null,
      unsupportedCount:report.cells.unsupportedCount??0},
    bluetooth:{availability:report.bluetooth.availability,count:report.bluetooth.entries?.length??null,reason:report.bluetooth.reason??null},
  };
}
