import 'dotenv/config';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,chmod} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {requirePlayerTarget} from '../src/trips/playerTargets.js';
import {ensureAdbClientIdentity} from '../src/trips/adbIdentity.js';
import {environmentCredentialPath} from '../src/radio/environmentCredentials.js';
import type {EnvironmentRole} from '../src/radio/environmentProtocol.js';

const exec=promisify(execFile);
function options(){const out:Record<string,string>={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!key||!['--image','--role','--apk'].includes(key)||!value||out[key])throw Error('Usage: npm run environment:provision -- --image IMAGE_ID --role observer|lab --apk /path/to/flavor-debug.apk');out[key]=value;}if(!out['--image']||!['observer','lab'].includes(out['--role']??'')||!out['--apk'])throw Error('All three options are required');return out;}
async function privateWrite(endpoint:string,pkg:string,filename:'control-token'|'environment-config.json',data:string){
  await new Promise<void>((resolve,reject)=>{
    const child=spawn('adb',['-s',endpoint,'shell','run-as',pkg,'sh','-c',`'umask 077; mkdir -p files; cat > files/${filename}'`],{stdio:['pipe','ignore','ignore']});
    const timer=setTimeout(()=>{child.kill();reject(Error('Private provisioning write timed out'));},12000);
    child.on('error',()=>{clearTimeout(timer);reject(Error('Private provisioning write failed'));});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Private provisioning write failed; a matching debug APK is required'));});child.stdin.on('error',()=>{});child.stdin.end(data);
  });
}
async function main(){
  const args=options(),image=args['--image']!,role=args['--role']! as EnvironmentRole,apk=resolve(args['--apk']!);
  const target=requirePlayerTarget(image),pkg='net.stakeout.environment.'+role,tokenPath=environmentCredentialPath(image,role);
  if(!(await stat(apk)).isFile()||!apk.endsWith('.apk'))throw Error('APK file not found');
  await ensureAdbClientIdentity();
  const adb=async(argv:string[])=>{try{return(await exec('adb',argv,{timeout:60000,maxBuffer:65536})).stdout.trim();}catch{throw Error('ADB command failed for the selected phone; check authorization and APK flavor');}};
  // Do not touch other packages, GPS players, radio modules, or global ADB defaults.
  await adb(['connect',target.endpoint]);
  if(await adb(['-s',target.endpoint,'get-state'])!=='device')throw Error('Selected phone is not authorized');
  await adb(['-s',target.endpoint,'install','-r',apk]);
  await adb(['-s',target.endpoint,'shell','am','force-stop',pkg]);
  let token:string;
  try{token=(await readFile(tokenPath,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('INVALID_EXISTING_TOKEN');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');await mkdir(dirname(tokenPath),{recursive:true,mode:0o700});await writeFile(tokenPath,token+'\n',{mode:0o600,flag:'wx'});}
  await chmod(tokenPath,0o600);
  await privateWrite(target.endpoint,pkg,'control-token',token+'\n');
  await privateWrite(target.endpoint,pkg,'environment-config.json',JSON.stringify({imageId:image}));
  await adb(['-s',target.endpoint,'shell','am','start','-n',pkg+'/net.stakeout.environment.MainActivity']);
  console.log(`Provisioned ${role} on image ${image}. On that phone, grant permissions and tap Start receiver. Credentials remain private. No other apps or radio settings were changed.`);
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error instanceof Error?error.message:'Provisioning failed');process.exit(1);});
