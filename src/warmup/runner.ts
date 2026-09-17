import type { WarmupRun } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../http/errors.js';
import { applyWarmupLocation, applyDeviceEnvironment, getDeviceStatus, triggerRpaTask, warmupProvider } from '../api/duoPlusClient.js';
import { readDeviceWifi, normalizedMac, wifiReadbackMatches } from '../api/environmentWifi.js';
import { readProviderGps } from '../api/providerGps.js';
import { checkDevicePower } from '../orchestrator/powerCheck.js';
import { haversineMeters } from '../geo/haversine.js';
import { withTripLease } from '../trips/lease.js';
import { assertNoPendingRpa } from '../queue/rpaOwnership.js';
import { withEnvironmentWindow } from '../orchestrator/deviceOperations.js';
import { busyRunStates,remoteRunStates,localParts,dayNumber,taskEvidence,providerTime,expectedTaskCount,type Task } from './model.js';
import { materializeDays,ownCampaign,selectCityWifi } from './service.js';

export const warmupIo = { withTripLease, checkDevicePower, warmupProvider, getDeviceStatus, applyWarmupLocation, applyDeviceEnvironment, triggerRpaTask };
export const runtime={lastTickAt:null as string|null,lastError:null as string|null};
function safeError(e:unknown) {return e instanceof HttpError?e.message:'Provider or coordination check failed; retry deferred';}

