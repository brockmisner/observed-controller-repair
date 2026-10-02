import { performance } from 'node:perf_hooks';
import type { EnvironmentCommand } from './environmentTransport.js';

/** Bounded process-local cache; an old observation is never restamped after a failed request. */
export class ObservationCache<T=unknown> {
  private readonly cache=new Map<string,{value:T|null;at:number|null;error:string|null;attempt:number}>();
  private readonly pending=new Map<string,Promise<T>>();
  constructor(private readonly now:()=>number=()=>performance.now()){}
  private key(tenant:string,image:string){return JSON.stringify([tenant,image]);}
  get(tenant:string,image:string){const entry=this.cache.get(this.key(tenant,image));return entry?{value:entry.value,ageMs:entry.at===null?null:Math.max(0,this.now()-entry.at),error:entry.error}:null;}
  async capture(tenant:string,image:string,read:()=>Promise<T>):Promise<T>{
    const key=this.key(tenant,image),pending=this.pending.get(key);if(pending)return pending;
    const previous=this.cache.get(key),now=this.now();
    if(previous&&now-previous.attempt<2000)throw new Error('Observation rate limited; retry after two seconds');
    if(!previous&&this.cache.size>=1000){const oldest=this.cache.keys().next().value;if(oldest!==undefined)this.cache.delete(oldest);}
    const entry:{value:T|null;at:number|null;error:string|null;attempt:number}={value:previous?.value??null,at:previous?.at??null,error:previous?.error??null,attempt:now};this.cache.set(key,entry);
    const work=Promise.resolve().then(read).then(value=>{entry.value=value;entry.at=this.now();entry.error=null;return value;},error=>{entry.error='OBSERVATION_FAILED';throw error;}).finally(()=>this.pending.delete(key));
    this.pending.set(key,work);return work;
  }
}
export interface LabFrame {synthetic:boolean;imageId:string;tenantId:string;sessionId:string;sequence:number;elapsedMs:number;[key:string]:unknown}
/** No automatic reconnect or hidden lease renewal. A failure requires an explicit new epoch. */
export class LabFollower {
  private identity:{imageId:string;tenantId:string;sessionId:string;epoch:number}|null=null;
  private sequence=-1;private elapsed=-1;private lastFrame='';private lastFresh=0;private failed=false;
  constructor(private readonly send:(command:EnvironmentCommand)=>Promise<unknown>,private readonly now:()=>number=()=>performance.now()){}
  async open(frame:LabFrame,epoch:number){
    if(this.identity)throw new Error('Lab follower already owns a session');
    if(!frame.synthetic||!Number.isSafeInteger(epoch)||epoch<1)throw new Error('Invalid lab session');
    await this.send({op:'open',sessionId:frame.sessionId,epoch});
    this.identity={imageId:frame.imageId,tenantId:frame.tenantId,sessionId:frame.sessionId,epoch};this.lastFresh=this.now();
  }
  async tick(frame:LabFrame){
    const id=this.identity;if(!id||this.failed)throw new Error('Lab session needs explicit restart');
    if(!frame.synthetic||frame.imageId!==id.imageId||frame.tenantId!==id.tenantId||frame.sessionId!==id.sessionId)throw new Error('Lab frame identity mismatch');
    if(this.now()-this.lastFresh>=5000){this.failed=true;throw new Error('Lab producer is stale; lease must expire');}
    const json=JSON.stringify(frame);
    if(frame.sequence===this.sequence){if(json!==this.lastFrame)throw new Error('Lab sequence collision');return;}
    if(!Number.isSafeInteger(frame.sequence)||frame.sequence<=this.sequence||!Number.isSafeInteger(frame.elapsedMs)||frame.elapsedMs<=this.elapsed)throw new Error('Lab sequence or simulation clock regression');
    try{await this.send({op:'stage',sessionId:id.sessionId,epoch:id.epoch,sequence:frame.sequence,leaseMs:5000,frame});}
    catch(error){this.failed=true;throw error;}
    this.sequence=frame.sequence;this.elapsed=frame.elapsedMs;this.lastFrame=json;this.lastFresh=this.now();
  }
  async stop(){const id=this.identity;this.failed=true;this.identity=null;if(id)await this.send({op:'close',sessionId:id.sessionId,epoch:id.epoch});}
}
