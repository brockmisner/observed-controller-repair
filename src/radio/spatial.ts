import { haversineMeters } from '../geo/haversine.js';
import { positionSchema,type Position } from './schema.js';
type Vec=[number,number,number];
type Entry<T>={value:T;v:Vec};
type Node<T>={entry:Entry<T>;axis:number;left?:Node<T>;right?:Node<T>};
const radius=6371000;
function vector(p:Position):Vec {const lat=p.lat*Math.PI/180,lng=p.lng*Math.PI/180;return [Math.cos(lat)*Math.cos(lng),Math.cos(lat)*Math.sin(lng),Math.sin(lat)];}
// Cartesian unit-sphere KD tree avoids longitude-wrap and polar bounding-box errors.
export class SpatialIndex<T extends Position> {
  private root?:Node<T>;
  constructor(records:readonly T[]) {
    const build=(entries:Entry<T>[],depth:number):Node<T>|undefined=>{
      if(!entries.length)return undefined;
      const axis=depth%3;entries.sort((a,b)=>a.v[axis]!-b.v[axis]!);const mid=Math.floor(entries.length/2);
      return {entry:entries[mid]!,axis,left:build(entries.slice(0,mid),depth+1),right:build(entries.slice(mid+1),depth+1)};
    };
    this.root=build(records.map(value=>({value,v:vector(positionSchema.parse({lat:value.lat,lng:value.lng}))})),0);
  }
  within(position:Position,distanceM:number):Array<{record:T;distanceM:number}> {
    positionSchema.parse(position);
    if(!Number.isFinite(distanceM)||distanceM<0||distanceM>Math.PI*radius)throw new Error('Invalid search radius');
    const v=vector(position),chord=2*Math.sin(distanceM/(2*radius)),found:Array<{record:T;distanceM:number}>=[];
    const visit=(node?:Node<T>)=>{
      if(!node)return;
      const delta=v[node.axis]!-node.entry.v[node.axis]!;
      const distance=haversineMeters(position.lat,position.lng,node.entry.value.lat,node.entry.value.lng);
      if(distance<=distanceM)found.push({record:node.entry.value,distanceM:distance});
      if(delta<=chord+1e-12)visit(node.left);
      if(delta>=-chord-1e-12)visit(node.right);
    };
    visit(this.root);return found.sort((a,b)=>a.distanceM-b.distanceM);
  }
}