export async function templateCatalog(tenantId:string) {
 const templates:Array<{id:string;name:string;type:1|2}>=[];
 for(const type of [2,1] as const) for(let page=1;page<=30;page++) {
  const data=await warmupIo.warmupProvider(type===2?'userTemplateList':'officialTemplateList',{page,pagesize:100},tenantId) as any;
  if(!Array.isArray(data?.list)||!Number.isInteger(data.total_page)||data.total_page>30)throw new HttpError(502,'Invalid template catalogue');
  for(const t of data.list)if(typeof t.id==='string'&&typeof t.name==='string')templates.push({id:t.id,name:t.name,type});
  if(page>=data.total_page)break;
 }return {templates};
}
export async function availableSlots(tenantId:string) {
 let count=0;
 for(let page=1;page<=50;page++) {
  const data=await warmupIo.warmupProvider('subscriptions',{free_status:1,page,pagesize:100},tenantId) as any;
  if(!Array.isArray(data?.list)||!Number.isInteger(data.total_page)||data.total_page>50)throw new HttpError(502,'Subscription availability is unknown');
  for(const s of data.list) {const expiry=Number(s.expired_at);if(!Number.isFinite(expiry))throw new HttpError(502,'Subscription expiry is unknown');if(expiry*1000>Date.now()&&Number(s.free_status)===1)count++;}
  if(page>=data.total_page)return count;
 }throw new HttpError(502,'Incomplete subscription inventory');
}
async function campaignStillRuns(id:string,deviceId:string,imageId:string) {
 const c=await prisma.warmupCampaign.findUniqueOrThrow({where:{id},include:{device:true}});
 if(c.status!=='RUNNING'||c.deviceId!==deviceId||c.imageId!==imageId||c.device.imageId!==imageId||c.reservedImageId!==imageId||await prisma.device.count({where:{imageId,activeTripId:{not:null}}}))throw new HttpError(409,'Campaign paused or phone identity/ownership changed');
 if(await prisma.site.count({where:{device:{imageId}}}))throw new HttpError(409,'A client assignment conflicts with this warmup phone');
 await assertNoPendingRpa(deviceId);
 return c;
}
async function reconcile(run:WarmupRun) {
 const c=await ownCampaign((await prisma.warmupCampaign.findUniqueOrThrow({where:{id:run.campaignId}})).tenantId,run.campaignId);
 if(!run.issueAt||!run.submittedAt)return;
 const nextCheckAt=new Date(Date.now()+60000);
 try {
  const data=await warmupIo.warmupProvider('taskList',{name:run.providerName,...(run.providerTaskId?{id:run.providerTaskId}:{}),issue_at_start:providerTime(new Date(+run.issueAt-86400000),c.providerTimezone,true),issue_at_end:providerTime(new Date(+run.issueAt+86400000),c.providerTimezone,true),page:1,pagesize:100},c.tenantId);
  const evidence=taskEvidence(data,run.providerName,run.providerTaskId);
  if(evidence) {
   const terminal=['SUCCEEDED','FAILED','CANCELLED'].includes(evidence.state);
   const elapsed=Date.now()-+run.issueAt,task=JSON.parse(run.taskJson) as Task;
   const overdue=!terminal&&elapsed>Math.max(30,task.expectedMinutes*3)*60000;
   await prisma.warmupRun.update({where:{id:run.id},data:{status:overdue?'UNCONFIRMED':evidence.state,providerTaskId:evidence.id,evidenceJson:JSON.stringify({source:'DUOPLUS_TASK_LIST',...evidence}),nextCheckAt,
    ...(terminal?{completedAt:new Date(),error:evidence.state==='FAILED'?'DuoPlus reported task failure':null}:{error:overdue?'Task exceeded its expected window; no new work will start':null})}});
   if(overdue)await prisma.warmupCampaign.update({where:{id:c.id},data:{status:'NEEDS_ATTENTION',error:'A remote task exceeded its execution window'}});
  } else if(Date.now()-+run.submittedAt>10*60000) {
   await prisma.warmupRun.update({where:{id:run.id},data:{status:'UNCONFIRMED',nextCheckAt,error:'No unique matching task found in DuoPlus; automatic resubmission stopped'}});
   if(c.status==='RUNNING')await prisma.warmupCampaign.update({where:{id:c.id},data:{status:'NEEDS_ATTENTION',error:'Task submission needs review'}});
  } else await prisma.warmupRun.update({where:{id:run.id},data:{nextCheckAt}});
 }catch(e){await prisma.warmupRun.update({where:{id:run.id},data:{nextCheckAt,error:safeError(e)}});}
}
async function dispatch(run:WarmupRun) {
 const base=await prisma.warmupCampaign.findUniqueOrThrow({where:{id:run.campaignId}});
 await warmupIo.withTripLease(base.deviceId,base.tenantId,lease=>withEnvironmentWindow(base.deviceId,async()=>{
  const c=await ownCampaign(base.tenantId,base.id);
  await campaignStillRuns(c.id,c.deviceId,c.imageId);
  if(await prisma.warmupRun.count({where:{campaign:{device:{imageId:c.imageId}},status:{in:busyRunStates}}}))return;
  const claimed=await prisma.warmupRun.updateMany({where:{id:run.id,status:'WAITING'},data:{status:'PREPARING',attempts:{increment:1},startedAt:new Date()}});if(!claimed.count)return;
  let sent=false;
  const beforeSend=async()=>{await lease.assertOwned();await campaignStillRuns(c.id,c.deviceId,c.imageId);};
  try {
   if(config.dryRun)throw new HttpError(409,'Warmup dispatch is disabled in dry-run mode');
   const power=await warmupIo.checkDevicePower(c.deviceId,c.tenantId);
   if(!power.poweredOn||power.duoPlusStatus!==1) {
    if(power.duoPlusStatus===2&&c.autoPower) {
     if(c.powerRequestedAt&&Date.now()-+c.powerRequestedAt<180000)throw new HttpError(409,'Waiting for the requested phone startup');
     if(!await availableSlots(c.tenantId))throw new HttpError(409,'Waiting for an available DuoPlus subscription slot');
     await beforeSend();
     // Persist the pending power ownership before the request; a timeout must not cause repeated starts.
     await prisma.warmupCampaign.update({where:{id:c.id},data:{powerRequestedAt:new Date()}});
     const started=await warmupIo.warmupProvider('powerOn',{image_ids:[c.imageId]},c.tenantId,beforeSend) as {success?:string[];fail?:string[]};
     if(!started?.success?.includes(c.imageId)||started.fail?.includes(c.imageId))throw new HttpError(409,'Startup acceptance unconfirmed; waiting for phone state without claiming shutdown ownership');
     await prisma.warmupCampaign.update({where:{id:c.id},data:{powerOwned:true}});
     throw new HttpError(409,'Startup requested; waiting for DuoPlus to confirm ON');
    }
    throw new HttpError(409,`Waiting for phone ON (DuoPlus status ${power.duoPlusStatus??'unknown'})`);
   }
   const info=await warmupIo.getDeviceStatus(c.imageId,c.tenantId);
   const wifi=readDeviceWifi(info,c.imageId),gps=readProviderGps(info,c.imageId);
   const fingerprint={imageId:c.imageId,wifiMac:normalizedMac(wifi.mac)};
   if(c.profileBaselineJson&&JSON.parse(c.profileBaselineJson).wifiMac!==fingerprint.wifiMac)throw new HttpError(409,'Phone Wi-Fi hardware MAC changed. Review profile continuity before continuing.');
   if(!c.profileBaselineJson)await prisma.warmupCampaign.update({where:{id:c.id},data:{profileBaselineJson:JSON.stringify(fingerprint)}});
   const environment= c.environmentJson?JSON.parse(c.environmentJson):{};
   const pointMatches=!!gps.point&&haversineMeters(c.lat,c.lng,gps.point.lat,gps.point.lng)<=10;
   if(!pointMatches) {
    if(environment.gpsAppliedAt&&Date.now()-Date.parse(environment.gpsAppliedAt)<600000)throw new HttpError(409,'Waiting for the provider GPS profile to match the assigned anchor');
    await warmupIo.applyWarmupLocation(c.imageId,c.lat,c.lng,c.tenantId,beforeSend);
    await prisma.warmupCampaign.update({where:{id:c.id},data:{environmentJson:JSON.stringify({...environment,gpsAppliedAt:new Date().toISOString(),status:'AWAITING_GPS_READBACK'})}});
    throw new HttpError(409,'Anchor applied; waiting for phone readiness and provider GPS readback');
   }
   let selected=environment.wifi??null;
   if(c.wifiMode==='CITY') {
    // Pin the selected historical AP for this profile; shared dataset refreshes never rotate it silently.
    selected=selected??selectCityWifi(c.city.recordsJson,c.lat,c.lng);
    if(!selected)throw new HttpError(409,'No eligible saved Wi-Fi observation within 120 m of this phone’s anchor. Import city data or use Preserve mode.');
    const expected={name:selected.ssid,bssid:selected.bssid,mac:wifi.mac??'',status:1 as const};
    if(!wifiReadbackMatches(expected,wifi)) {
     if(environment.wifiAppliedAt&&Date.now()-Date.parse(environment.wifiAppliedAt)<600000)throw new HttpError(409,'Waiting for provider Wi-Fi readback');
     await warmupIo.applyDeviceEnvironment(c.imageId,{wifi:{ssid:selected.ssid,bssid:selected.bssid,expectedMac:wifi.mac}},c.tenantId,beforeSend);
     await prisma.warmupCampaign.update({where:{id:c.id},data:{environmentJson:JSON.stringify({...environment,wifi:selected,wifiAppliedAt:new Date().toISOString(),status:'AWAITING_WIFI_READBACK'})}});
     throw new HttpError(409,'Wi-Fi profile applied; waiting for readback');
    }
   }
   const observation={status:'PROVIDER_MATCH',checkedAt:new Date().toISOString(),position:gps.point,wifi:selected,cityRevision:c.city.revision,wifiMode:c.wifiMode,cell:'REFERENCE_ONLY',bluetooth:'REFERENCE_ONLY',androidObserved:false};
   await prisma.warmupCampaign.update({where:{id:c.id},data:{environmentJson:JSON.stringify(observation),error:null}});
   await prisma.device.update({where:{id:c.deviceId},data:{anchorLat:c.lat,anchorLng:c.lng,currentLat:c.lat,currentLng:c.lng,phase:'IDLE',lastSpeedMps:0}});
   const task=JSON.parse(run.taskJson) as Task;
   // issue_at has minute precision. Always schedule in a future full minute, in the explicitly selected provider timezone.
   const executionAt=new Date((Math.floor(Date.now()/60000)+2)*60000);
   if(+executionAt+task.expectedMinutes*60000>+run.deadlineAt)throw new HttpError(409,'Not enough time remains in today’s window for this task');
   const variables={...task.variables};
   const expand=(s:string)=>s.replace(/\{\{(day|city|latitude|longitude|imageId)\}\}/g,(_,key)=>String(({day:run.dayNumber,city:c.city.name,latitude:c.lat,longitude:c.lng,imageId:c.imageId} as any)[key]));
   for(const key of Object.keys(variables))if(typeof variables[key]==='string')variables[key]=expand(variables[key] as string);
   await warmupIo.triggerRpaTask(c.imageId,task.templateId,variables,{name:run.providerName,templateType:task.templateType,tenantId:c.tenantId,issueAt:providerTime(executionAt,c.providerTimezone),remark:`Warmup ${c.id} day ${run.dayNumber}`,requireAcceptance:true,beforeSend:async()=>{
    await beforeSend();if(sent)throw new HttpError(409,'Submission already attempted; reconciling before any further action');
    if(+executionAt-Date.now()<15000)throw new HttpError(409,'Dispatch window elapsed; retry deferred');
    const changed=await prisma.warmupRun.updateMany({where:{id:run.id,status:'PREPARING',campaign:{status:'RUNNING'}},data:{status:'SUBMITTING',issueAt:executionAt,submittedAt:new Date(),error:null}});
    if(!changed.count)throw new HttpError(409,'Task ownership changed');sent=true;
   }});
   await prisma.warmupRun.updateMany({where:{id:run.id,status:'SUBMITTING'},data:{status:'AWAITING',nextCheckAt:new Date(Date.now()+30000)}});
  }catch(e){
   await prisma.warmupRun.updateMany({where:{id:run.id,status:{in:['PREPARING','SUBMITTING']}},data:{status:sent?'UNCONFIRMED':'WAITING',nextCheckAt:new Date(Date.now()+60000),error:sent?'Submission may have reached DuoPlus; checking task history without replay':safeError(e)}});
  }
 }),{waitMs:0});
}
async function releasePower(id:string) {
 const initial=await prisma.warmupCampaign.findUniqueOrThrow({where:{id}});if(!initial.powerOwned)return;
 await warmupIo.withTripLease(initial.deviceId,initial.tenantId,async lease=>{
  const c=await ownCampaign(initial.tenantId,id);
  if(await prisma.warmupCampaign.count({where:{imageId:c.imageId,id:{not:c.id},reservedImageId:{not:null}}})){await prisma.warmupCampaign.update({where:{id:c.id},data:{powerOwned:false,powerRequestedAt:null}});return;}
  if(!c.powerOwned||c.device.activeTripId||await prisma.warmupRun.count({where:{campaignId:id,status:{in:busyRunStates}}}))return;
  if(c.status==='RUNNING'&&await prisma.warmupRun.count({where:{campaignId:id,status:'WAITING',deadlineAt:{gt:new Date()},scheduledAt:{lte:new Date(Date.now()+600000)}}}))return;
  const power=await warmupIo.checkDevicePower(c.deviceId,c.tenantId);
  if(power.duoPlusStatus===2){await prisma.warmupCampaign.update({where:{id},data:{powerOwned:false,powerRequestedAt:null}});return;}
  if(power.duoPlusStatus!==1)return;
  // Do not power off while unrelated provider work is pending/running on a phone with the same name.
  const tasks=await warmupIo.warmupProvider('taskList',{image_name:c.device.name??c.imageId,status:[0,1,2],issue_at_start:providerTime(new Date(Date.now()-86400000),c.providerTimezone,true),issue_at_end:providerTime(new Date(Date.now()+86400000),c.providerTimezone,true),page:1,pagesize:100},c.tenantId) as any;
  if(!Array.isArray(tasks?.list)||tasks.list.length)return;
  await warmupIo.warmupProvider('powerOff',{image_ids:[c.imageId]},c.tenantId,async()=>{await lease.assertOwned();if(await prisma.warmupRun.count({where:{campaignId:id,status:{in:busyRunStates}}}))throw new HttpError(409,'A task owns this phone');});
  // Keep ownership until OFF is observed on the next scan.
 });
}
export async function recoverWarmup() {
 await prisma.warmupRun.updateMany({where:{status:'PREPARING'},data:{status:'WAITING',error:'Controller restarted before task submission; preflight will be repeated',nextCheckAt:new Date()}});
 await prisma.warmupRun.updateMany({where:{status:'SUBMITTING'},data:{status:'UNCONFIRMED',error:'Controller restarted during submission; checking provider task history',nextCheckAt:new Date()}});
}
export async function scanWarmup() {
 const now=new Date();
 // Reconciliation also runs while a campaign is paused.
 const pending=await prisma.warmupRun.findMany({where:{status:{in:remoteRunStates},OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]},orderBy:{updatedAt:'asc'},take:12});
 for(const run of pending)await reconcile(run);
 const campaigns=await prisma.warmupCampaign.findMany({where:{status:{in:['RUNNING','PAUSED','NEEDS_ATTENTION']}}});
 for(const c of campaigns) {
  if(c.activatedAt)await materializeDays(c.id,now);
  await prisma.warmupRun.updateMany({where:{campaignId:c.id,status:'WAITING',deadlineAt:{lte:now}},data:{status:'MISSED',completedAt:now,error:'Daily window ended without execution; retained in history'}});
  const pastEnd=dayNumber(c.startDate,localParts(now,c.timezone).date)>c.durationDays;
  const unresolved=await prisma.warmupRun.count({where:{campaignId:c.id,status:{in:busyRunStates}}});
  if(pastEnd&&!unresolved) {
   const total=expectedTaskCount(c.durationDays,JSON.parse(c.scheduleJson));const succeeded=await prisma.warmupRun.count({where:{campaignId:c.id,status:'SUCCEEDED'}});
   await prisma.warmupCampaign.update({where:{id:c.id},data:{status:'COMPLETED',reservedImageId:null,completedAt:now,error:succeeded<total?`${succeeded} of ${total} tasks succeeded; review missed or failed work`:null}});
   await prisma.warmupEvent.create({data:{campaignId:c.id,kind:'COMPLETED',detail:`Calendar period ended. ${succeeded}/${total} tasks confirmed successful.`}});
  }
 }
 const due=await prisma.warmupRun.findMany({where:{status:'WAITING',scheduledAt:{lte:now},deadlineAt:{gt:now},campaign:{status:'RUNNING'},OR:[{nextCheckAt:null},{nextCheckAt:{lte:now}}]},orderBy:[{scheduledAt:'asc'},{id:'asc'}],take:30});
 // One dispatch per phone per scan; the persisted in-flight states keep later scans exclusive.
 const seen=new Set<string>();
 for(const run of due) {
  if(seen.has(run.campaignId))continue;seen.add(run.campaignId);
  try{await dispatch(run);}catch(e){await prisma.warmupRun.updateMany({where:{id:run.id,status:'WAITING'},data:{nextCheckAt:new Date(Date.now()+60000),error:safeError(e)}});}
 }
 const powered=await prisma.warmupCampaign.findMany({where:{powerOwned:true},select:{id:true}});
 for(const c of powered)try{await releasePower(c.id);}catch{ /* Keep ownership; never infer a successful shutdown. */ }
 runtime.lastTickAt=new Date().toISOString();runtime.lastError=null;
}
export function startWarmupPlanner() {
 let active:Promise<void>|undefined;
 const scan=()=>{if(!active)active=scanWarmup().catch(e=>{runtime.lastError='Warmup scan failed; persisted tasks retained';logger.error({message:e instanceof Error?e.message:'Unknown error'},'warmup planner failed');}).finally(()=>{active=undefined;});};
 const timer=setInterval(scan,15000);timer.unref();scan();
 return {async stop(){clearInterval(timer);await active;}};
}
