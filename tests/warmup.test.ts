import test from 'node:test';
import assert from 'node:assert/strict';
import { zonedTime,localParts,dailyPlan,expectedTaskCount,taskEvidence,taskSchema,campaignSchema,dayNumber,driveSlotSchema } from '../src/warmup/model.js';
import { atHome,gpsPreflight,mayReleasePower,movementWindowOutcome,dependentDispatch,resolveDriveDestination,isDriveSlot,parseScheduleItems,encodeCampaignSchedule } from '../src/warmup/movement.js';
const task=taskSchema.parse({key:'news',name:'News',time:'09:00',templateId:'template',preservesProfile:true});
test('schedule keeps local time across spring DST, without duplicating a day',()=>{const p=dailyPlan('2026-03-07',3,'America/New_York',[task]);assert.deepEqual(p.map(x=>x.scheduledAt.toISOString()),['2026-03-07T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-09T13:00:00.000Z']);assert.deepEqual(p.map(x=>x.dayNumber),[1,2,3]);});
test('spring nonexistent time advances to the first valid local minute',()=>assert.equal(zonedTime('2026-03-08','02:30','America/New_York').toISOString(),'2026-03-08T07:00:00.000Z'));
test('fall repeated time chooses one earlier occurrence',()=>assert.equal(zonedTime('2026-11-01','01:30','America/New_York').toISOString(),'2026-11-01T05:30:00.000Z'));
test('half-hour and quarter-hour timezones preserve daily wall clock',()=>{assert.equal(zonedTime('2026-09-17','09:00','Asia/Kathmandu').toISOString(),'2026-09-17T03:15:00.000Z');assert.equal(zonedTime('2026-09-17','09:00','Australia/Adelaide').toISOString(),'2026-09-16T23:30:00.000Z');});
test('phase ranges generate only their selected days and longer campaigns are supported',()=>{const t={...task,firstDay:4,lastDay:10};assert.equal(dailyPlan('2026-09-17',60,'UTC',[t]).length,7);assert.equal(expectedTaskCount(60,[task,t]),67);});
test('deadline is local midnight, including a 23-hour day',()=>{const p=dailyPlan('2026-03-08',1,'America/New_York',[{...task,time:'00:00'}])[0]!;assert.equal(+p.deadlineAt-+p.scheduledAt,23*3600000);});
test('calendar day count does not depend on elapsed DST hours',()=>assert.equal(dayNumber('2026-03-07','2026-03-09'),3));
test('task acceptance and execution are separate from success',()=>{for(const [status,state] of [[0,'AWAITING'],[1,'RUNNING'],[2,'REMOTE_PAUSED'],[3,'SUCCEEDED'],[4,'FAILED'],[5,'CANCELLED']] as const)assert.equal(taskEvidence({list:[{id:'x',name:'unique',status}]},'unique')!.state,state);});
test('task reconciliation rejects fuzzy names, duplicate matches, changed IDs and unknown states',()=>{assert.equal(taskEvidence({list:[{id:'x',name:'unique-extra',status:3}]},'unique'),null);assert.throws(()=>taskEvidence({list:[{id:'x',name:'unique',status:3},{id:'y',name:'unique',status:3}]},'unique'));assert.throws(()=>taskEvidence({list:[{id:'x',name:'unique',status:3}]},'unique','old'));assert.throws(()=>taskEvidence({list:[{id:'x',name:'unique',status:99}]},'unique'));});
test('templates must explicitly preserve the phone profile',()=>{assert.throws(()=>taskSchema.parse({...task,preservesProfile:false}));assert.throws(()=>taskSchema.parse({...task,preservesProfile:undefined}));});
test('campaign validation rejects duplicate daily task keys and impossible dates',()=>{const c={deviceId:'a',cityId:'b',name:'Campaign',clientFolder:'Client',startDate:'2026-09-17',durationDays:45,lat:25,lng:-80,timezone:'America/New_York',providerTimezone:'UTC',schedule:[task]};assert.equal(campaignSchema.parse(c).durationDays,45);assert.throws(()=>campaignSchema.parse({...c,startDate:'2026-02-30'}));assert.throws(()=>campaignSchema.parse({...c,schedule:[task,task]}));assert.throws(()=>campaignSchema.parse({...c,timezone:'Mars/Olympus'}));});
const drive=driveSlotSchema.parse({key:'outbound',name:'Outbound',time:'08:00',kind:'DRIVE',destination:{lat:25.79,lng:-80.12},preservesProfile:true});
test('movement slots sit beside RPA without consuming the 12-template cap',()=>{
  const rpa=Array.from({length:12},(_,i)=>taskSchema.parse({...task,key:`t${i}`}));
  const parsed=campaignSchema.parse({deviceId:'a',cityId:'b',name:'Campaign',clientFolder:'Client',startDate:'2026-09-17',durationDays:30,lat:25,lng:-80,timezone:'America/New_York',providerTimezone:'UTC',schedule:rpa,movement:[drive]});
  assert.equal(parsed.schedule.length,12);assert.equal(parsed.movement.length,1);
  const encoded=encodeCampaignSchedule(parsed.schedule,parsed.movement);
  const items=parseScheduleItems(encoded);
  assert.equal(items.filter(isDriveSlot).length,1);
  assert.equal(expectedTaskCount(30,items),30*13);
  const keys=dailyPlan('2026-09-17',1,'UTC',items).map(x=>x.slotKey);
  assert.equal(keys[0],'outbound');
  assert.equal(keys.length,13);
});
test('RPA dependsOn must name a movement slot, and keys stay unique across both lists',()=>{
  const c={deviceId:'a',cityId:'b',name:'Campaign',clientFolder:'Client',startDate:'2026-09-17',durationDays:30,lat:25,lng:-80,timezone:'America/New_York',providerTimezone:'UTC',schedule:[{...task,dependsOn:'outbound'}],movement:[drive]};
  assert.equal(campaignSchema.parse(c).schedule[0]!.dependsOn,'outbound');
  assert.throws(()=>campaignSchema.parse({...c,schedule:[{...task,dependsOn:'missing'}]}));
  assert.throws(()=>campaignSchema.parse({...c,schedule:[{...task,key:'outbound'}]}));
});
test('GPS preflight matches durable position, not the campaign home',()=>{
  const home={lat:25.78,lng:-80.13},durable={lat:25.7901,lng:-80.1201};
  assert.equal(gpsPreflight({durable,provider:durable,home,movementIncomplete:false}).action,'MATCH');
  assert.equal(gpsPreflight({durable,provider:home,home,movementIncomplete:false}).action,'ALIGN_PROVIDER');
  assert.equal(gpsPreflight({durable,provider:home,home,movementIncomplete:true}).action,'NEEDS_ATTENTION');
  assert.equal(atHome(durable,home),false);
  assert.equal(atHome(home,home),true);
});
test('overnight power-off is refused away from home or during movement',()=>{
  const idleHome=mayReleasePower({atHome:true,activeTrip:false,busyRuns:false,upcomingWork:false,phase:'IDLE'});
  assert.equal(idleHome.ok,true);
  assert.equal(mayReleasePower({atHome:false,activeTrip:false,busyRuns:false,upcomingWork:false,phase:'IDLE'}).ok,false);
  assert.equal(mayReleasePower({atHome:true,activeTrip:true,busyRuns:false,upcomingWork:false,phase:'NAVIGATING'}).ok,false);
  assert.equal(mayReleasePower({atHome:true,activeTrip:false,busyRuns:true,upcomingWork:false,phase:'IDLE'}).ok,false);
  assert.equal(mayReleasePower({atHome:true,activeTrip:false,busyRuns:false,upcomingWork:true,phase:'IDLE'}).ok,false);
});
test('travel that exceeds its window suspends in place and misses dependents without burst replay',()=>{
  const now=new Date('2026-09-18T04:00:00Z'),deadline=new Date('2026-09-18T04:00:00Z');
  assert.deepEqual(movementWindowOutcome({now,deadlineAt:deadline,tripStatus:'RUNNING'}),{action:'SUSPEND_IN_PLACE',status:'SUSPENDED_IN_PLACE',code:'WINDOW_EXCEEDED'});
  assert.equal(movementWindowOutcome({now:new Date('2026-09-18T03:00:00Z'),deadlineAt:deadline,tripStatus:'RUNNING'}).action,'CONTINUE');
  assert.equal(dependentDispatch({dependsOnStatus:'RUNNING',now,deadlineAt:deadline}).action,'WAIT');
  assert.equal(dependentDispatch({dependsOnStatus:'SUCCEEDED',now:new Date('2026-09-18T03:00:00Z'),deadlineAt:deadline}).action,'START');
  assert.equal(dependentDispatch({dependsOnStatus:'SUSPENDED_IN_PLACE',now,deadlineAt:new Date('2026-09-19T04:00:00Z')}).action,'MISS');
  assert.equal(dependentDispatch({dependsOnStatus:'MISSED',now:new Date('2026-09-18T03:00:00Z'),deadlineAt:deadline}).action,'MISS');
});
test('return drives target home; outbound holds an explicit destination',()=>{
  const home={lat:25.78,lng:-80.13};
  assert.deepEqual(resolveDriveDestination({...drive,destination:'HOME'},home),home);
  assert.deepEqual(resolveDriveDestination(drive,home),{lat:25.79,lng:-80.12});
});
