import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'warmup-test-'));
process.env.DATABASE_URL=`file:${dir}/test.db`;
process.env.NODE_ENV='test';process.env.DRY_RUN='false';process.env.REDIS_PORT='1';
execFileSync('./node_modules/.bin/prisma',['db','push','--skip-generate'],{env:process.env,stdio:'pipe'});
const {prisma}=await import('../src/db.js');
const {redisConnection}=await import('../src/queue/connection.js');redisConnection.disconnect();
const service=await import('../src/warmup/service.js');
const runner=await import('../src/warmup/runner.js');
const {localParts}=await import('../src/warmup/model.js');
let passed=0;async function check(name:string,fn:()=>Promise<void>){await fn();passed++;console.log(`PASS ${name}`);}
const day=localParts(new Date(),'UTC').date;
let submits=0,providerStatus=0,submissionTimeout=false;
runner.warmupIo.withTripLease=async(_d:any,_t:any,fn:any)=>fn({assertOwned:async()=>{}});
runner.warmupIo.checkDevicePower=async()=>({poweredOn:true,duoPlusStatus:1}) as any;
runner.warmupIo.getDeviceStatus=async(imageId)=>({id:imageId,gps:{latitude:'25.78',longitude:'-80.13',type:2},wifi:{name:'Current',bssid:'aa:bb:cc:dd:ee:00',mac:'aa:bb:cc:dd:ee:02',status:1}});
runner.warmupIo.triggerRpaTask=async(_i,_t,_v,opts)=>{await opts?.beforeSend?.();submits++;if(submissionTimeout)throw new Error('Lost acknowledgment');return {message:'success'};};
runner.warmupIo.warmupProvider=async(path,body:any)=>{if(path!=='taskList')throw new Error('Unexpected provider mutation');return {list:[{id:'provider-'+body.name,name:body.name,status:providerStatus}],total:1};};
try{
 await prisma.tenant.createMany({data:[{id:'a',name:'A'},{id:'b',name:'B'}]});
 for(const [id,tenantId] of [['phone','a'],['other','b'],['phone2','a']])await prisma.device.create({data:{id,tenantId,imageId:id,name:id,campaignEnd:new Date(Date.now()+86400000*50),anchorLat:25.78,anchorLng:-80.13,currentLat:25.78,currentLng:-80.13,wifiSsid:'Existing',wifiBssid:'aa:bb:cc:dd:ee:00',wifiMac:'aa:bb:cc:dd:ee:02'}});
 const city=await service.cityCreate('a',{name:'Miami',timezone:'UTC',lat:25.78,lng:-80.13,radiusM:20000});
 const input={name:'Profile campaign',deviceId:'phone',cityId:city.id,clientFolder:'Client',lat:25.78,lng:-80.13,timezone:'UTC',providerTimezone:'UTC',startDate:day,durationDays:30,schedule:[{key:'daily',name:'Daily',time:'00:00',templateId:'custom',preservesProfile:true}]};
 let c:any;
 await check('tenant isolation and geographic ownership',async()=>{await assert.rejects(service.campaignCreate('b',input));await assert.rejects(service.campaignCreate('a',{...input,lat:28}));});
 await check('same-image campaign reservation is unique',async()=>{c=await service.campaignCreate('a',input);await assert.rejects(service.campaignCreate('a',input));await assert.rejects(service.assertNoWarmup('phone'));});
 await check('start and repeated planner scans materialize each daily task once',async()=>{await service.campaignAction('a',c.id,'start');await service.materializeDays(c.id);const count=await prisma.warmupRun.count();await service.materializeDays(c.id);assert.equal(await prisma.warmupRun.count(),count);});
 await check('dispatch records acceptance without claiming completion or duplicating sends',async()=>{await runner.scanWarmup();await runner.scanWarmup();assert.equal(submits,1);const r=await prisma.warmupRun.findFirstOrThrow({where:{campaignId:c.id,dayNumber:1}});assert.equal(r.status,'AWAITING');assert.equal(r.completedAt,null);});
 await check('pause keeps remote task ownership and result reconciliation',async()=>{await service.campaignAction('a',c.id,'pause');providerStatus=1;await prisma.warmupRun.updateMany({where:{campaignId:c.id,dayNumber:1},data:{nextCheckAt:new Date(0)}});await runner.scanWarmup();assert.equal(submits,1);assert.equal((await prisma.warmupRun.findFirstOrThrow({where:{campaignId:c.id,dayNumber:1}})).status,'RUNNING');await assert.rejects(service.campaignAction('a',c.id,'cancel'));});
 await check('confirmed provider completion unlocks lifecycle without erasing profile',async()=>{providerStatus=3;await prisma.warmupRun.updateMany({where:{campaignId:c.id,dayNumber:1},data:{nextCheckAt:new Date(0)}});await runner.scanWarmup();const view=await service.warmupView('a');assert.equal(view.campaigns[0]!.counts.SUCCEEDED,1);assert.equal(view.campaigns[0]!.status,'PAUSED');assert.equal((await prisma.device.findUniqueOrThrow({where:{id:'phone'}})).wifiMac,'aa:bb:cc:dd:ee:02');});
 await check('restart recovers preflight but never resubmits an uncertain accepted task',async()=>{const c2=await service.campaignCreate('a',{...input,name:'Second',deviceId:'phone2'});await service.campaignAction('a',c2.id,'start');submissionTimeout=true;providerStatus=0;await runner.scanWarmup();assert.equal(submits,2);await runner.recoverWarmup();await runner.scanWarmup();assert.equal(submits,2);const row=await prisma.warmupRun.findFirstOrThrow({where:{campaignId:c2.id,dayNumber:1}});assert.ok(['UNCONFIRMED','AWAITING'].includes(row.status));});
 await check('city observations are shared without rewriting historical dates',async()=>{await service.cityImport('a',city.id,{records:[{kind:'WIFI',identifier:'aa:bb:cc:dd:ee:00',ssid:'Historical AP',lat:25.78,lng:-80.13,qos:5,lastSeen:'2025-01-01T00:00:00Z'}]});const fresh=await prisma.warmupCity.findUniqueOrThrow({where:{id:city.id}});assert.equal(JSON.parse(fresh.recordsJson)[0].lastSeen,'2025-01-01T00:00:00Z');assert.equal(service.selectCityWifi(fresh.recordsJson,25.78,-80.13)!.ssid,'Historical AP');await assert.rejects(service.cityImport('b',city.id,{records:[]}));});
 await check('duration extension retains timeline and history',async()=>{const before=await prisma.warmupRun.count({where:{campaignId:c.id}});await service.campaignAction('a',c.id,'extend',{durationDays:60});assert.equal((await service.ownCampaign('a',c.id)).durationDays,60);assert.equal(await prisma.warmupRun.count({where:{campaignId:c.id}}),before);});
 await check('cancelled campaign releases reservation, retaining immutable task history',async()=>{await service.campaignAction('a',c.id,'cancel');await service.assertNoWarmup('phone');assert.ok(await prisma.warmupRun.count({where:{campaignId:c.id,status:'SUCCEEDED'}}));assert.equal((await service.ownCampaign('a',c.id)).reservedImageId,null);});
 await check('hardware profile change prevents a new RPA submission',async()=>{
  const next=await service.campaignCreate('a',{...input,name:'Continuity test'});await service.campaignAction('a',next.id,'start');
  await prisma.warmupCampaign.update({where:{id:next.id},data:{profileBaselineJson:JSON.stringify({imageId:'phone',wifiMac:'aa:bb:cc:dd:ee:99'})}});
  await runner.scanWarmup();assert.equal(submits,2);const r=await prisma.warmupRun.findFirstOrThrow({where:{campaignId:next.id,dayNumber:1}});assert.match(r.error!,/hardware MAC changed/);assert.equal(r.status,'WAITING');
  await service.campaignAction('a',next.id,'pause');await service.campaignAction('a',next.id,'cancel');
 });
 await check('auto-start waits when no unexpired subscription slot is available',async()=>{
  const next=await service.campaignCreate('a',{...input,name:'Capacity test',autoPower:true});await service.campaignAction('a',next.id,'start');
  runner.warmupIo.checkDevicePower=async()=>({poweredOn:false,duoPlusStatus:2}) as any;
  const previous=runner.warmupIo.warmupProvider;
  runner.warmupIo.warmupProvider=async(path,body:any)=>path==='subscriptions'?{list:[],total_page:0}:previous(path,body,'a');
  await runner.scanWarmup();assert.equal(submits,2);const r=await prisma.warmupRun.findFirstOrThrow({where:{campaignId:next.id,dayNumber:1}});assert.match(r.error!,/available DuoPlus subscription slot/);assert.equal((await service.ownCampaign('a',next.id)).powerOwned,false);
 });
 console.log(`${passed} integration checks passed`);
}finally{await prisma.$disconnect();redisConnection.disconnect();rmSync(dir,{recursive:true,force:true});}
