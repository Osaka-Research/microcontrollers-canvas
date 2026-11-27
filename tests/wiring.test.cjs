const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm');const {JSDOM}=require('../.qa/node_modules/jsdom');
function boot(){const dom=new JSDOM(fs.readFileSync('dist/index.html','utf8'),{url:'http://localhost:8080',runScripts:'outside-only'}),w=dom.window,ctx=dom.getInternalVMContext();w.requestAnimationFrame=()=>0;w.structuredClone=structuredClone;w.confirm=()=>true;w.Worker=class{postMessage(){}terminate(){}};w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};const $=s=>w.document.querySelector(s),run=s=>vm.runInContext(s,ctx),geometry={left:0,top:0,pins:new Map()};
 w.Element.prototype.getBoundingClientRect=function(){if(this.id==='world')return {left:geometry.left,top:geometry.top,width:1000,height:800,right:1000+geometry.left,bottom:800+geometry.top};if(this.matches?.('#nodes button.pin')){const p=geometry.pins.get(this.closest('.node').dataset.id+':'+this.dataset.pin)||{x:-500,y:-500};return {left:p.x-6,top:p.y-6,width:12,height:12,right:p.x+6,bottom:p.y+6}}return {left:0,top:0,width:1000,height:800,right:1000,bottom:800}};
 w.Element.prototype.setPointerCapture=function(id){this.capture=id};w.Element.prototype.hasPointerCapture=function(id){return this.capture===id};w.Element.prototype.releasePointerCapture=function(){this.capture=null};
 w.document.elementFromPoint=(x,y)=>[...w.document.querySelectorAll('#nodes button.pin')].find(p=>{const r=p.getBoundingClientRect();return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom})||$('#viewport');
 for(const f of ['firmware-engine.js','component-registry.js','model.js','app.js','developer.js','firmware.js','wiring.js'])run(fs.readFileSync('dist/'+f,'utf8'));
 w.refreshComponentRegistry(require('../scripts/initial-component-catalog.cjs'));
 function pin(index,pin,x,y){const id=run(`state.nodes[${index}].id`);geometry.pins.set(id+':'+pin,{x,y});return ()=>$(`[data-id="${id}"] button[data-pin="${pin}"]`)}
 function event(el,type,x,y,pointerType='mouse',id=1){const e=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});Object.defineProperties(e,{pointerId:{value:id},pointerType:{value:pointerType},isPrimary:{value:true}});el.dispatchEvent(e)}
 function drag(a,from,to,kind='mouse'){event(a(),'pointerdown',...from,kind);event($('#viewport'),'pointermove',...to,kind);event($('#viewport'),'pointerup',...to,kind)}
 return {dom,w,$,run,geometry,pin,event,drag}}
