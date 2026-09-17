import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../http/errors.js';
import { savedFolders } from '../orchestrator/folders.js';
import { haversineMeters } from '../geo/haversine.js';
import { parseObservedWifi,rankObservedWifi } from '../env/environmentData.js';
import { campaignSchema,citySchema,radioSchema,liveCampaignStates,busyRunStates,remoteRunStates,dailyPlan,dayNumber,localParts,expectedTaskCount,type Task } from './model.js';

export async function assertNoWarmup(deviceId:string,tx:Prisma.TransactionClient=prisma) {
  if(await tx.warmupCampaign.count({where:{deviceId,OR:[{status:{in:liveCampaignStates}},{runs:{some:{status:{in:busyRunStates}}}}]}})) throw new HttpError(409,'This phone belongs to a warmup campaign. Use Warmup controls to preserve its profile and geographic assignment.');
}
export async function ownCampaign(tenantId:string,id:string) {
 const c=await prisma.warmupCampaign.findFirst({where:{id,tenantId},include:{device:true,city:true}});
 if(!c||c.device.tenantId!==tenantId||c.city.tenantId!==tenantId)throw new HttpError(404,'Campaign not found');return c;
}
export function selectCityWifi(recordsJson:string,lat:number,lng:number) {
 const records=z.array(radioSchema).parse(JSON.parse(recordsJson));
 const choices=records.filter(r=>r.kind==='WIFI').map(r=>parseObservedWifi({netid:r.identifier,ssid:r.ssid,trilat:r.lat,trilong:r.lng,qos:r.qos,lasttime:r.lastSeen,lastupdt:r.lastUpdated},{lat,lng},120)).filter((r):r is NonNullable<typeof r>=>!!r);
 return rankObservedWifi(choices,120)[0]??null;
}
export async function cityCreate(tenantId:string,raw:unknown) { const data=citySchema.parse(raw);return prisma.warmupCity.create({data:{...data,tenantId}}); }
export async function cityImport(tenantId:string,id:string,raw:unknown) {
 const input=z.object({uploadId:z.string().optional(),records:z.array(radioSchema).max(10000).optional()}).strict().refine(v=>Boolean(v.uploadId)!==Boolean(v.records),'Choose an existing upload or normalized records').parse(raw);
 const city=await prisma.warmupCity.findFirst({where:{id,tenantId}});if(!city)throw new HttpError(404,'City not found');
 let incoming=input.records??[];
 if(input.uploadId) {
  const upload=await prisma.deviceWigleUpload.findFirst({where:{id:input.uploadId,device:{tenantId}}});if(!upload)throw new HttpError(404,'Saved upload not found in this workspace');
  const payload=JSON.parse(upload.payloadJson);if(payload.version!==1||!Array.isArray(payload.records))throw new HttpError(409,'Unsupported saved upload format');
  incoming=z.array(radioSchema).max(10000).parse(payload.records.map((r:Record<string,unknown>)=>({...r,source:upload.filename})));
 }
 const records=new Map(z.array(radioSchema).parse(JSON.parse(city.recordsJson)).map(r=>[`${r.kind}:${r.identifier.toLowerCase()}`,r]));
 let outside=0;
 for(const record of incoming) {
  if(haversineMeters(city.lat,city.lng,record.lat,record.lng)>city.radiusM){outside++;continue;}
  const key=`${record.kind}:${record.identifier.toLowerCase()}`,prev=records.get(key);
  if(!prev||Date.parse(record.lastSeen??'')>=Date.parse(prev.lastSeen??'')||!Number.isFinite(Date.parse(prev.lastSeen??'')))records.set(key,record);
 }
 if(records.size>10000)throw new HttpError(400,'City datasets support up to 10,000 observations; split larger regions');
 const updated=await prisma.warmupCity.updateMany({where:{id,tenantId,revision:city.revision},data:{recordsJson:JSON.stringify([...records.values()]),revision:{increment:1}}});
 if(!updated.count)throw new HttpError(409,'City data changed during import. Retry.');
 return {imported:incoming.length-outside,outside,total:records.size};
}
export async function campaignCreate(tenantId:string,raw:unknown) {
 const input=campaignSchema.parse(raw);
 const [device,city,folders]=await Promise.all([prisma.device.findFirst({where:{id:input.deviceId,tenantId}}),prisma.warmupCity.findFirst({where:{id:input.cityId,tenantId}}),savedFolders(tenantId)]);
 if(!device||!city)throw new HttpError(404,'Choose a phone and city from this workspace');
 if(haversineMeters(input.lat,input.lng,city.lat,city.lng)>city.radiusM)throw new HttpError(400,'Phone anchor is outside the assigned city area');
 if(input.timezone!==city.timezone)throw new HttpError(400,'Campaign timezone must match the assigned city');
 if(input.startDate<localParts(new Date(),input.timezone).date)throw new HttpError(400,'Start date must be today or later');
 if(!expectedTaskCount(input.durationDays,input.schedule))throw new HttpError(400,'No tasks fall within this campaign');
 if(input.folderId&&!folders?.phones.find(p=>p.imageId===device.imageId)?.groups?.some(f=>f.id===input.folderId))throw new HttpError(409,'Phone is not in that DuoPlus folder; sync the fleet or choose its current folder');
 const {schedule,...values}=input;
 return prisma.$transaction(async tx=>{
  await assertNoWarmup(device.id,tx);
  const freshDevice=await tx.device.findUniqueOrThrow({where:{id:device.id}});
  if(freshDevice.imageId!==device.imageId||freshDevice.activeTripId||await tx.site.count({where:{deviceId:device.id}})||await tx.rpaJob.count({where:{deviceId:device.id,status:{in:['queued','submitting','submitted','unconfirmed']}}}))throw new HttpError(409,'Phone has an active trip, client assignment, or unresolved legacy RPA job');
  const row=await tx.warmupCampaign.create({data:{...values,tenantId,imageId:device.imageId,reservedImageId:device.imageId,scheduleJson:JSON.stringify(schedule)}});
  await tx.warmupEvent.create({data:{campaignId:row.id,kind:'CREATED',detail:'Existing DuoPlus image reserved; profile and app data retained.'}});
  return row;
 });
}
export async function materializeDays(id:string,now=new Date()) {
 const c=await prisma.warmupCampaign.findUniqueOrThrow({where:{id}});
 const today=Math.max(1,dayNumber(c.startDate,localParts(now,c.timezone).date));
 // Persist a rolling seven-day window. Earlier days are materialized as MISSED after downtime.
 const latest=await prisma.warmupRun.aggregate({where:{campaignId:id},_max:{dayNumber:true}});
 const from=Math.max(1,(latest._max.dayNumber??1)-1),to=Math.min(c.durationDays,today+7);
 for(const item of dailyPlan(c.startDate,c.durationDays,c.timezone,JSON.parse(c.scheduleJson),from,to)) {
  const runId=randomUUID();
  await prisma.warmupRun.upsert({where:{campaignId_dayNumber_slotKey:{campaignId:id,dayNumber:item.dayNumber,slotKey:item.slotKey}},update:{},create:{id:runId,campaignId:id,dayNumber:item.dayNumber,slotKey:item.slotKey,scheduledAt:item.scheduledAt,deadlineAt:item.deadlineAt,taskJson:JSON.stringify(item.task),providerName:`warmup-${runId}`,status:item.deadlineAt<=now?'MISSED':'WAITING',...(item.deadlineAt<=now?{completedAt:now,error:'Daily window passed before execution'}:{})}});
 }
}
export async function campaignAction(tenantId:string,id:string,action:string,raw:unknown={}) {
 const c=await ownCampaign(tenantId,id);
 return prisma.$transaction(async tx=>{
  const fresh=await tx.warmupCampaign.findUniqueOrThrow({where:{id}});
  let status=fresh.status,detail='';
  if(action==='start'||action==='resume') {
   if(!['DRAFT','PAUSED','NEEDS_ATTENTION'].includes(status))throw new HttpError(409,'Campaign cannot start from its current state');
   if(await tx.warmupRun.count({where:{campaignId:id,status:'UNCONFIRMED'}}))throw new HttpError(409,'Resolve uncertain remote tasks before resuming');
   status='RUNNING';detail='Daily schedule enabled; missed days are recorded, never replayed in a burst.';
  } else if(action==='pause') {if(!['RUNNING','NEEDS_ATTENTION'].includes(status))throw new HttpError(409,'Campaign is not running');status='PAUSED';detail='New dispatches paused. In-flight provider tasks remain tracked until their outcome is known.';}
  else if(action==='cancel') {
   if(!liveCampaignStates.includes(status))throw new HttpError(409,'Campaign has already ended');
   if(await tx.warmupRun.count({where:{campaignId:id,status:{in:busyRunStates}}}))throw new HttpError(409,'Pause first and wait for the in-flight task, or cancel it in DuoPlus and refresh its result');
   status='CANCELLED';detail='Campaign cancelled; phone profile and task history retained.';
   await tx.warmupRun.updateMany({where:{campaignId:id,status:'WAITING'},data:{status:'CANCELLED',completedAt:new Date(),error:'Campaign cancelled'}});
  } else if(action==='extend') {
   const {durationDays}=z.object({durationDays:z.number().int().min(3).max(730)}).strict().parse(raw);
   if(durationDays<=fresh.durationDays||status==='CANCELLED')throw new HttpError(400,'Choose a longer duration for an uncancelled campaign');
   const conflicts=await tx.warmupCampaign.count({where:{deviceId:c.deviceId,id:{not:id},status:{in:liveCampaignStates}}});if(conflicts)throw new HttpError(409,'Phone is reserved by another campaign');
   await tx.warmupCampaign.update({where:{id},data:{durationDays,reservedImageId:c.imageId,status:status==='COMPLETED'?'PAUSED':status,completedAt:null}});
   await tx.warmupEvent.create({data:{campaignId:id,kind:'EXTENDED',detail:`Duration extended from ${fresh.durationDays} to ${durationDays} days.`}});return {ok:true};
  } else throw new HttpError(404,'Unknown campaign action');
  await tx.warmupCampaign.update({where:{id},data:{status,error:null,...(status==='RUNNING'&&!fresh.activatedAt?{activatedAt:new Date()}:{}),...(status==='CANCELLED'?{completedAt:new Date(),reservedImageId:null}: {})}});
  await tx.warmupEvent.create({data:{campaignId:id,kind:action.toUpperCase(),detail}});return {ok:true};
 });
}
export async function resolveRun(tenantId:string,id:string,raw:unknown) {
 const input=z.object({outcome:z.enum(['FAILED','CANCELLED']),remoteStopped:z.literal(true),note:z.string().trim().min(5).max(500)}).strict().parse(raw);
 const run=await prisma.warmupRun.findFirst({where:{id,campaign:{tenantId}}});if(!run)throw new HttpError(404,'Task not found');
 if(!['UNCONFIRMED','REMOTE_PAUSED'].includes(run.status))throw new HttpError(409,'Only an uncertain or remotely paused task can be resolved');
 await prisma.$transaction(async tx=>{
  const change=await tx.warmupRun.updateMany({where:{id,status:run.status},data:{status:input.outcome,completedAt:new Date(),error:input.note,evidenceJson:JSON.stringify({source:'OPERATOR_RESOLUTION',note:input.note,remoteStopped:true})}});
  if(!change.count)throw new HttpError(409,'Task changed; refresh');
  await tx.warmupEvent.create({data:{campaignId:run.campaignId,kind:'TASK_RESOLVED',detail:input.note}});
 });return {ok:true};
}
export async function retryRun(tenantId:string,id:string) {
 const run=await prisma.warmupRun.findFirst({where:{id,campaign:{tenantId,status:'RUNNING'}}});if(!run)throw new HttpError(404,'Task not found in a running campaign');
 if(!['FAILED','CANCELLED'].includes(run.status)||run.deadlineAt<=new Date())throw new HttpError(409,'Only confirmed failed or cancelled tasks within today’s window can be retried');
 await prisma.$transaction(async tx=>{
  const updated=await tx.warmupRun.updateMany({where:{id,status:run.status},data:{status:'WAITING',providerName:`warmup-${randomUUID()}`,providerTaskId:null,issueAt:null,submittedAt:null,startedAt:null,completedAt:null,nextCheckAt:null,error:null,evidenceJson:null}});
  if(!updated.count)throw new HttpError(409,'Task changed; refresh');
  await tx.warmupEvent.create({data:{campaignId:run.campaignId,kind:'RETRY',detail:`Explicit retry of ${id}; previous result ${run.status}. ${run.evidenceJson??''}`}});
 });return {ok:true};
}
export async function warmupView(tenantId:string) {
 const [cities,campaigns,devices,folders,uploads]=await Promise.all([
  prisma.warmupCity.findMany({where:{tenantId},orderBy:{name:'asc'}}),
  prisma.warmupCampaign.findMany({where:{tenantId},include:{device:{select:{name:true,poweredOn:true,duoPlusStatus:true}},city:{select:{name:true,revision:true}}},orderBy:{createdAt:'desc'}}),
  prisma.device.findMany({where:{tenantId},select:{id:true,imageId:true,name:true,anchorLat:true,anchorLng:true,timezone:true,poweredOn:true}}),savedFolders(tenantId),
  prisma.deviceWigleUpload.findMany({where:{device:{tenantId}},select:{id:true,filename:true,deviceId:true,wifiCount:true,cellCount:true,bluetoothCount:true,importedAt:true},orderBy:{importedAt:'desc'}})
 ]);
 return {cities:cities.map(({recordsJson,...c})=>{const r=JSON.parse(recordsJson);return {...c,counts:Object.fromEntries(['WIFI','CELL','BLUETOOTH'].map(k=>[k,r.filter((x:any)=>x.kind===k).length]))};}),
  campaigns:await Promise.all(campaigns.map(async c=>{
   const counts=await prisma.warmupRun.groupBy({by:['status'],where:{campaignId:c.id},_count:true});
   const summary=Object.fromEntries(counts.map(r=>[r.status,r._count]));
   const expected=expectedTaskCount(c.durationDays,JSON.parse(c.scheduleJson));
   const next=await prisma.warmupRun.findFirst({where:{campaignId:c.id,status:'WAITING'},orderBy:{scheduledAt:'asc'},select:{scheduledAt:true}});
   return {...c,schedule:JSON.parse(c.scheduleJson),scheduleJson:undefined,profileBaselineJson:undefined,environmentJson:undefined,environment:c.environmentJson?JSON.parse(c.environmentJson):null,day:Math.min(c.durationDays,Math.max(0,dayNumber(c.startDate,localParts(new Date(),c.timezone).date))),expectedTasks:expected,counts:summary,progress:expected?Math.round(100*(summary.SUCCEEDED??0)/expected):0,nextAt:next?.scheduledAt??null,profilePolicy:'PRESERVE_EXISTING_IMAGE'};
  })),devices,folders,uploads,capabilities:{wifi:'Provider profile readback',cell:'Reference records only',bluetooth:'Reference records only',profile:'Existing app data and cookies remain on the same DuoPlus image. External template behavior is operator-controlled.'}};
}
export async function campaignHistory(tenantId:string,id:string) {
 await ownCampaign(tenantId,id);
 const [runs,events]=await Promise.all([prisma.warmupRun.findMany({where:{campaignId:id},orderBy:[{scheduledAt:'desc'}],take:200}),prisma.warmupEvent.findMany({where:{campaignId:id},orderBy:{createdAt:'desc'},take:100})]);
 return {runs:runs.map(r=>({...r,task:JSON.parse(r.taskJson),taskJson:undefined,evidence:r.evidenceJson?JSON.parse(r.evidenceJson):null,evidenceJson:undefined})),events};
}
