import test from 'node:test';import assert from 'node:assert/strict';
import {createEnvironmentHandler} from '../src/http/environmentObserver.js';
const url=new URL('http://localhost/api/environment-observer/devices/A/readback');
test('observer endpoint refuses unauthenticated reads before touching device registry',async()=>{
 let calls=0;const handle=createEnvironmentHandler({findDevice:async()=>{calls++;return null;},status:()=>null,read:async()=>null,start:async()=>null,stop:async()=>null});
 await assert.rejects(handle({method:'POST'} as any,{} as any,url),/authentication/);assert.equal(calls,0);
});
test('observer endpoint resolves device within tenant and never sends a foreign request',async()=>{
 let calls=0;const handle=createEnvironmentHandler({findDevice:async(t,id)=>{assert.equal(t,'T');assert.equal(id,'A');return null;},status:()=>null,read:async()=>{calls++;},start:async()=>null,stop:async()=>null});
 await assert.rejects(handle({method:'POST'} as any,{} as any,url,'T'),/not found/);assert.equal(calls,0);
});
test('observer action reaches the scoped physical image',async()=>{
 let output='';const handle=createEnvironmentHandler({findDevice:async()=>({imageId:'PHONE-A',activeTripId:null}),status:()=>null,read:async(t,id)=>({tenant:t,image:id}),start:async()=>null,stop:async()=>null});
 const res={writeHead:(s:number)=>assert.equal(s,200),end:(s:string)=>{output=s;}};
 assert.equal(await handle({method:'POST',resume(){}} as any,res as any,url,'T'),true);assert.deepEqual(JSON.parse(output),{tenant:'T',image:'PHONE-A'});
});
