import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../http/errors.js';
import { RadioEngine } from './engine.js';
import { haversineMeters } from '../geo/haversine.js';
import { positionSchema } from './schema.js';

export async function previewRadio(tenantId:string,cityId:string,raw:unknown) {
  const input=z.object({deviceId:z.string().min(1).max(200),position:positionSchema.optional()}).strict().parse(raw);
  const [city,device]=await Promise.all([prisma.warmupCity.findFirst({where:{id:cityId,tenantId}}),prisma.device.findFirst({where:{id:input.deviceId,tenantId}})]);
  if(!city||!device)throw new HttpError(404,'Phone or city not found in workspace');
  const position=input.position??{lat:device.anchorLat,lng:device.anchorLng};
  if(haversineMeters(city.lat,city.lng,position.lat,position.lng)>city.radiusM)throw new HttpError(400,'Preview is outside the assigned area');
  if(!/^\d{3}$/.test(device.mcc)||!/^\d{2,3}$/.test(device.mnc))throw new HttpError(409,'Phone needs a confirmed MCC/MNC before cellular modeling');
  const engine=new RadioEngine(JSON.parse(city.recordsJson),{tenantId,imageId:device.imageId,sessionId:randomUUID(),datasetRevision:`${city.id}:${city.revision}`,mcc:device.mcc,mnc:device.mnc});
  return {mode:'SIMULATION_PREVIEW',applied:false,androidVerified:false,frame:engine.frame(position,0,0)};
}