test('drag creates preview, highlights a target, commits once and allows fan-out',()=>{const b=boot();try{const {$,run,pin,event,drag}=b;run("add('mcu');add('led');add('motor')");const out=pin(0,'0',150,200),led=pin(1,'0',450,200),motor=pin(2,'0',450,400);const before=run('JSON.stringify(state.nodes.map(n=>[n.x,n.y]))');event(out(),'pointerdown',150,200);assert.ok(led().classList.contains('wire-compatible'));assert.equal($('#wirePreview').hasAttribute('hidden'),false);event($('#viewport'),'pointermove',450,200);assert.ok(led().classList.contains('wire-target'));assert.ok($('#wirePreview path').getAttribute('d').includes('450 200'));event($('#viewport'),'pointerup',450,200);assert.equal(run('state.wires.length'),1);assert.equal($('#wirePreview').hasAttribute('hidden'),true);led().dispatchEvent(new b.w.MouseEvent('click',{bubbles:true,detail:1}));assert.equal(run('pending'),null);assert.equal(run('state.wires.length'),1);drag(out,[150,200],[450,400]);assert.equal(run('state.wires.length'),2);assert.equal(run('new Set(state.wires.map(w=>w.pin)).size'),1);assert.equal(run('JSON.stringify(state.nodes.map(n=>[n.x,n.y]))'),before)}finally{b.dom.window.close()}});
test('touch can start at an input, snap nearby, and respect zoom/pan coordinates',()=>{const b=boot();try{const {$,run,pin,event}=b;run("add('mcu');add('led');zoom=2;pan={x:100,y:50};view()");b.geometry.left=100;b.geometry.top=50;const out=pin(0,'0',300,250),led=pin(1,'0',700,450);event(led(),'pointerdown',700,450,'touch');event($('#viewport'),'pointermove',320,250,'touch');assert.ok(out().classList.contains('wire-target'));assert.match($('#wirePreview path').getAttribute('d'),/^M100 100 /);event($('#viewport'),'pointerup',320,250,'touch');assert.equal(run('state.wires.length'),1);assert.equal(run('state.wires[0].from===state.nodes[0].id'),true);assert.equal(run('state.wires[0].to===state.nodes[1].id'),true)}finally{b.dom.window.close()}});
test('invalid drop, empty drop, Escape and pointer cancellation never change wiring',()=>{const b=boot();try{const {$,run,pin,event,drag,w}=b;run("add('mcu');add('mcu');add('led')");const out=pin(0,'0',100,100),other=pin(1,'0',400,100);pin(2,'0',400,400);const history=run('history.length');event(out(),'pointerdown',100,100);event($('#viewport'),'pointermove',400,100);assert.ok(other().classList.contains('wire-invalid'));event($('#viewport'),'pointerup',400,100);assert.equal(run('state.wires.length'),0);drag(out,[100,100],[800,700]);event(out(),'pointerdown',100,100);event($('#viewport'),'pointermove',400,400);w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));event($('#viewport'),'pointerup',400,400);assert.equal(run('state.wires.length'),0);event(out(),'pointerdown',100,100,'touch');event($('#viewport'),'pointercancel',150,150,'touch');assert.equal($('#wirePreview').hasAttribute('hidden'),true);assert.equal(run('history.length'),history);assert.equal(run('pending'),null)}finally{b.dom.window.close()}});
test('tap-to-connect remains available and rewiring an occupied input is undoable',()=>{const b=boot();try{const {run,pin,event,drag}=b;run("add('mcu');add('led')");const one=pin(0,'0',100,100),two=pin(0,'1',100,200),led=pin(1,'0',400,100);event(one(),'pointerdown',100,100);event(b.$('#viewport'),'pointerup',100,100);assert.ok(run('pending'));event(led(),'pointerdown',400,100);event(b.$('#viewport'),'pointerup',400,100);assert.equal(run('state.wires[0].pin'),0);drag(two,[100,200],[400,100]);assert.equal(run('state.wires.length'),1);assert.equal(run('state.wires[0].pin'),1);run('undo()');assert.equal(run('state.wires[0].pin'),0)}finally{b.dom.window.close()}});
test('NodeMCU numbered input endpoints are drawn and independently wired',()=>{const b=boot();try{const {run,pin,drag,$}=b;run("add('mcu');addEsp8266();state.nodes[1].pinDirections=RobotModel.pins(state,state.nodes[1]).map(p=>p.kind);state.nodes[1].pinDirections[1]='input';render()");const out=pin(0,'0',100,100),out2=pin(0,'1',100,200);pin(1,'9',500,100);pin(1,'1',500,200);drag(out,[100,100],[500,100]);drag(out2,[100,200],[500,200]);assert.equal(run('state.wires.length'),2);assert.equal(run('state.wires[0].toPin'),9);assert.equal($('#wires').children.length,2);assert.match($('#wires path').getAttribute('d'),/500 100$/);run('state.nodes[0].modes[0]="high";started=true;updateSignals()');assert.ok($('#nodes .esp8266 button[data-pin="9"]').classList.contains('high'))}finally{b.dom.window.close()}});
test('marked image-board pins can be dragged into a connection',()=>{const b=boot();try{const {run,pin,drag}=b;run(`state.boards=[{id:'imageboard',name:'Custom',image:'data:image/png;base64,aGVsbG8=',width:100,height:100,pins:[{id:'p0',name:'D0',kind:'output',x:.1,y:.1},{id:'p1',name:'D1',kind:'output',x:.1,y:.5}]}];addBoard('imageboard');add('led');`);const out=pin(0,'1',100,200);pin(1,'0',400,200);drag(out,[100,200],[400,200]);assert.equal(run('state.wires[0].pin'),1);assert.ok(run('RobotModel.valid(state)'))}finally{b.dom.window.close()}});

