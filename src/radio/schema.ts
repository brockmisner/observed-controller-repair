import { z } from 'zod';

const optionalNumber = (min:number,max:number) => z.number().finite().min(min).max(max).nullable().optional();
export const radioRecordSchema = z.object({
  kind:z.enum(['WIFI','CELL','BLUETOOTH']), identifier:z.string().min(1).max(128),
  ssid:z.string().max(128).nullable().default(null),
  lat:z.number().finite().min(-90).max(90), lng:z.number().finite().min(-180).max(180),
  qos:z.number().int().min(0).max(7).nullable().default(null),
  firstSeen:z.string().max(100).nullable().optional(), lastSeen:z.string().max(100).nullable().default(null),
  lastUpdated:z.string().max(100).nullable().default(null), source:z.string().max(300).default('User import'),
  radio:z.string().max(20).nullable().optional(), channel:z.number().int().nonnegative().nullable().optional(),
  frequencyMHz:optionalNumber(1,100000), encryption:z.string().max(256).nullable().optional(),
  attributes:z.string().max(1024).nullable().optional(), wifiType:z.string().max(20).optional(),
  bluetooth:z.object({name:z.string().max(256).nullable(),manufacturerId:z.number().int().min(0).max(65535).nullable(),
    deviceClass:z.number().int().nonnegative().nullable(), capabilities:z.array(z.string().max(100)).max(50).nullable()}).nullable().optional(),
  cell:z.object({rat:z.enum(['LTE','NR']),mcc:z.string().regex(/^\d{3}$/),mnc:z.string().regex(/^\d{2,3}$/),
    areaCode:z.number().int().min(0).max(16777215),cellId:z.number().int().min(0).max(68719476735),
    pci:z.number().int().min(0).max(1007).nullable().optional(),
    channel:z.number().int().nonnegative().nullable().optional(),
  }).strict().superRefine((c,ctx)=>{
    if(c.rat==='LTE'&&(c.cellId>268435455||c.areaCode>65535||(c.pci??0)>503))ctx.addIssue({code:'custom',message:'Invalid LTE identity range'});
  }).nullable().optional(),
  // Explicit scenario parameters, never inferred from cell identifier bits.
  propagation:z.object({referenceDbm:z.number().finite().min(-150).max(30),referenceDistanceM:z.number().finite().min(1).max(10000),
    exponent:z.number().finite().min(1).max(6),referenceFrequencyMHz:z.number().finite().min(1).max(100000),
    azimuthDeg:optionalNumber(0,360),beamwidthDeg:optionalNumber(1,360),maxAttenuationDb:optionalNumber(0,60),
  }).strict().nullable().optional(),
}).strip();
export type RadioRecord = z.infer<typeof radioRecordSchema>;
export const positionSchema=z.object({lat:z.number().finite().min(-90).max(90),lng:z.number().finite().min(-180).max(180)}).strict();
export type Position=z.infer<typeof positionSchema>;
export function recordKey(r:RadioRecord) {
  return r.kind==='CELL'&&r.cell ? `CELL:${r.cell.rat}:${r.cell.mcc}:${r.cell.mnc}:${r.cell.areaCode}:${r.cell.cellId}` : `${r.kind}:${r.identifier.toLowerCase()}`;
}
