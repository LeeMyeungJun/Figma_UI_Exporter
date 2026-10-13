const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const path = require('node:path');
const dir = path.resolve(__dirname, '..');
const messages = [], registry = new Map(), events = {}, calls = [];
function crc32(data) { let c=0xffffffff; for (const b of data) { c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1; }return (c^0xffffffff)>>>0; }
function png(width,height) {
  const chunk=(name,data)=>{const t=Buffer.from(name),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
  const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
function node(id,name,type,x,y,w,h,extra={}) {
  const meta={};const n={id,name,type,x,y,width:w,height:h,visible:true,opacity:1,blendMode:'NORMAL',fills:[],strokes:[],effects:[],exportSettings:[],absoluteBoundingBox:{x,y,width:w,height:h},absoluteRenderBounds:{x,y,width:w,height:h},absoluteTransform:[[1,0,x],[0,1,y]],relativeTransform:[[1,0,x],[0,1,y]],
    getPluginData:k=>meta[k]||'',setPluginData:(k,v)=>{meta[k]=v;},getMainComponentAsync:async()=>({key:'component-button'}),
    exportAsync:async settings=>{calls.push({id,settings});if(settings.format==='SVG')return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"></svg>');return png(w*settings.constraint.value,h*settings.constraint.value);},...extra};registry.set(id,n);if(n.children)n.children.forEach(c=>c.parent=n);return n;
}
const solid={type:'SOLID',color:{r:.2,g:.3,b:.4}};
const icon=node('2:1','아이콘','VECTOR',110,220,24,24);
const image1=node('2:2','시작 버튼','RECTANGLE',150,220,100,40,{fills:[{type:'IMAGE',imageHash:'same-image'}]});
const image2=node('2:3','설정 버튼','RECTANGLE',260,220,80,80,{fills:[{type:'IMAGE',imageHash:'same-image'}]});
const text=node('2:4','타이틀','TEXT',120,320,200,40,{characters:'설정 "test"\n줄바꿈',textAlignHorizontal:'LEFT',textAlignVertical:'TOP',textAutoResize:'NONE',getStyledTextSegments:()=>[{characters:'설정 "test"\n줄바꿈',start:0,end:13,fontSize:24,fontName:{family:'Noto Sans KR',style:'Bold'},fills:[solid]}]});
const inner=node('3:1','내부 아이콘','VECTOR',350,230,12,12);
const composite=node('2:5','마스크 그룹','FRAME',350,220,100,100,{children:[inner],clipsContent:true});
const hidden=node('2:6','숨김','FRAME',0,0,20,20,{visible:false,children:[node('3:2','숨김 자식','VECTOR',0,0,10,10)]});
const inst1=node('2:7','버튼 1','INSTANCE',120,400,100,40,{children:[]});
const inst2=node('2:8','버튼 2','INSTANCE',240,400,100,40,{children:[]});
const root=node('1:1','Godot2','FRAME',100,200,640,480,{children:[icon,image1,image2,text,composite,hidden,inst1,inst2],fills:[solid],clipsContent:true});
const figma={showUI:()=>{},currentPage:{selection:[root]},ui:{postMessage:m=>messages.push(m)},getNodeByIdAsync:async id=>registry.get(id)||null,on:(name,fn)=>{events[name]=fn;},viewport:{scrollAndZoomIntoView:()=>{}}};
const context=vm.createContext({figma,__html__:'',TextEncoder,Uint8Array,console});
vm.runInContext(fs.readFileSync(path.join(dir,'main.js'),'utf8')+'\nthis.api={inspect,validateConfig,scan};',context);
const ui=fs.readFileSync(path.join(dir,'ui.html'),'utf8');
const coreCtx=vm.createContext({TextEncoder,Blob,Uint8Array,DataView,window:{}});
vm.runInContext([...ui.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1],coreCtx);
const core=coreCtx.window.ExportCore;
const cfg=rows=>rows.map(r=>({id:r.id,name:r.name,mode:r.mode,scope:r.scope}));
async function run(){
  await figma.ui.onmessage({type:'ready'});
  const scan=messages.find(m=>m.type==='scan');assert(scan);assert.equal(scan.rows.length,11);
  await figma.ui.onmessage({type:'focus',id:image1.id});assert.equal(figma.currentPage.selection[0].id,image1.id);events.selectionchange();assert.equal(messages.filter(m=>m.type==='scan').length,1);
  assert.equal(scan.rows[0].name,'godot2');
  assert.equal(scan.rows[0].mode,'png');
  assert.equal(scan.rows.find(r=>r.id==='2:5').mode,'png');
  assert.equal(scan.rows.find(r=>r.id==='2:7').shared_candidate,true);
  assert.equal(scan.rows.find(r=>r.id==='2:2').reused_image,true);
  const configs=cfg(scan.rows);configs[0].mode='native';configs.forEach((r,i)=>r.name='node_'+i);configs.find(r=>r.id==='2:2').name='button_start';configs.find(r=>r.id==='2:2').scope='shared';
  await figma.ui.onmessage({type:'save',root_id:root.id,configs,rename_layers:true});
  assert.equal(image1.name,'button_start');assert.equal(JSON.parse(image1.getPluginData('godot_ui_exporter_v1')).scope,'shared');
  const second=await context.api.inspect(root);assert.equal(second.find(r=>r.id===image1.id).name,'button_start');
  const numeric=cfg(second);numeric[0].name='7';assert.doesNotThrow(()=>context.api.validateConfig(second,numeric));
  await figma.ui.onmessage({type:'export',root_id:root.id,configs,scale:2});
  const done=messages.find(m=>m.type==='export-complete');assert(done,JSON.stringify(messages.filter(m=>m.type==='error')));
  const m=done.manifest;assert.equal(m.assets.length,4);assert.equal(calls.length,4);
  assert(!calls.some(c=>['3:1','3:2'].includes(c.id)));
  assert(calls.every(c=>c.settings.useAbsoluteBounds===true&&c.settings.constraint.value===2));
  const a=m.assets.find(a=>a.node_id===image1.id);assert.equal(a.pixel_size.width,200);assert.equal(a.logical_size.width,100);
  const r=m.nodes.find(r=>r.id===image1.id);assert.equal(r.rect.x,50);assert.equal(r.rect.y,20);
  const scene=core.scene(m);assert(scene.content.includes('offset_right = 150'));assert(scene.content.includes('res://figma_ui/screen_n_1_1/assets/shared/button_start.png'));assert(scene.content.includes('expand_mode = 1'));
  assert(scene.content.includes('설정 \\"test\\"\\n줄바꿈'));
  const files=messages.filter(x=>x.type==='export-file').map(x=>({path:'figma_ui/'+m.bundle_name+'/'+x.path,data:x.bytes}));
  files.push({path:'figma_ui/'+m.bundle_name+'/manifest.json',data:JSON.stringify(m,null,2)},{path:'figma_ui/'+m.bundle_name+'/generated.tscn',data:scene.content},{path:'figma_ui/'+m.bundle_name+'/resources.csv',data:core.csv(m)});
  const zip=core.zip(files);fs.mkdirSync(path.join(dir,'tests/output'),{recursive:true});fs.writeFileSync(path.join(dir,'tests/output/test-export.zip'),Buffer.from(await zip.arrayBuffer()));
  fs.writeFileSync(path.join(dir,'tests/output/scan.json'),JSON.stringify(scan,null,2));
  fs.writeFileSync(path.join(dir,'tests/output/messages.json'),JSON.stringify(messages));
  // Group/native labels are not resource paths and may be repeated.
  const repeatedLabelRows=await context.api.inspect(root);const repeatedLabel=cfg(repeatedLabelRows);repeatedLabel[1].name=repeatedLabel[0].name;
  const labels=context.api.validateConfig(repeatedLabelRows,repeatedLabel);assert.equal(labels[1].duplicate_of,null);assert.equal(labels[1].suppressed,false);
  // Identically named exported nodes are both retained with distinct paths.
  const duplicateRows=await context.api.inspect(root);const duplicate=cfg(duplicateRows);duplicate[2].name=duplicate[1].name;duplicate[2].scope=duplicate[1].scope;
  const deduped=context.api.validateConfig(duplicateRows,duplicate);assert.equal(deduped[2].duplicate_of,null);assert.equal(deduped[2].suppressed,false);assert.notEqual(deduped[2].asset_name,deduped[1].asset_name);
  const extensionRows=await context.api.inspect(root);const differentExtension=cfg(extensionRows);differentExtension[2].name=differentExtension[1].name;differentExtension[2].scope=differentExtension[1].scope;differentExtension[2].mode='svg';
  const extensions=context.api.validateConfig(extensionRows,differentExtension);assert.equal(extensions[2].duplicate_of,null);assert.equal(extensions[2].suppressed,false);
  const invalid=cfg(second);invalid[1].name='../bad';await figma.ui.onmessage({type:'save',root_id:root.id,configs:invalid,rename_layers:false});
  const invalidMessage=messages.at(-1);assert(invalidMessage.message.includes('리소스 이름'));assert(invalidMessage.message.includes('../bad'));assert(invalidMessage.message.includes(second[1].original_name));assert.equal(invalidMessage.node_id,second[1].id);
  await figma.ui.onmessage({type:'export',root_id:'stale',configs:cfg(second),scale:2});assert(messages.at(-1).message.includes('선택이 바뀌'));
  // Parent export suppresses descendants; skip suppresses subtree; hidden always excluded.
  const pruned=cfg(second);pruned[0].mode='png';pruned[1].name='../not_exported';const p=context.api.validateConfig(second,pruned);assert.equal(p.filter(r=>!r.suppressed&&r.mode!=='skip').length,1);
  const old=image1.exportAsync;image1.exportAsync=async s=>{await figma.ui.onmessage({type:'cancel'});return old(s);};
  const completed=messages.filter(x=>x.type==='export-complete').length;
  await figma.ui.onmessage({type:'export',root_id:root.id,configs,scale:2});assert(messages.at(-1).message.includes('취소'));assert.equal(messages.filter(x=>x.type==='export-complete').length,completed);
  figma.currentPage.selection=[image2];await context.api.scan(false);assert.equal(messages.at(-1).root.id,image2.id);
  // Selected parents of every container type export once, including nested children.
  for (const type of ['GROUP','FRAME','COMPONENT','INSTANCE']) {
    const leaf=node('fixture:'+type+':leaf','leaf','VECTOR',0,0,8,8);
    const nested=node('fixture:'+type+':nested','nested','GROUP',0,0,8,8,{children:[leaf]});
    const parent=node('fixture:'+type,'parent_'+type.toLowerCase(),type,0,0,16,16,{children:[nested]});
    figma.currentPage.selection=[parent];await context.api.scan(false);
    const rows=messages.at(-1).rows;assert.equal(rows[0].mode,'png');
    const beforeCalls=calls.length;
    await figma.ui.onmessage({type:'export',root_id:parent.id,configs:cfg(rows),scale:1});
    assert.equal(messages.at(-1).type,'export-complete');assert.equal(messages.at(-1).manifest.assets.length,1);
    assert.equal(calls.length,beforeCalls+1);assert.equal(calls.at(-1).id,parent.id);
    parent.setPluginData('godot_ui_exporter_v1',JSON.stringify({mode:'native'}));
    assert.equal((await context.api.inspect(parent))[0].mode,'native');
    parent.setPluginData('godot_ui_exporter_v1','');
    parent.exportSettings=[{format:'SVG'}];
    const svgRows=await context.api.inspect(parent);assert.equal(svgRows[0].mode,'svg');
    await figma.ui.onmessage({type:'export',root_id:parent.id,configs:cfg(svgRows),scale:1});
    assert.equal(messages.at(-1).manifest.assets.length,1);assert.equal(calls.at(-1).settings.format,'SVG');
  }
  assert.throws(()=>core.zip([{path:'../escape',data:'x'}]));
  console.log('PASS: naming persistence, shared candidates, selection, geometry, duplicate-source exports, subtree suppression, cancellation, scene paths, ZIP safety.');
}
run().catch(e=>{console.error(e);process.exit(1);});
