import { RadioEngine,radioOptionsSchema,type RadioFrame } from './engine.js';
import type { Position } from './schema.js';

/** In-memory simulation sessions only. Expiry/restart require an explicit new session. */
export class RadioSessions {
  private sessions=new Map<string,{engine:RadioEngine;touched:number}>();
  constructor(private readonly maxSessions=100,private readonly ttlMs=60000) {}
  private key(tenantId:string,imageId:string) {return JSON.stringify([tenantId,imageId]);}
  open(records:unknown,raw:unknown,now:number) {
    const options=radioOptionsSchema.parse(raw);
    this.expire(now);
    // Reserve the physical image across workspaces, while keeping caller access tenant-scoped.
    if([...this.sessions.values()].some(s=>s.engine.options.imageId===options.imageId))throw new Error('Phone already owns a radio session');
    if(this.sessions.size>=this.maxSessions)throw new Error('Radio session capacity reached');
    this.sessions.set(this.key(options.tenantId,options.imageId),{engine:new RadioEngine(records,options),touched:now});
  }
  frame(tenantId:string,imageId:string,sessionId:string,position:Position,elapsedMs:number,sequence:number,phase:'MOVING'|'ARRIVED',now:number):RadioFrame {
    this.expire(now);
    const s=this.sessions.get(this.key(tenantId,imageId));
    if(!s||s.engine.options.sessionId!==sessionId)throw new Error('Radio session unavailable or expired');
    const frame=s.engine.frame(position,elapsedMs,sequence,phase);s.touched=now;return frame;
  }
  close(tenantId:string,imageId:string,sessionId:string) {
    const key=this.key(tenantId,imageId),s=this.sessions.get(key);
    if(!s||s.engine.options.sessionId!==sessionId)throw new Error('Radio session unavailable');
    this.sessions.delete(key);
  }
  private expire(now:number) {
    if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid session clock');
    for(const [key,s] of this.sessions)if(now-s.touched>=this.ttlMs||now<s.touched)this.sessions.delete(key);
  }
}
