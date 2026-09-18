import { z } from 'zod';
import { radioRecordSchema } from '../radio/schema.js';
export const liveCampaignStates = ['DRAFT', 'RUNNING', 'PAUSED', 'NEEDS_ATTENTION'];
export const busyRunStates = ['PREPARING', 'SUBMITTING', 'AWAITING', 'RUNNING', 'REMOTE_PAUSED', 'UNCONFIRMED'];
export const remoteRunStates = ['SUBMITTING', 'AWAITING', 'RUNNING', 'REMOTE_PAUSED', 'UNCONFIRMED'];
export const terminalRunStates = ['SUCCEEDED', 'FAILED', 'MISSED', 'CANCELLED', 'SUSPENDED_IN_PLACE'];
export const zoneSchema = z.string().max(100).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone:v }); return true; } catch { return false; } }, 'Use an IANA timezone, such as America/New_York');
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v+'T12:00:00Z'); return Number.isFinite(+d) && d.toISOString().slice(0,10) === v; }, 'Invalid calendar date');
const slotKey=z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/);
const slotTime=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const slotDays={firstDay:z.number().int().min(1).max(730).default(1), lastDay:z.number().int().min(1).max(730).default(730)};
export const taskSchema = z.object({
  key: slotKey, name:z.string().trim().min(1).max(100), time:slotTime,
  kind:z.literal('RPA').default('RPA'),
  templateId:z.string().trim().min(1).max(200),
  templateType:z.union([z.literal(1),z.literal(2)]).default(2),
  variables:z.record(z.union([z.string().max(2000),z.number().finite(),z.boolean()])).default({}),
  ...slotDays, expectedMinutes:z.number().int().min(1).max(180).default(15),
  dependsOn:slotKey.optional(),
  preservesProfile:z.literal(true),
}).strict().refine(v => v.lastDay >= v.firstDay, 'Last day must follow first day');
export const driveSlotSchema = z.object({
  key: slotKey, name:z.string().trim().min(1).max(100), time:slotTime, kind:z.literal('DRIVE'),
  destination:z.union([z.literal('HOME'), z.object({lat:z.number().finite().min(-90).max(90), lng:z.number().finite().min(-180).max(180)}).strict()]),
  ...slotDays, expectedMinutes:z.number().int().min(1).max(180).default(30),
  preservesProfile:z.literal(true),
}).strict().refine(v => v.lastDay >= v.firstDay, 'Last day must follow first day');
export type Task = z.infer<typeof taskSchema>;
export type DriveSlot = z.infer<typeof driveSlotSchema>;
export type ScheduleItem = Task | DriveSlot;
export function isDriveSlot(item: { kind?: string }): item is DriveSlot {
  return item.kind === 'DRIVE';
}
export const campaignSchema = z.object({
  deviceId:z.string().min(1).max(200), cityId:z.string().min(1).max(200),
  name:z.string().trim().min(1).max(100), folderId:z.string().max(200).optional(),
  clientFolder:z.string().trim().min(1).max(100), profileLabel:z.string().trim().max(100).default('Existing phone profile'),
  startDate:dateSchema, durationDays:z.number().int().min(3).max(730).default(30),
  lat:z.number().finite().min(-90).max(90), lng:z.number().finite().min(-180).max(180),
  timezone:zoneSchema, providerTimezone:zoneSchema, autoPower:z.boolean().default(false),
  wifiMode:z.enum(['PRESERVE','CITY']).default('PRESERVE'),
  schedule:z.array(taskSchema).min(1).max(12),
  movement:z.array(driveSlotSchema).max(8).default([]),
}).strict()
  .refine(v=>{const keys=[...v.schedule,...v.movement].map(t=>t.key);return new Set(keys).size===keys.length;},'Daily task keys must be unique')
  .refine(v=>v.schedule.every(t=>!t.dependsOn||v.movement.some(m=>m.key===t.dependsOn)),'dependsOn must name a movement slot');
