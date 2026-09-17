import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioEngine,modeledPower } from '../src/radio/engine.js';
import { radioRecordSchema,recordKey } from '../src/radio/schema.js';
import { SpatialIndex } from '../src/radio/spatial.js';
import { RadioSessions } from '../src/radio/sessions.js';
import { ArrivalGate,hashFrame } from '../src/radio/arrival.js';
const session='11111111-1111-4111-8111-111111111111';
const options={tenantId:'tenant',imageId:'phone-a',sessionId:session,datasetRevision:'city:1',mcc:'310',mnc:'260'};
const position={lat:25,lng:-80};
const wifi=radioRecordSchema.parse({...position,kind:'WIFI',identifier:'00:11:22:33:44:55',ssid:'AP',frequencyMHz:2412});
const cell=radioRecordSchema.parse({...position,kind:'CELL',identifier:'tower',frequencyMHz:1800,
  cell:{rat:'LTE',mcc:'310',mnc:'260',areaCode:42,cellId:12345,pci:2},
  propagation:{referenceDbm:-65,referenceDistanceM:100,exponent:3,referenceFrequencyMHz:1800,azimuthDeg:0,beamwidthDeg:120}});
const bt=radioRecordSchema.parse({...position,kind:'BLUETOOTH',identifier:'10:11:22:33:44:55'});
const records=[wifi,cell,bt];
test('radio metadata survives parsing without inventing cellular fields',()=>{
  assert.equal(radioRecordSchema.parse(cell).cell?.mnc,'260');
  assert.equal(radioRecordSchema.parse(wifi).frequencyMHz,2412);
  assert.equal(radioRecordSchema.parse({...position,kind:'CELL',identifier:'opaque'}).cell,undefined);
  assert.throws(()=>radioRecordSchema.parse({...cell,cell:{...cell.cell,cellId:2**28}}));
});
test('spatial lookup handles the date line and poles',()=>{
  const index=new SpatialIndex([{lat:0,lng:179.999},{lat:89.999,lng:90},{lat:0,lng:0}]);
  assert.equal(index.within({lat:0,lng:-179.999},300).length,1);
  assert.equal(index.within({lat:89.999,lng:-90},300).length,1);
});
test('frequency and known sector direction affect modeled power',()=>{
  assert.ok(Math.abs((modeledPower(wifi,position,10,2400,0)-modeledPower(wifi,position,10,5000,0))-6.375)<0.01);
  assert.ok(modeledPower(cell,{lat:25.001,lng:-80},100,1800,0)>modeledPower(cell,{lat:24.999,lng:-80},100,1800,0));
});
test('identical inputs replay deterministically while callers cannot mutate session state',()=>{
  const a=new RadioEngine(records,options),b=new RadioEngine(records,options);
  const frame=a.frame(position,0,0);
  assert.deepEqual(frame,b.frame(position,0,0));
  frame.wifi[0]!.ssid='tampered';
  assert.equal(a.frame(position,0,0).wifi[0]!.ssid,'AP');
  assert.throws(()=>a.frame({lat:26,lng:-80},0,0));
});
test('each phone derives its own networks from its own position',()=>{
  const a=new RadioEngine(records,options),b=new RadioEngine(records,{...options,imageId:'phone-b'});
  assert.equal(a.frame(position,0,0).wifi.length,1);
  assert.equal(b.frame({lat:26,lng:-80},0,0).wifi.length,0);
  assert.equal(a.frame(position,1000,1).wifi.length,1);
});
test('different phones have different stable signal variation, without renaming real networks',()=>{
  const a=new RadioEngine(records,options),b=new RadioEngine(records,{...options,imageId:'phone-b'});
  const aa=[],bb=[];
  for(let i=0;i<6;i++){aa.push(a.frame(position,i*30000,i).wifi[0]!.rssiDbm);bb.push(b.frame(position,i*30000,i).wifi[0]!.rssiDbm);}
  assert.notDeepEqual(aa,bb);
});
test('Wi-Fi cache timestamps advance only at the configured scan interval',()=>{
  const e=new RadioEngine(records,options);
  const a=e.frame(position,0,0),b=e.frame({lat:25.00001,lng:-80},1000,1),c=e.frame(position,30000,2);
  assert.deepEqual(a.wifi,b.wifi);assert.equal(c.wifi[0]!.sampleElapsedMs,30000);
});
test('Bluetooth is untouched in motion and replaced only on arrival',()=>{
  const e=new RadioEngine(records,options);
  assert.equal(e.frame(position,0,0).bluetooth,null);
  const arrival=e.frame(position,1000,1,'ARRIVED');assert.equal(arrival.bluetoothAction,'REPLACE');assert.equal(arrival.bluetooth?.length,1);
  assert.equal(e.frame(position,2000,2).bluetoothAction,'HOLD');
});
test('foreign carrier and incomplete cell records cannot become serving cells',()=>{
  const foreign={...cell,identifier:'foreign',cell:{...cell.cell!,mnc:'410'}};
  const e=new RadioEngine([foreign,{...cell,cell:null}],options),frame=e.frame(position,0,0);
  assert.equal(frame.cells.length,0);assert.ok(frame.warnings.includes('NO_ELIGIBLE_CELL'));
});
test('missing frequency is explicit, never silently assigned 2.4 GHz',()=>{
  const f=new RadioEngine([{...wifi,frequencyMHz:null}],options).frame(position,0,0);
  assert.equal(f.wifi.length,0);assert.ok(f.warnings.some(w=>w.startsWith('WIFI_METADATA_MISSING')));
});
test('LTE unknown quality and timing advance remain unavailable',()=>{
  const c=new RadioEngine(records,options).frame(position,0,0).cells[0]!;
  assert.equal(c.rsrqDb,null);assert.equal(c.sinrDb,null);assert.equal(c.timingAdvance,null);
});
test('radio sessions reject cross-device/cross-tenant access and duplicate physical ownership',()=>{
  const sessions=new RadioSessions();sessions.open(records,options,0);
  assert.throws(()=>sessions.open(records,{...options,tenantId:'other'},0));
  assert.throws(()=>sessions.frame('other','phone-a',session,position,0,0,'MOVING',1));
  sessions.open(records,{...options,imageId:'phone-b'},0);
  sessions.close('tenant','phone-a',session);
  assert.equal(sessions.frame('tenant','phone-b',session,position,0,0,'MOVING',1).imageId,'phone-b');
  assert.throws(()=>sessions.frame('tenant','phone-b',session,position,1000,1,'MOVING',60001));
});
function gateReady() {
  const gate=new ArrivalGate('phone-a',session,position);
  for(let t=0;t<=30000;t+=1000)gate.observeFix({...position,bootId:'boot',elapsedMs:t,accuracyM:5,speedMps:0},t);
  assert.equal(gate.state,'READY_TO_APPLY');return gate;
}
function reportFor(frame:ReturnType<RadioEngine['frame']>) {return {imageId:'phone-a',sessionId:session,bootId:'boot',frameHash:hashFrame(frame),observedElapsedMs:30000,scope:'ANDROID_API_READBACK',
  wifi:frame.wifi.map(w=>({...w,timestampUs:30000000})).map(({sampleElapsedMs,...w})=>w),
  cells:frame.cells.map(c=>({identifier:c.identifier,registered:c.registered,rsrpDbm:c.rsrpDbm})),
  bluetooth:frame.bluetooth?.map(b=>({address:b.address,rssiDbm:b.rssiDbm}))??null};}
