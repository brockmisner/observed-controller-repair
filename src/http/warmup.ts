import type { IncomingMessage,ServerResponse } from 'node:http';
import { HttpError } from './errors.js';
import { campaignAction,campaignCreate,campaignHistory,cityCreate,cityImport,resolveRun,retryRun,warmupView } from '../warmup/service.js';
import { runtime,templateCatalog } from '../warmup/runner.js';
import { previewRadio } from '../radio/preview.js';
async function read(req:IncomingMessage) {if(!req.headers['content-type']?.startsWith('application/json'))throw new HttpError(415,'JSON required');let size=0;const chunks:Buffer[]=[];for await(const chunk of req.iterator({destroyOnReturn:false})){size+=Buffer.byteLength(chunk);if(size>2000000){req.resume();throw new HttpError(413,'Body exceeds 2 MB');}chunks.push(Buffer.from(chunk));}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new HttpError(400,'Invalid JSON');}}
export async function handleWarmupRequest(req:IncomingMessage,res:ServerResponse,url:URL,tenantId?:string) {
 const path=url.pathname;if(!path.startsWith('/api/warmup'))return false;if(!tenantId)throw new HttpError(401,'Workspace login required');
 const method=req.method??'GET';let result:unknown;
 const radioPreview=path.match(/^\/api\/warmup\/cities\/([^/]+)\/radio-preview$/);
 const campaign=path.match(/^\/api\/warmup\/campaigns\/([^/]+)\/(history|start|pause|resume|cancel|extend)$/),city=path.match(/^\/api\/warmup\/cities\/([^/]+)\/import$/),run=path.match(/^\/api\/warmup\/runs\/([^/]+)\/(resolve|retry)$/);
 if(path==='/api/warmup'&&method==='GET')result={...await warmupView(tenantId),runtime};
 else if(path==='/api/warmup/templates'&&method==='GET')result=await templateCatalog(tenantId);
 else if(path==='/api/warmup/cities'&&method==='POST')result=await cityCreate(tenantId,await read(req));
 else if(path==='/api/warmup/campaigns'&&method==='POST')result=await campaignCreate(tenantId,await read(req));
 else if(radioPreview&&method==='POST')result=await previewRadio(tenantId,decodeURIComponent(radioPreview[1]!),await read(req));
 else if(city&&method==='POST')result=await cityImport(tenantId,decodeURIComponent(city[1]!),await read(req));
 else if(campaign&&method==='GET'&&campaign[2]==='history')result=await campaignHistory(tenantId,decodeURIComponent(campaign[1]!));
 else if(campaign&&method==='POST'&&campaign[2]!=='history')result=await campaignAction(tenantId,decodeURIComponent(campaign[1]!),campaign[2]!,await read(req));
 else if(run&&method==='POST')result=run[2]==='resolve'?await resolveRun(tenantId,decodeURIComponent(run[1]!),await read(req)):await retryRun(tenantId,decodeURIComponent(run[1]!));
 else throw new HttpError(404,'Warmup endpoint not found');
 res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(result));return true;
}
