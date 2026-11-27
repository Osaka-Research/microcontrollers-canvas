const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('../.qa/node_modules/jsdom');
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function boot(saved, loadCatalog=true){const dom=new JSDOM(fs.readFileSync('dist/index.html','utf8'),{url:'http://localhost:8080',runScripts:'outside-only'}),w=dom.window;w.requestAnimationFrame=()=>0;w.structuredClone=structuredClone;w.confirm=()=>true;w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};if(saved)w.localStorage.setItem('robot-canvas-v1',saved);const context=dom.getInternalVMContext();for(const f of ['firmware-engine.js','component-registry.js','model.js','app.js','developer.js','firmware.js','wiring.js'])vm.runInContext(fs.readFileSync('dist/'+f,'utf8'),context,{filename:f});if(loadCatalog)w.refreshComponentRegistry(require('../scripts/initial-component-catalog.cjs'));return {dom,w,run:code=>vm.runInContext(code,context),$:s=>w.document.querySelector(s)}}
test('create, label, save, add and wire an image board; survive reload',()=>{const b=boot();try{
 const {$,run,w}=b;$('#openDev').click();assert.equal($('#boardEditor').open,true);run(`boardDraft.image=${JSON.stringify(image)};boardDraft.width=300;boardDraft.height=500;renderEditorImage();`);$('#boardName').value='My <NodeMCU>';$('#boardName').dispatchEvent(new w.Event('input'));$('#pinStage').getBoundingClientRect=()=>({left:0,top:0,width:300,height:500});$('#pinStage').dispatchEvent(new w.MouseEvent('click',{clientX:30,clientY:100,bubbles:true}));assert.equal($('#pinCount').textContent,'1 / 64');$('#pinName').value='D1 <GPIO5>';$('#pinName').dispatchEvent(new w.Event('input'));$('#boardForm').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal($('#boardEditor').open,false);assert.equal(run('state.boards.length'),1);assert.ok($('#customBoards').textContent.includes('My <NodeMCU>'));$('#customBoards [data-board]').click();assert.equal(run('state.nodes.length'),1);assert.equal($('#nodes .board-pin').title,'D1 <GPIO5> · output');run("add('led');connect(state.nodes[0].id,'0');connect(state.nodes[1].id,'0');add('battery');connect(state.nodes[2].id,'1');connect(state.nodes[1].id,'1');selected=state.nodes[0].id;inspector();");$('#customMode0').value='high';$('#customMode0').dispatchEvent(new w.Event('change'));$('#run').click();assert.ok($('#nodes .light').classList.contains('on'));assert.equal(run('state.wires.length'),2);const saved=w.localStorage.getItem('robot-canvas-v1');const restored=boot(saved);try{assert.equal(restored.run('state.boards.length'),1);assert.equal(restored.run('state.wires.length'),2);assert.ok(restored.$('#nodes .board'))}finally{restored.dom.window.close()}
 }finally{b.dom.window.close()}});
test('duplicate names are rejected; cancelling edits leaves saved board intact',()=>{const b=boot();try{const {$,run,w}=b;$('#openDev').click();run(`boardDraft.image=${JSON.stringify(image)};boardDraft.width=100;boardDraft.height=100;boardDraft.name='Board';boardDraft.pins=[{id:'p1',name:'D1',kind:'output',x:0,y:0},{id:'p2',name:'D1',kind:'input',x:1,y:1}];`);$('#boardName').value='Board';$('#boardForm').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.match($('#editorError').textContent,/unique/);assert.equal(run('state.boards.length'),0);$('#cancelEditor').click();assert.equal($('#boardEditor').open,false);assert.equal(run('state.boards.length'),0)}finally{b.dom.window.close()}});
test('upload handler prepares image and stores normalized dimensions',async()=>{const b=boot();try{const {$,w,run}=b;$('#openDev').click();w.URL.createObjectURL=()=> 'blob:testing';w.URL.revokeObjectURL=()=>{};w.Image=class {naturalWidth=2400;naturalHeight=1200;async decode(){}};w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});w.HTMLCanvasElement.prototype.toDataURL=()=>image;const f=new w.File(['png'],'nodemcu.png',{type:'image/png'});await $('#boardImageFile').onchange({target:{files:[f],value:'image'}});assert.equal(run('boardDraft.width'),1200);assert.equal(run('boardDraft.height'),600);assert.equal($('#boardName').value,'nodemcu');assert.equal($('#pinStage').hidden,false);assert.equal($('#saveBoard').disabled,false)}finally{b.dom.window.close()}});

test('NodeMCU controls use real GPIO mapping and preserve firmware across reload',()=>{const b=boot();try{const {$,run,w}=b;class FakeWorker{constructor(){this.messages=[]}postMessage(m){this.messages.push(m)}terminate(){this.stopped=true}}w.Worker=FakeWorker;run("addEsp8266()");assert.ok($('#nodes .esp8266'));assert.equal($('#firmwarePreset').value,'blink');assert.match($('#inspectorContent').textContent,/D4 is GPIO2/);$('#firmwarePreset').value='micropython';$('#firmwarePreset').dispatchEvent(new w.Event('change'));assert.equal(run('state.nodes[0].firmware.preset'),'micropython');const pin=$('[data-direction="1"]');pin.value='input';pin.dispatchEvent(new w.Event('change'));assert.equal(run('RobotModel.pins(state,state.nodes[0])[1].kind'),'input');assert.equal(run('RobotModel.pins(state,state.nodes[0])[1].gpio'),5);const saved=w.localStorage.getItem('robot-canvas-v1'),next=boot(saved);try{assert.ok(next.$('#nodes .esp8266'));assert.equal(next.run('state.nodes[0].firmware.preset'),'micropython')}finally{next.dom.window.close()}}finally{b.dom.window.close()}});