export const radioSchema = radioRecordSchema;
export const citySchema = z.object({name:z.string().trim().min(1).max(100), timezone:zoneSchema,
  lat:z.number().finite().min(-90).max(90),lng:z.number().finite().min(-180).max(180),radiusM:z.number().int().min(100).max(100000).default(20000)}).strict();
export function localParts(at:Date, zone:string) {
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(at);
  const g=(key:string)=>p.find(x=>x.type===key)!.value;
  return {date:`${g('year')}-${g('month')}-${g('day')}`,time:`${g('hour')}:${g('minute')}`,seconds:g('second')};
}
export function addDays(date:string, days:number) { const d=new Date(date+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
export function dayNumber(start:string,date:string) { return Math.round((Date.parse(date+'T12:00:00Z')-Date.parse(start+'T12:00:00Z'))/86400000)+1; }
// Earlier occurrence on a fall-back day; first valid minute following a spring-forward gap.
export function zonedTime(date:string,time:string,zone:string):Date {
  const naive=Date.parse(`${date}T${time}:00Z`);
  const offsets=new Set<number>();
  for(const delta of [-86400000,0,86400000]) { const at=new Date(naive+delta),p=localParts(at,zone); offsets.add(Date.parse(`${p.date}T${p.time}:${p.seconds}Z`)-+at); }
  for(let minute=0;minute<=180;minute++) {
    const desired=new Date(naive+minute*60000).toISOString().slice(0,16);
    const choices=[...offsets].map(o=>new Date(naive+minute*60000-o)).filter(at=>{const p=localParts(at,zone);return `${p.date}T${p.time}`===desired;});
    if(choices.length) return choices.sort((a,b)=>+a-+b)[0]!;
  }
  throw new Error('Local schedule could not be resolved');
}
export function providerTime(date:Date,zone:string,seconds=false) { const p=localParts(date,zone); return `${p.date} ${p.time}${seconds?':'+p.seconds:''}`; }
export function dailyPlan(start:string, days:number, zone:string, tasks:ScheduleItem[], fromDay=1,toDay=days) {
  const result:Array<{dayNumber:number;slotKey:string;scheduledAt:Date;deadlineAt:Date;task:ScheduleItem}>=[];
  for(let day=Math.max(1,fromDay);day<=Math.min(days,toDay);day++) {
    const date=addDays(start,day-1),deadlineAt=zonedTime(addDays(date,1),'00:00',zone);
    for(const task of tasks) if(day>=task.firstDay&&day<=task.lastDay) result.push({dayNumber:day,slotKey:task.key,scheduledAt:zonedTime(date,task.time,zone),deadlineAt,task});
  }
  return result.sort((a,b)=>+a.scheduledAt-+b.scheduledAt||Number(isDriveSlot(b.task))-Number(isDriveSlot(a.task))||a.slotKey.localeCompare(b.slotKey));
}
export function expectedTaskCount(days:number,tasks:ScheduleItem[]) {return tasks.reduce((n,t)=>n+Math.max(0,Math.min(days,t.lastDay)-t.firstDay+1),0);}
export function taskEvidence(value:unknown,name:string,knownId?:string|null) {
  const data=value as {list?:unknown[];total?:number};
  if(!data||!Array.isArray(data.list)||data.list.length>100) throw new Error('Invalid DuoPlus task response');
  const matches=data.list.filter((v):v is Record<string,unknown>=>!!v&&typeof v==='object'&&(v as any).name===name);
  if(matches.length>1||data.total&&data.total>100) throw new Error('Ambiguous task identity; inspect DuoPlus');
  if(!matches.length)return null;
  const row=matches[0]!;
  if(typeof row.id!=='string'||!row.id||knownId&&knownId!==row.id||!Number.isInteger(row.status)||![0,1,2,3,4,5].includes(Number(row.status)))throw new Error('Unrecognized task identity or state');
  return {id:row.id,status:Number(row.status),state:({0:'AWAITING',1:'RUNNING',2:'REMOTE_PAUSED',3:'SUCCEEDED',4:'FAILED',5:'CANCELLED'} as Record<number,string>)[Number(row.status)]!, observedAt:new Date().toISOString(),finishAt:typeof row.finish_at==='string'?row.finish_at:null};
}
