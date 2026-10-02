import type {IncomingMessage,ServerResponse} from 'node:http';
import {HttpError} from './errors.js';
export interface EnvironmentHttpDependencies {
  findDevice(tenant:string,id:string):Promise<{imageId:string;activeTripId:string|null}|null>;
  status(tenant:string,image:string):unknown;
  read(tenant:string,image:string):Promise<unknown>;
  start(tenant:string,image:string,tripId:string):Promise<unknown>;
  stop(tenant:string,image:string):Promise<unknown>;
}
/** Always authenticated, even when the legacy dashboard is configured public. */
export function createEnvironmentHandler(deps:EnvironmentHttpDependencies){
  return async(req:IncomingMessage,res:ServerResponse,url:URL,tenant?:string)=>{
    const match=/^\/api\/environment-observer\/devices\/([^/]+)(?:\/(readback|lab-start|lab-stop))?$/.exec(url.pathname);if(!match)return false;
    if(!tenant)throw new HttpError(401,'Workspace authentication required');
    const action=match[2];if(req.method!==(action?'POST':'GET'))throw new HttpError(405,'Method not allowed');
    const device=await deps.findDevice(tenant,decodeURIComponent(match[1]!));if(!device)throw new HttpError(404,'Device not found in workspace');
    req.resume();let result:unknown;
    try{
      if(!action)result=deps.status(tenant,device.imageId);
      else if(action==='readback')result=await deps.read(tenant,device.imageId);
      else if(action==='lab-stop')result=await deps.stop(tenant,device.imageId);
      else{if(!device.activeTripId)throw new Error('Start an existing modeled trip first');result=await deps.start(tenant,device.imageId,device.activeTripId);}
    }catch(error){throw new HttpError(409,error instanceof Error?error.message:'Environment action failed');}
    const body=JSON.stringify(result);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body)});res.end(body);return true;
  };
}