test('loading a catalog restores a saved circuit and draws wires to a database part', async () => {
 const node=(id,type)=>({id,type,x:0,y:0,modes:['low','low','low','low'],period:1});
 const saved=JSON.stringify({name:'Saved circuit',nodes:[node('a','mcu'),node('b','meter')],
   wires:[{from:'a',pin:0,to:'b',toPin:1}]});
 const b=boot(saved,false);
 try {
  const {w,$,run}=b;
  assert.equal(w.localStorage.getItem('robot-canvas-v1'),saved);
  w.CANVAS_AI_ENDPOINT='https://backend.example/api/build';
  const loader=fs.readFileSync('dist/catalog-loader.js','utf8');
  w.fetch=async()=>new Response(null,{status:503});
  run(loader);
  await new Promise(setImmediate);
  assert.match($('#noResults').textContent,/unavailable/);
  assert.equal(w.localStorage.getItem('robot-canvas-v1'),saved);
  const meter={id:'meter',name:'Test meter',category:'Test',renderer:'generic',
    pins:[{id:'ground',name:'GND',kind:'ground-input'},{id:'signal',name:'IN',kind:'input'}]};
  w.fetch=async address=>{
   if(address==='https://backend.example/api/templates'){
    return Response.json({templates:[{id:'demo-tpl',name:'Demo RC Car',category:'ROBOTICS',difficulty:'Beginner',description:'Starter',realWorldNotes:'Test',project:{name:'Demo RC Car',boards:[],nodes:[node('t1','mcu')],wires:[]}}]});
   }
   assert.equal(address,'https://backend.example/api/components');
   return Response.json({definitions:[...require('../scripts/initial-component-catalog.cjs'),meter]});
  };
  run(loader);
  await new Promise(setImmediate);
  assert.equal($('#projectName').value,'Saved circuit');
  assert.equal($('#libraryCount').textContent,'13');
  assert.equal($('#noResults').hidden,true);
  assert.equal($('#wires').children.length,1);
  assert.equal(run('RobotModel.valid(state)'),true);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('robot-canvas-v1')).wires,JSON.parse(saved).wires);
  assert.equal($('#templateCount').textContent,'1');
  $('#toggleTemplates').click();
  assert.equal($('#templatesPanel').hidden,false);
  assert.equal($('#controlsPanel').hidden,true);
  assert.equal($('#toggleTemplates').getAttribute('aria-pressed'),'true');
  assert.match($('#templateList').textContent,/Demo RC Car/);
  $('#templateList .template-item').click();
  assert.equal($('#projectName').value,'Demo RC Car');
  assert.equal(run('state.nodes.length'),1);
 } finally { b.dom.window.close(); }
});

test('redo, wire role colors, safety warnings, MicroPython script runner, and non-overlapping AI layout work', () => {
 const b = boot();
 try {
  const { $, run, w } = b;
  class FakeWorker { constructor() { this.messages = []; } postMessage(m) { this.messages.push(m); } terminate() { this.stopped = true; } }
  w.Worker = FakeWorker;
  w.cancelAnimationFrame = () => {};

  // Add components and verify Undo + Redo
  run("add('mcu'); add('led'); add('battery');");
  assert.equal(run('state.nodes.length'), 3);
  $('#undo').click();
  assert.equal(run('state.nodes.length'), 2);
  $('#redo').click();
  assert.equal(run('state.nodes.length'), 3);

  // Wire battery + directly to LED anode and battery - to LED cathode -> check wire role classes & safety warning
  run("commitConnection({id:state.nodes[2].id,pin:0},{id:state.nodes[1].id,pin:0}); commitConnection({id:state.nodes[2].id,pin:1},{id:state.nodes[1].id,pin:1}); selected=state.nodes[1].id; render();");
  assert.ok($('.wire.wire-power'));
  assert.ok($('.wire.wire-ground'));
  assert.match($('#inspectorContent').textContent, /LED wired directly to battery/);
  assert.match($('#counts').textContent, /⚠ 1/);

  // Collapsible category search
  $('#search').value = 'HC-SR04';
  $('#search').dispatchEvent(new w.Event('input'));
  assert.equal(w.document.querySelectorAll('.category-group:not([hidden])').length, 1);

  // MicroPython script editor sends paste-mode payload
  run("addEsp8266(); state.nodes.at(-1).firmware={preset:'micropython'}; selected=state.nodes.at(-1).id; render();");
  $('#run').click();
  $('#pythonScript').value = 'print(42)';
  $('#pythonScript').dispatchEvent(new w.Event('input'));
  $('#runPythonScript').click();
  assert.equal(run("state.nodes.at(-1)._script"), 'print(42)');

  // Collision-free AI layout places new parts cleanly to the right of existing parts
  const maxBefore = run("Math.max(...state.nodes.map(n=>n.x))");
  run("CanvasAI.apply({summary:'Add servo',components:[{type:'servo',pack:'',pinDirections:[]}],wires:[]})");
  assert.ok(run('state.nodes.at(-1).x') > maxBefore);
 } finally {
  b.dom.window.close();
 }
});
