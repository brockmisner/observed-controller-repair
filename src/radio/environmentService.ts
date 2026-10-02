import { createHash,randomUUID } from 'node:crypto';
import { mkdir,writeFile,rename } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EnvironmentGateway } from './environmentTransport.js';
import { ObservationCache,LabFollower,type LabFrame } from './environmentSession.js';
import { summarizeReport,type EnvironmentReport } from './environmentProtocol.js';
import { readEnvironmentCredential } from './environmentCredentials.js';
import { realAdbDriver } from '../trips/playerConnection.js';
import { requirePlayerTarget,stateDirectory } from '../trips/playerTargets.js';
import { tripRadios } from './runtime.js';
import { producerConnection } from '../queue/connection.js';

export const environmentGateway=new EnvironmentGateway({
  resolve:requirePlayerTarget,
  connect:t=>realAdbDriver.connect(requirePlayerTarget(t.imageId)),
  forward:(t,p)=>realAdbDriver.forward(requirePlayerTarget(t.imageId),p),
  removeForward:(t,p)=>realAdbDriver.removeForward(requirePlayerTarget(t.imageId),p),
  credential:(t,role)=>readEnvironmentCredential(t.imageId,role),
});
const observations=new ObservationCache<EnvironmentReport>();
interface Active {tenant:string;image:string;tripId:string;follower:LabFollower;token:string;lock:string;status:string;timer?:NodeJS.Timeout;stopped:boolean;inflight?:Promise<void>;error:string|null;expires:number}
const active=new Map<string,Active>(),starting=new Set<string>();
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const unlockScript="if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
const renewScript="if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],30000) else return 0 end";
async function latestEvidence(tenant:string,image:string,report:EnvironmentReport){
  const file=join(stateDirectory(),'environment-observations',digest(JSON.stringify([tenant,image]))+'.json');
  await mkdir(dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';
  await writeFile(tmp,JSON.stringify({receivedAt:new Date().toISOString(),report}),{mode:0o600});await rename(tmp,file);
}
export function environmentStatus(tenant:string,image:string){
  const reading=observations.get(tenant,image),run=active.get(image);
  return {observation:reading?.value?summarizeReport(reading.value,reading.ageMs??0):null,error:reading?.error??null,
    lab:run?.tenant===tenant?{status:run.status,error:run.error,tripId:run.tripId,applied:false}:null,
    limitation:'Lab state is synthetic. Android API readback does not establish physical RF or device-wide simulation.'};
}
export async function captureEnvironment(tenant:string,image:string){
  const report=await observations.capture(tenant,image,async()=>{
    const value=await environmentGateway.request(image,'observer',{op:'observe'}) as EnvironmentReport;
    await latestEvidence(tenant,image,value);return value;
  });
  return {report,...environmentStatus(tenant,image)};
}
function frameFor(tenant:string,image:string,tripId:string):LabFrame{
  const runtime=tripRadios.get(tripId),identity=runtime?.identity(),latest=runtime?.lastAccepted();
  if(!runtime||identity?.tenantId!==tenant||identity.imageId!==image||!latest?.frame||latest.phase==='CLEANUP')throw new Error('No active modeled frame for this workspace, image and trip');
  return latest.frame;
}
export async function startEnvironmentLab(tenant:string,image:string,tripId:string){
  if(starting.has(image))throw new Error('Lab start already in progress');
  const existing=active.get(image);if(existing&&!existing.stopped)throw new Error('A lab session already owns this image');
  if(existing&&existing.tenant!==tenant)throw new Error('Image belongs to another lab owner');
  if(active.size>=1000&&!existing)throw new Error('Lab session capacity reached');
  starting.add(image);const lock='environment-lab:lock:'+digest(image),token=randomUUID();let acquired=false;
  try{
    const frame=frameFor(tenant,image,tripId);await readEnvironmentCredential(image,'lab');
    acquired=await producerConnection.set(lock,token,'PX',30000,'NX')==='OK';if(!acquired)throw new Error('Another worker owns this lab image; stop it or allow its lease to expire');
    const epoch=await producerConnection.incr('environment-lab:epoch:'+digest(image));
    const follower=new LabFollower(command=>environmentGateway.request(image,'lab',command));await follower.open(frame,epoch);await follower.tick(frame);
    const run:Active={tenant,image,tripId,follower,token,lock,status:'STAGED_TEST_STATE',stopped:false,error:null,expires:performance.now()+30*60_000};active.set(image,run);
    const loop=async()=>{
      if(run.stopped)return;
      try{
        if(performance.now()>run.expires)throw new Error('Lab run reached its 30-minute limit');
        if(Number(await producerConnection.eval(renewScript,1,lock,token))!==1)throw new Error('Lab image lease lost');
        await follower.tick(frameFor(tenant,image,tripId));
        if(!run.stopped)run.timer=setTimeout(()=>{run.inflight=loop();},1000);
      }catch{
        run.status='STOPPED_UNVERIFIED';run.error='Playback interrupted; test-state lease expires within five seconds. Restart explicitly.';run.stopped=true;
        await producerConnection.eval(unlockScript,1,lock,token).catch(()=>{});
      }
    };
    run.timer=setTimeout(()=>{run.inflight=loop();},1000);return environmentStatus(tenant,image);
  }catch(error){if(acquired)await producerConnection.eval(unlockScript,1,lock,token).catch(()=>{});throw error;}
  finally{starting.delete(image);}
}
export async function stopEnvironmentLab(tenant:string,image:string){
  const run=active.get(image);if(!run||run.tenant!==tenant)throw new Error('No lab session for this workspace and image on this worker');
  run.stopped=true;if(run.timer)clearTimeout(run.timer);await run.inflight;
  try{await run.follower.stop();run.status='CLOSED';run.error=null;}
  catch{run.status='STOPPED_UNVERIFIED';run.error='Close was not acknowledged; the Android test-state lease must expire.';}
  finally{await producerConnection.eval(unlockScript,1,run.lock,run.token).catch(()=>{});}
  return environmentStatus(tenant,image);
}
