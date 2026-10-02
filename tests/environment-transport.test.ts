import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { exchangeEnvironment, EnvironmentGateway } from '../src/radio/environmentTransport.js';
import { signPayload, verifyPayload } from '../src/radio/environmentProtocol.js';
const key='b'.repeat(64);
async function fixture(reply:(socket:any,c:any)=>void,imageId='PHONE_A',role='lab'){
 const sockets=new Set<any>();
 const server=createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));const c={protocol:'stakeout.environment',version:1,type:'challenge',imageId,bootId:'boot',instanceId:'proc',role,nonce:randomBytes(32).toString('hex')};s.write(JSON.stringify(c)+'\n');reply(s,c);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 return{port:(server.address() as any).port,close:()=>new Promise<void>(r=>{for(const s of sockets)s.destroy();server.close(()=>r());})};
}
test('real loopback exchange authenticates both directions and binds request ID',async()=>{
 const f=await fixture((s,c)=>s.once('data',(b:Buffer)=>{const q=JSON.parse(b.toString());assert.equal(verifyPayload(key,c.nonce,'request',q.payload,q.mac),true);const p=JSON.parse(q.payload);const payload=JSON.stringify({...p,protocol:'stakeout.environment',version:1,type:'lab.result',status:'STATE',applied:false});s.end(JSON.stringify({version:1,payload,mac:signPayload(key,c.nonce,'response',payload)})+'\n');}));
 try{const r:any=await exchangeEnvironment({port:f.port,key,imageId:'PHONE_A',role:'lab',command:{op:'state'}});assert.equal(r.status,'STATE');assert.equal(r.applied,false);}finally{await f.close();}
});
test('response tampering is rejected',async()=>{const f=await fixture((s)=>s.once('data',()=>s.end(JSON.stringify({version:1,payload:'{}',mac:'0'.repeat(64)})+'\n')));try{await assert.rejects(exchangeEnvironment({port:f.port,key,imageId:'PHONE_A',role:'lab',command:{op:'state'}}),/signature/);}finally{await f.close();}});
test('foreign phone fails closed',async()=>{const f=await fixture(()=>{},'PHONE_B');try{await assert.rejects(exchangeEnvironment({port:f.port,key,imageId:'PHONE_A',role:'lab',command:{op:'state'}}),/identity/);}finally{await f.close();}});
test('unresponsive receiver has a bounded deadline',async()=>{const f=await fixture(()=>{});try{await assert.rejects(exchangeEnvironment({port:f.port,key,imageId:'PHONE_A',role:'lab',command:{op:'state'},timeoutMs:80}),/timed out/);}finally{await f.close();}});
test('two devices use separate credentials and forwards; failures still clean up',async()=>{
 const calls:string[]=[];let next=31000;
 const gateway=new EnvironmentGateway({resolve:(imageId:string)=>({imageId,endpoint:imageId}),connect:async t=>{calls.push('connect:'+t.imageId);},forward:async(t,p)=>{calls.push('forward:'+t.imageId+':'+p);return next++;},removeForward:async(t,p)=>{calls.push('remove:'+t.imageId+':'+p);},credential:async(t,r)=>t.imageId+'-'+r,exchange:async o=>{calls.push('key:'+o.key);if(o.imageId==='B')throw new Error('lost');return {ok:true};}});
 await gateway.request('A','observer',{op:'observe'});await assert.rejects(gateway.request('B','lab',{op:'state'}),/lost/);
 assert.deepEqual(calls,['connect:A','forward:A:9997','key:A-observer','remove:A:31000','connect:B','forward:B:9996','key:B-lab','remove:B:31001']);
});
test('signed lab acknowledgments with the wrong sequence are rejected',async()=>{
 const f=await fixture((s,c)=>s.once('data',(b:Buffer)=>{const p=JSON.parse(JSON.parse(b.toString()).payload);const payload=JSON.stringify({...p,protocol:'stakeout.environment',version:1,type:'lab.result',status:'STAGED_TEST_STATE',applied:false,sequence:999});s.end(JSON.stringify({version:1,payload,mac:signPayload(key,c.nonce,'response',payload)})+'\n');}));
 try{await assert.rejects(exchangeEnvironment({port:f.port,key,imageId:'PHONE_A',role:'lab',command:{op:'stage',sessionId:'s',epoch:1,sequence:1,leaseMs:1000,frame:{}}}),/sequence mismatch/);}finally{await f.close();}
});
test('oversized incoming frames are rejected',async()=>{const f=await fixture(s=>s.write('x'.repeat(140000)));try{await assert.rejects(exchangeEnvironment({port:f.port,key,imageId:'PHONE_A',role:'lab',command:{op:'state'}}),/size limit/);}finally{await f.close();}});