test('arrival gate requires continuous fresh stationary fixes',()=>{
  const g=new ArrivalGate('phone-a',session,position);
  g.observeFix({...position,bootId:'boot',elapsedMs:0,accuracyM:5,speedMps:0},0);
  g.observeFix({...position,bootId:'boot',elapsedMs:30000,accuracyM:5,speedMps:0},30000);
  assert.equal(g.state,'MOVING');
  assert.throws(()=>g.prepare(new RadioEngine(records,options).frame(position,0,0,'ARRIVED'),30000));
});
test('only fresh matching Android readback verifies an arrival frame',()=>{
  const g=gateReady(),f=new RadioEngine(records,options).frame(position,0,0,'ARRIVED');g.prepare(f,30000);
  assert.equal(g.verify(reportFor(f),30000),'VERIFIED');
});
test('provider acceptance, wrong phone, stale clocks and radio mismatch never pass',()=>{
  const f=new RadioEngine(records,options).frame(position,0,0,'ARRIVED');
  const g=gateReady();g.prepare(f,30000);assert.throws(()=>g.verify({ok:true},30000));
  for(const change of [{imageId:'phone-b'},{bootId:'different'},{observedElapsedMs:0},{wifi:null},{cells:[{identifier:'wrong',registered:true,rsrpDbm:-65}]}]) {
    const gate=gateReady();gate.prepare(f,30000);assert.equal(gate.verify({...reportFor(f),...change},30000),'BLOCKED');
  }
});
test('new boot and departure invalidate pending verification',()=>{
  const f=new RadioEngine(records,options).frame(position,0,0,'ARRIVED');
  for(const update of [{bootId:'new'},{lat:26}]) {
    const g=gateReady();g.prepare(f,30000);assert.equal(g.observeFix({...position,bootId:'boot',elapsedMs:31000,accuracyM:5,speedMps:0,...update},31000),'BLOCKED');
  }
});
test('cell identities distinguish carriers and technologies',()=>{
  assert.notEqual(recordKey(cell),recordKey({...cell,cell:{...cell.cell!,mnc:'410'}}));
});
test('A3 handover waits for continuous superiority and resets after missing movement samples',()=>{
  const a={...cell,propagation:{...cell.propagation!,azimuthDeg:null,beamwidthDeg:null}};
  const b={...a,lat:25.01,identifier:'tower-b',cell:{...a.cell!,cellId:54321}};
  const e=new RadioEngine([a,b],options),nearB={lat:25.01,lng:-80};
  const serving=(t:number,s:number,p=nearB)=>e.frame(p,t,s).cells.find(c=>c.registered)?.identifier;
  assert.equal(serving(0,0,position),recordKey(a));
  assert.equal(serving(1000,1),recordKey(a));
  assert.equal(serving(4000,2),recordKey(a));
  assert.equal(serving(5000,3),recordKey(b));
  const afterGap=new RadioEngine([a,b],options);
  afterGap.frame(position,0,0);afterGap.frame(nearB,1000,1);
  assert.equal(afterGap.frame(nearB,10000,2).cells.find(c=>c.registered)?.identifier,recordKey(a));
});
test('A5 requires both configured thresholds',()=>{
  const a={...cell,propagation:{...cell.propagation!,azimuthDeg:null,beamwidthDeg:null}};
  const b={...a,lat:25.01,identifier:'tower-b',cell:{...a.cell!,cellId:54321}};
  const e=new RadioEngine([a,b],{...options,handoverEvent:'A5',a5ServingDbm:-130,a5NeighborDbm:-100,timeToTriggerMs:0});
  e.frame(position,0,0);
  assert.equal(e.frame({lat:25.01,lng:-80},1000,1).cells.find(c=>c.registered)?.identifier,recordKey(a));
});
