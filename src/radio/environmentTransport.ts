import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ENVIRONMENT_MAX_BYTES, EnvironmentProtocolError, parseChallenge, signPayload, verifyPayload, validateReport,
  type EnvironmentChallenge, type EnvironmentRole } from './environmentProtocol.js';

export type EnvironmentCommand = {op:'observe'|'state'} | {op:'open'|'close';sessionId:string;epoch:number} |
  {op:'stage';sessionId:string;epoch:number;sequence:number;leaseMs:number;frame:unknown};
export interface EnvironmentExchangeOptions {
  port:number;key:string;imageId:string;role:EnvironmentRole;command:EnvironmentCommand;timeoutMs?:number;
}
/** One nonce and request per connection. The phone endpoint is never exposed outside an ADB loopback tunnel. */
export async function exchangeEnvironment(options: EnvironmentExchangeOptions): Promise<unknown> {
  const timeoutMs=options.timeoutMs??4000;
  if(!Number.isInteger(options.port)||options.port<1||options.port>65535||!Number.isFinite(timeoutMs)||timeoutMs<50||timeoutMs>15000)throw new EnvironmentProtocolError('Invalid environment transport configuration');
  return new Promise((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port:options.port});
    let settled=false,buffer=Buffer.alloc(0),challenge:EnvironmentChallenge|undefined;
    const requestId=randomBytes(16).toString('hex');
    const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Environment receiver timed out')),timeoutMs);
    socket.on('error',()=>finish(new Error('Environment receiver connection failed')));
    socket.on('end',()=>finish(new Error('Environment receiver closed before a complete response')));
    socket.on('data',data=>{
      if(settled)return;
      const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);
      if(buffer.length+chunk.length>ENVIRONMENT_MAX_BYTES){finish(new EnvironmentProtocolError('Environment frame exceeds size limit'));return;}
      buffer=Buffer.concat([buffer,chunk]);
      while(!settled){
        const end=buffer.indexOf(10);if(end<0)return;
        const line=buffer.subarray(0,end).toString('utf8');buffer=buffer.subarray(end+1);
        try{
          const value:unknown=JSON.parse(line);
          if(!challenge){
            challenge=parseChallenge(value,options.imageId,options.role);
            const payload=JSON.stringify({...options.command,requestId,imageId:options.imageId,bootId:challenge.bootId,instanceId:challenge.instanceId});
            const wire=JSON.stringify({version:1,payload,mac:signPayload(options.key,challenge.nonce,'request',payload)})+'\n';
            if(Buffer.byteLength(wire)>ENVIRONMENT_MAX_BYTES)throw new EnvironmentProtocolError('Environment request exceeds size limit');
            socket.write(wire);continue;
          }
          if(!value||typeof value!=='object'||Array.isArray(value))throw new EnvironmentProtocolError('Invalid environment response');
          const response=value as Record<string,unknown>;
          if(response.version!==1||Object.keys(response).some(k=>!['version','payload','mac'].includes(k))||typeof response.payload!=='string'||!verifyPayload(options.key,challenge.nonce,'response',response.payload,response.mac))throw new EnvironmentProtocolError('Environment response signature invalid');
          const result=JSON.parse(response.payload) as Record<string,unknown>;
          if(!result||result.imageId!==options.imageId||result.bootId!==challenge.bootId||result.instanceId!==challenge.instanceId||result.requestId!==requestId)throw new EnvironmentProtocolError('Environment response identity mismatch');
          if(result.status==='ERROR')throw new EnvironmentProtocolError(`Environment receiver rejected request: ${typeof result.code==='string'&&/^[A-Z_]{1,80}$/.test(result.code)?result.code:'INVALID_REQUEST'}`);
          if(options.role==='observer')finish(undefined,validateReport(result,challenge,requestId));
          else {
            if(result.protocol!=='stakeout.environment'||result.version!==1)throw new EnvironmentProtocolError('Invalid lab response protocol');
            if(options.command.op==='open'||options.command.op==='stage'){
              if(result.sessionId!==options.command.sessionId||result.epoch!==options.command.epoch)throw new EnvironmentProtocolError('Lab session identity mismatch');
              if(options.command.op==='stage'&&result.sequence!==options.command.sequence)throw new EnvironmentProtocolError('Lab sequence mismatch');
            }
            if(result.type!=='lab.result'||result.applied!==false||!['OPENED','STAGED_TEST_STATE','STATE','CLOSED'].includes(String(result.status)))throw new EnvironmentProtocolError('Lab receiver cannot claim Android radio application');
            finish(undefined,result);
          }
        }catch(error){finish(error instanceof EnvironmentProtocolError?error:new EnvironmentProtocolError('Malformed environment message'));}
      }
    });
  });
}
export interface EnvironmentTarget {imageId:string;endpoint:string;controlPort?:number;radioAgent?:{port:number}}
export interface EnvironmentGatewayDependencies {
  resolve(imageId:string):EnvironmentTarget;
  connect(target:EnvironmentTarget):Promise<void>;
  forward(target:EnvironmentTarget,port:number):Promise<number>;
  removeForward(target:EnvironmentTarget,port:number):Promise<void>;
  credential(target:EnvironmentTarget,role:EnvironmentRole):Promise<string>;
  exchange?(options:EnvironmentExchangeOptions):Promise<unknown>;
}
export class EnvironmentGateway {
  constructor(private readonly deps:EnvironmentGatewayDependencies){}
  async request(imageId:string,role:EnvironmentRole,command:EnvironmentCommand):Promise<unknown>{
    const target=this.deps.resolve(imageId),port=role==='observer'?9997:9996;
    if(target.imageId!==imageId)throw new EnvironmentProtocolError('Environment target identity mismatch');
    if(port===target.controlPort||port===target.radioAgent?.port)throw new EnvironmentProtocolError('Environment port conflicts with an existing player or radio agent');
    // Read credentials before touching the phone. No cross-image or cross-role fallback.
    const key=await this.deps.credential(target,role);
    await this.deps.connect(target);
    const localPort=await this.deps.forward(target,port);
    try{return await (this.deps.exchange??exchangeEnvironment)({imageId,role,port:localPort,key,command});}
    finally{await this.deps.removeForward(target,localPort).catch(()=>{});}
  }
}
