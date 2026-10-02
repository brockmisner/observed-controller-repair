import test from 'node:test';import assert from 'node:assert/strict';
import {WifiVisibility,DestinationIntent} from '../src/radio/environmentPolicy.js';
test('Wi-Fi visibility uses separate entry and exit thresholds without rotating identities',()=>{
 const v=new WifiVisibility({entryDbm:-88,exitDbm:-92,entryM:60,exitM:90});
 assert.equal(v.update('a',-80,55),true);assert.equal(v.update('a',-90,80),true);assert.equal(v.update('b',-90,80),false);
 assert.equal(v.update('a',-93,80),false);assert.equal(v.update('a',-89,55),false);assert.equal(v.update('a',-80,55),true);v.retain(new Set());assert.equal(v.update('a',-90,80),false);
});
test('destination intent requires continuous fresh dwell and uses exit hysteresis',()=>{
 const d=new DestinationIntent('02:11:22:33:44:55');const fix=(now:number,extra={})=>({nowMs:now,sampledMs:now,distanceM:10,speedMps:0,accuracyM:5,terminal:true,...extra});
 assert.equal(d.update(fix(0,{terminal:false})).desiredBssid,null);assert.equal(d.update(fix(1000)).phase,'ARRIVAL_PENDING');
 for(let n=2000;n<=16000;n+=1000)d.update(fix(n));assert.equal(d.snapshot().desiredBssid,'02:11:22:33:44:55');assert.equal(d.snapshot().connected,false);
 assert.equal(d.update(fix(17000,{distanceM:32})).phase,'ARRIVED');assert.equal(d.update(fix(18000,{distanceM:50})).phase,'DEPARTING');
 for(let n=19000;n<=28000;n+=1000)d.update(fix(n,{distanceM:50}));assert.equal(d.snapshot().desiredBssid,null);
});
test('arrival cannot bridge missing observations or interpret unknown speed as stationary',()=>{
 const d=new DestinationIntent('02:11:22:33:44:55');const fix=(n:number)=>({nowMs:n,sampledMs:n,distanceM:0,speedMps:0,accuracyM:4,terminal:true});
 d.update(fix(0));d.update(fix(16000));assert.equal(d.snapshot().phase,'ARRIVAL_PENDING');
 assert.equal(d.update({...fix(17000),speedMps:null}).phase,'TRAVELING');assert.equal(d.update({...fix(18000),sampledMs:1000}).desiredBssid,null);
 assert.throws(()=>d.update(fix(17000)),/clock/);
});
