import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationCache, LabFollower } from '../src/radio/environmentSession.js';
const frame=(seq=1)=>({synthetic:true,imageId:'A',tenantId:'T',sessionId:'11111111-1111-4111-8111-111111111111',sequence:seq,elapsedMs:seq*1000,wifi:[],cells:[],bluetooth:null,bluetoothAction:'HOLD'});
test('observation cache deduplicates in-flight work without crossing tenants',async()=>{
 let now=0,count=0;const cache=new ObservationCache(()=>now);let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const task=()=>{count++;return gate.then(()=>({value:42}));};
 const a=cache.capture('T','A',task),b=cache.capture('T','A',task);release();assert.deepEqual(await a,await b);assert.equal(count,1);
 now=1000;assert.equal(cache.get('T','A')?.ageMs,1000);assert.equal(cache.get('OTHER','A'),null);
});
test('failed captures retain old age and expose failure instead of invented fresh evidence',async()=>{
 let now=0;const cache=new ObservationCache(()=>now);await cache.capture('T','A',async()=>({value:42}));now=3000;
 await assert.rejects(cache.capture('T','A',async()=>{throw new Error('offline');}));assert.equal(cache.get('T','A')?.ageMs,3000);assert.equal(cache.get('T','A')?.error,'OBSERVATION_FAILED');
});
test('lab follower opens once, stages new route frames only, and closes explicitly',async()=>{
 const sent:any[]=[];const follower=new LabFollower(async(c)=>{sent.push(c);return {applied:false,status:'STAGED_TEST_STATE'};},()=>100);
 await follower.open(frame(),7);await follower.tick(frame());await follower.tick(frame());await follower.tick(frame(2));await follower.stop();
 assert.deepEqual(sent.map(c=>c.op),['open','stage','stage','close']);assert.equal(sent[1].frame.synthetic,true);assert.equal(sent[1].leaseMs,5000);
});
test('lab follower rejects foreign frames and requires explicit restart after failure',async()=>{
 let fail=false;const sent:any[]=[];const follower=new LabFollower(async(c)=>{sent.push(c);if(fail)throw Error('offline');return {};});
 await follower.open(frame(),9);await assert.rejects(follower.tick({...frame(),imageId:'B'}));assert.equal(sent.length,1);
 fail=true;await assert.rejects(follower.tick(frame()));fail=false;await assert.rejects(follower.tick(frame(2)));assert.equal(sent.length,2);
});
test('lab follower fails closed on a stale producer, rather than renewing duplicate frames',async()=>{
 let now=0;const sent:any[]=[];const f=new LabFollower(async c=>{sent.push(c);return{};},()=>now);
 await f.open(frame(),9);await f.tick(frame());now=5001;await assert.rejects(f.tick(frame()),/stale/i);assert.equal(sent.length,2);
});
