import { createHash } from 'node:crypto';
import { readFile,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory } from '../trips/playerTargets.js';
import type { EnvironmentRole } from './environmentProtocol.js';
export function environmentCredentialPath(imageId:string,role:EnvironmentRole){
  if(!imageId||!['observer','lab'].includes(role))throw new Error('Invalid environment credential identity');
  return join(stateDirectory(),'environment-credentials',role,`${createHash('sha256').update(imageId).digest('hex')}.token`);
}
export async function readEnvironmentCredential(imageId:string,role:EnvironmentRole){
  const path=environmentCredentialPath(imageId,role);
  try{const info=await stat(path);if(!info.isFile()||(info.mode&0o077)!==0)throw new Error();const value=(await readFile(path,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(value))throw new Error();return value;}
  catch{throw new Error(`Provision the ${role} APK and its private per-image credential first`);}
}
