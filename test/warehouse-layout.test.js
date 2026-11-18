import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSchema } from '../src/modules/warehouse-stock/layout.js';
import { heightWarnings, applicationIssues, palletHeight } from '../src/modules/warehouse-stock/layout-geometry.js';
const rectangle={points:[{x:0,y:0},{x:10,y:0},{x:10,y:8},{x:0,y:8}],height:4,doors:[]};
test('accepts rectangular and concave warehouse floors',()=>{
  assert.equal(layoutSchema.safeParse(rectangle).success,true);
  assert.equal(layoutSchema.safeParse({...rectangle,points:[{x:0,y:0},{x:10,y:0},{x:10,y:4},{x:4,y:4},{x:4,y:8},{x:0,y:8}]}).success,true);
});
test('rejects self crossing and zero area floors',()=>{
  assert.equal(layoutSchema.safeParse({...rectangle,points:[{x:0,y:0},{x:10,y:8},{x:10,y:0},{x:0,y:8}]}).success,false);
  assert.equal(layoutSchema.safeParse({...rectangle,points:[{x:0,y:0},{x:1,y:0},{x:2,y:0}]}).success,false);
});
test('doors must fit walls and cannot overlap',()=>{
  const door={edge:0,offset:1.25,width:3,height:3.5};
  assert.equal(layoutSchema.safeParse({...rectangle,doors:[door]}).success,true);
  for(const doors of [[{...door,width:9}],[{...door,height:5}],[door,{...door,offset:3}],[{...door,edge:9}]]) assert.equal(layoutSchema.safeParse({...rectangle,doors}).success,false);
});
const layeredPallet={id:'p',code:'P1',x:0.1,y:0.1,width:1,length:1.2,baseHeight:0.15,stackHeight:0,
  layers:[{id:'layer',height:0.8,items:[{id:'a',productCode:'G1',lotCode:'L1',cartons:2},{id:'b',productCode:'G2',lotCode:'L2',cartons:3}]}]};
const withPallet=pallet=>({...rectangle,functions:[{id:'f',name:'Storage'}],zones:[{id:'z',name:'Zone',x:1,y:1,width:4,length:4,rotation:0,color:'#ffffff',functionId:'f',maxHeight:0.5,
  slots:[{id:'s',name:'Slot',x:1,y:1,width:2,length:2,pallets:[pallet]}]}]});
test('accepts an optional location id on a design slot and rejects invalid ids',()=>{
  const layout=withPallet(layeredPallet), slot=layout.zones[0].slots[0];
  assert.equal(layoutSchema.parse(layout).zones[0].slots[0].locationId,undefined);
  slot.locationId='A'.repeat(24);
  assert.equal(layoutSchema.parse(layout).zones[0].slots[0].locationId,'a'.repeat(24));
  slot.locationId='A-01';
  assert.equal(layoutSchema.safeParse(layout).success,false);
});
test('allows only staging zones outside the warehouse and keeps their slots inside the zone',()=>{
  const layout=withPallet(layeredPallet);
  layout.functions.push({id:'staging',name:'Khu tập kết'});
  const [zone]=layout.zones;
  zone.x=-5;
  zone.name='Khu tập kết';
  assert.match(applicationIssues(layoutSchema.parse(layout))[0],/nằm ngoài kho/);
  zone.functionId='staging';
  assert.deepEqual(applicationIssues(layoutSchema.parse(layout)),[]);
  zone.slots[0].x=3;
  assert.match(applicationIssues(layoutSchema.parse(layout))[0],/nằm ngoài khu vực/);
});
test('persists mixed-layer design snapshots and treats excess height as a nonblocking warning',()=>{
  const parsed=layoutSchema.parse(withPallet(layeredPallet));
  assert.equal(parsed.zones[0].slots[0].pallets[0].layers[0].items.length,2);
  assert.equal(applicationIssues(parsed).length,0);
  assert.equal(heightWarnings(parsed).length,1);
  assert.ok(Math.abs(palletHeight(layeredPallet)-0.95)<1e-8);
  assert.ok(Math.abs(palletHeight({...layeredPallet,measuredCargoHeight:0.3})-0.45)<1e-8);
});
test('rejects malformed layers, fractional cartons, duplicate layer IDs and pallet overflow',()=>{
  for(const pallet of [
    {...layeredPallet,x:2},
    {...layeredPallet,measuredCargoHeight:-1},
    {...layeredPallet,layers:[...layeredPallet.layers,...layeredPallet.layers]},
    {...layeredPallet,layers:[{...layeredPallet.layers[0],height:0}]},
    {...layeredPallet,layers:[{...layeredPallet.layers[0],items:[{id:'a',productCode:'G1',lotCode:'',cartons:1.5}]}]},
  ])assert.equal(layoutSchema.safeParse(withPallet(pallet)).success,false);
});
test('legacy pallet total heights remain unchanged',()=>{
  const {layers,...legacy}=layeredPallet;
  assert.equal(layoutSchema.safeParse(withPallet({...legacy,actualHeight:0.9})).success,true);
  assert.equal(palletHeight({...legacy,actualHeight:0.9}),0.9);
});