test('named pass-through rows connect from either end and expose their paired contact', () => {
 const b = boot();
 try {
  const cable = {
   id:'cableFixture', name:'Cable fixture', renderer:'generic',
   pins:['A','B'].map(id => ({id, name:id+' contact', kind:'passive-signal'})),
   conductors:[['A','B']]
  };
  b.w.refreshComponentRegistry([...require('../scripts/initial-component-catalog.cjs'),cable]);
  b.run("add('mcu');add('cableFixture');add('led')");
  const output=b.pin(0,'0',100,100), endB=b.pin(1,'1',300,100);
  const endA=b.pin(1,'0',300,150);
  b.pin(2,'0',500,150);
  assert.match(endB().textContent,/B contact/);
  b.drag(endA,[300,150],[500,150]);
  b.drag(output,[100,100],[300,100]);
  assert.equal(b.run('state.wires.length'),2);
  assert.equal(b.run('RobotModel.input(state,state.nodes[2],0,true,0)'),true);
  b.run('selected=state.nodes[1].id;inspector()');
  assert.match(b.$('#inspectorContent').textContent,/connected to B contact/);
 } finally {
  b.dom.window.close();
 }
});

test('passive conductor wires animate when driven, show pin names, and delete independently', () => {
 const b = boot();
 try {
  const cable = {
   id:'busFixture', name:'Bus fixture', renderer:'generic',
   pins:['A','B','C'].map(id => ({id, name:id+' terminal', kind:'passive-signal'})),
   conductors:[['A','B','C']]
  };
  b.w.refreshComponentRegistry([...require('../scripts/initial-component-catalog.cjs'), cable]);
  b.run("add('mcu');add('busFixture');add('busFixture');add('led')");
  b.run(`
   state.nodes[0].modes[0]='high';
   commitConnection({id:state.nodes[0].id,pin:0},{id:state.nodes[1].id,pin:0});
   commitConnection({id:state.nodes[1].id,pin:1},{id:state.nodes[2].id,pin:0});
   commitConnection({id:state.nodes[2].id,pin:1},{id:state.nodes[3].id,pin:0});
   started=true;running=true;selected=state.nodes[1].id;render();
  `);
  // All three wires (including passive-to-passive and passive-to-LED) should be HIGH
  const wirePaths = [...b.w.document.querySelectorAll('#wires path.wire')];
  assert.equal(wirePaths.length, 3);
  assert.ok(wirePaths.every(p => p.classList.contains('high')));
  // Inspector connection labels should show actual pin names, not "pin 1"
  assert.match(b.$('#inspectorContent').textContent, /D0/);
  assert.match(b.$('#inspectorContent').textContent, /A terminal/);
  assert.doesNotMatch(b.$('#inspectorContent').textContent, /· pin \d+/);
  // Deleting one wire connected to a passive contact must not delete the other wire
  const bus2Wire = b.run(`RobotModel.attachmentKey(state, state.wires[1])`);
  b.run(`deleteWire(${JSON.stringify(bus2Wire)})`);
  assert.equal(b.run('state.wires.length'), 2);
 } finally {
  b.dom.window.close();
 }
});
