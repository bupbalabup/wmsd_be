const EPS=1e-7;
export function corners(rect) {
  const radians=(rect.rotation||0)*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  return [[0,0],[rect.width,0],[rect.width,rect.length],[0,rect.length]].map(([x,y])=>({x:rect.x+x*c-y*s,y:rect.y+x*s+y*c}));
}
export function pointInside(polygon,p) {
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[j],b=polygon[i],cross=(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
    if(Math.abs(cross)<EPS&&p.x>=Math.min(a.x,b.x)-EPS&&p.x<=Math.max(a.x,b.x)+EPS&&p.y>=Math.min(a.y,b.y)-EPS&&p.y<=Math.max(a.y,b.y)+EPS)return true;
    if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}
export function containsPolygon(container,shape) {
  if(!container.length||!shape.every(p=>pointInside(container,p)))return false;
  return shape.every((a,index)=>{
    const b=shape[(index+1)%shape.length],dx=b.x-a.x,dy=b.y-a.y,denom=dx*dx+dy*dy;
    if(denom<EPS)return false;
    const cuts=[0,1];
    container.forEach((c,j)=>{
      const d=container[(j+1)%container.length],ex=d.x-c.x,ey=d.y-c.y,det=dx*ey-dy*ex;
      if(Math.abs(det)>EPS){const t=((c.x-a.x)*ey-(c.y-a.y)*ex)/det,u=((c.x-a.x)*dy-(c.y-a.y)*dx)/det;if(t>0&&t<1&&u>=-EPS&&u<=1+EPS)cuts.push(t);}
      else if(Math.abs((c.x-a.x)*dy-(c.y-a.y)*dx)<EPS)for(const p of [c,d]){const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/denom;if(t>0&&t<1)cuts.push(t);}
    });
    cuts.sort((x,y)=>x-y);
    return cuts.slice(1).every((t,j)=>pointInside(container,{x:a.x+dx*(t+cuts[j])/2,y:a.y+dy*(t+cuts[j])/2}));
  });
}
export function rectanglesOverlap(a,b) {
  const left=corners(a),right=corners(b);
  for(const polygon of [left,right])for(let i=0;i<4;i++){
    const p=polygon[i],q=polygon[(i+1)%4],axis={x:-(q.y-p.y),y:q.x-p.x};
    const l=left.map(v=>v.x*axis.x+v.y*axis.y),r=right.map(v=>v.x*axis.x+v.y*axis.y);
    if(Math.min(Math.max(...l),Math.max(...r))-Math.max(Math.min(...l),Math.min(...r))<=EPS)return false;
  }
  return true;
}
export function slotCorners(zone,slot) {
  const radians=(zone.rotation||0)*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  return corners({...slot,rotation:0}).map(p=>({x:zone.x+p.x*c-p.y*s,y:zone.y+p.x*s+p.y*c}));
}
export function containmentIssues(layout) {
  const issues=[];
  const stagingIds=new Set((layout.functions||[]).filter(({name})=>['khu tập kết','tập kết'].includes(name.trim().normalize('NFC').toLocaleLowerCase('vi'))).map(({id})=>id));
  for(const zone of layout.zones||[]){
    if(!stagingIds.has(zone.functionId)&&!containsPolygon(layout.points,corners(zone)))issues.push(`Khu vực ${zone.name} nằm ngoài kho.`);
    for(const slot of zone.slots||[])if(slot.x<0||slot.y<0||slot.x+slot.width>zone.width+EPS||slot.y+slot.length>zone.length+EPS)issues.push(`Ô ${slot.name} nằm ngoài khu vực ${zone.name}.`);
  }
  return issues;
}
export function arrangementSize(plan) {
  return {width:plan.columns*plan.palletWidth+(plan.columns-1)*plan.gap+2*plan.margin,length:plan.rows*plan.palletLength+(plan.rows-1)*plan.gap+2*plan.margin};
}
export function applicationIssues(layout) {
  return [...containmentIssues(layout),...(layout.zones||[]).filter(zone=>!zone.functionId).map(zone=>`Khu vực ${zone.name} chưa được gán chức năng.`)];
}
export function palletHeight(pallet) {
  if(pallet.measuredCargoHeight!==undefined)return pallet.baseHeight+pallet.measuredCargoHeight;
  if(pallet.actualHeight!==undefined)return pallet.actualHeight;
  return pallet.baseHeight+(pallet.layers?.length?pallet.layers.reduce((sum,layer)=>sum+layer.height,0):pallet.stackHeight);
}
export function palletCorners(zone,slot,pallet) {
  return slotCorners(zone,{...pallet,x:slot.x+pallet.x,y:slot.y+pallet.y});
}
export function heightWarnings(layout) {
  const warnings=[];
  for(const zone of layout.zones||[])for(const slot of zone.slots||[])for(const pallet of slot.pallets||[]){
    const height=palletHeight(pallet),limit=zone.maxHeight??layout.maxStackHeight??layout.height;
    if(height>limit+EPS)warnings.push(`Pallet ${pallet.code} · ${zone.name} / ${slot.name}: cao ${height.toFixed(3)} m, giới hạn ${limit.toFixed(3)} m, vượt ${(height-limit).toFixed(3)} m.`);
  }
  return warnings;
}
export function palletIssues(layout) {
  const issues=[],ids=new Set(),codes=new Set();
  for(const zone of layout.zones||[])for(const slot of zone.slots||[])for(const pallet of slot.pallets||[]){
    const fail=message=>issues.push(`Pallet ${pallet.code}: ${message}`);
    if(!pallet.id||!pallet.code.trim()||ids.has(pallet.id)||codes.has(pallet.code.trim().toLocaleLowerCase('vi')))fail('mã bị trùng hoặc để trống.');
    ids.add(pallet.id);codes.add(pallet.code.trim().toLocaleLowerCase('vi'));
    if(![pallet.x,pallet.y,pallet.width,pallet.length,pallet.baseHeight,pallet.stackHeight].every(Number.isFinite)||pallet.width<0.01||pallet.length<0.01||pallet.baseHeight<0.01||pallet.stackHeight<0)fail('kích thước chưa hợp lệ.');
    if(pallet.x<0||pallet.y<0||pallet.x+pallet.width>slot.width+EPS||pallet.y+pallet.length>slot.length+EPS)fail(`nằm ngoài ô ${slot.name}.`);
    if(pallet.measuredCargoHeight!==undefined&&(!Number.isFinite(pallet.measuredCargoHeight)||pallet.measuredCargoHeight<0))fail('chiều cao hàng đo chưa hợp lệ.');
    if(!Number.isFinite(palletHeight(pallet))||palletHeight(pallet)<0||palletHeight(pallet)>100)fail('tổng chiều cao phải từ 0 đến 100 m.');
    const layers=pallet.layers||[];
    if(layers.length>100||new Set(layers.map(layer=>layer.id)).size!==layers.length)fail('lớp hàng bị trùng mã hoặc vượt 100 lớp.');
    for(const layer of layers){
      if(!Number.isFinite(layer.height)||layer.height<0.01||layer.height>100||!layer.items.length||layer.items.length>100)fail('lớp hàng cần chiều cao dương và từ 1 đến 100 dòng hàng.');
      if(new Set(layer.items.map(item=>item.id)).size!==layer.items.length)fail('dòng hàng bị trùng mã trong lớp.');
      if(layer.items.some(item=>!item.productCode.trim()||!item.lotCode.trim()||!Number.isSafeInteger(item.cartons)||item.cartons<1))fail('điền mã sản phẩm, lô và số thùng nguyên dương cho từng dòng.');
    }
  }
  return issues;
}
