const {test}=require('node:test');
require('../dist/component-registry.js').replace(require('../scripts/initial-component-catalog.cjs'));

const assert=require('node:assert/strict');
const M=require('../dist/model.js');
const board=()=>({id:'board1',name:'Demo board',image:'data:image/png;base64,aGVsbG8=',width:300,height:500,pins:[{id:'p0',name:'D1',kind:'output',x:.1,y:.2},{id:'p1',name:'RX',kind:'input',x:.8,y:.2},{id:'p2',name:'3V3',kind:'power',x:.1,y:.8},{id:'p3',name:'GND',kind:'ground',x:.8,y:.8}]});
const node=(id,type,extra={})=>({id,type,x:10,y:20,modes:['blink','low','low','low'],period:1,...extra});
function project(){return {name:'Test',boards:[board()],nodes:[node('custom','board',{boardId:'board1'}),node('led','led'),node('mcu','mcu')],wires:[]}}
test('old projects remain valid',()=>assert.equal(M.valid({name:'Legacy',nodes:[node('old','mcu')],wires:[]}),true));
test('custom output drives LED and power/ground provide fixed signals',()=>{const s=project(),n=s.nodes[0];s.wires=[M.connection(s,{id:'led',pin:'in'},{id:'custom',pin:'0'})];assert.ok(M.valid(s));assert.equal(M.input(s,s.nodes[1],0,true,0),true);assert.equal(M.input(s,s.nodes[1],0,true,750),false);assert.equal(M.output(s,n,2,true,0),true);assert.equal(M.output(s,n,3,true,0),false);assert.equal(M.output(s,n,2,false,0),false)});
test('custom inputs receive controller signals and incompatible connections fail',()=>{const s=project();s.wires=[M.connection(s,{id:'mcu',pin:'0'},{id:'custom',pin:'1'})];assert.ok(M.valid(s));assert.equal(M.input(s,s.nodes[0],1,true,0),true);assert.equal(M.connection(s,{id:'mcu',pin:'0'},{id:'custom',pin:'0'}),null);assert.equal(M.connection(s,{id:'custom',pin:'0'},{id:'custom',pin:'1'}),null)});
test('pin reorder preserves connections and per-instance behavior by pin ID',()=>{const s=project();s.wires=[{from:'custom',pin:0,to:'led'},{from:'mcu',pin:0,to:'custom',toPin:1}];const next=board();next.pins=[next.pins[1],next.pins[0],next.pins[3],next.pins[2]];M.replaceBoard(s,next);assert.equal(s.wires[0].pin,1);assert.equal(s.wires[1].toPin,0);assert.equal(s.nodes[0].modes[1],'blink');assert.ok(M.valid(s))});
test('removing or changing a wired pin disconnects it without misrouting',()=>{const s=project();s.wires=[{from:'custom',pin:0,to:'led'}];const next=board();next.pins[0].kind='input';M.replaceBoard(s,next);assert.equal(s.wires.length,0);const s2=project();s2.wires=[{from:'custom',pin:0,to:'led'}];const b=board();b.pins.shift();M.replaceBoard(s2,b);assert.equal(s2.wires.length,0);assert.ok(M.valid(s2))});
test('reject malformed, unsafe, or ambiguous imported projects',()=>{const invalid=[null,{name:'bad',nodes:[null],wires:[]}];for(const change of [s=>s.boards[0].image='javascript:alert(1)',s=>s.boards[0].pins[0].x=1.1,s=>s.boards[0].pins[0].name='RX',s=>s.nodes[0].boardId='missing',s=>s.nodes[0].modes=[],s=>s.wires=[{from:'custom',pin:99,to:'led'}],s=>s.wires=[{from:'custom',pin:0,to:'led'},{from:'mcu',pin:0,to:'led'}]]){const s=project();change(s);invalid.push(s)}for(const s of invalid)assert.equal(M.valid(s),false)});
test('export/import roundtrip preserves board artwork, pin locations and signals',()=>{const s=project();s.wires=[{from:'custom',pin:0,to:'led',toPin:0}];const restored=JSON.parse(JSON.stringify(s));assert.ok(M.valid(restored));assert.deepEqual(restored,s);assert.equal(M.input(restored,restored.nodes[1],0,true,0),true)});

test('pass-through contacts carry a single compatible source in either direction', () => {
 const registry = require('../dist/component-registry.js');
 const original = registry.all();
 const cable = {id:'testCable',name:'Test cable',renderer:'generic',pins:[],conductors:[]};
 for (const kind of ['signal','power','ground']) {
  const pair = ['A','B'].map(end => end+'-'+kind);
  cable.conductors.push(pair);
  cable.pins.push(...pair.map(id => ({id,name:id,kind:'passive-'+kind})));
 }
 try {
  registry.replace([...original,cable]);
  for (const reverse of [false,true]) {
   const s=project();
   s.nodes.push(node('a',cable.id),node('b',cable.id));
   function join(a,i,b,j) {
    const w=M.connection(s,{id:a,pin:i},{id:b,pin:j});
    assert.ok(w);
    s.wires.push(w);
   }
   const start=reverse?1:0,end=1-start;
   join('led',0,'b',end);
   join('b',start,'a',end);
   assert.equal(M.input(s,s.nodes[1],0,true,0),false);
   join('a',start,'custom',0);
   assert.ok(M.valid(JSON.parse(JSON.stringify(s))));
   assert.equal(M.input(s,s.nodes[1],0,true,0),true);
   assert.equal(M.input(s,s.nodes[1],0,true,750),false);
   assert.equal(M.connection(s,{id:'mcu',pin:1},{id:'b',pin:start}),null);
   assert.equal(M.connection(s,{id:'custom',pin:2},{id:'a',pin:start}),null);
   join('custom',3,'a',4);
   join('a',5,'led',1);
   assert.equal(M.driverLookup(s)(s.nodes[1],1).pin,3);
   assert.equal(M.connection(s,{id:'a',pin:3},{id:'led',pin:1}),null);
   s.wires.push({from:'mcu',pin:1,to:'b',toPin:start});
   assert.equal(M.valid(s),false);
  }
  assert.throws(()=>registry.replace([{...cable,conductors:[['A-power','B-ground']]}]));
 } finally { registry.replace(original); }
});

test('TB6612FNG digital truth table drives motor forward/reverse and HC-SR04 responds to TRIG', () => {
 const s = {
  name: 'Robotics',
  boards: [],
  nodes: [
   node('mcu', 'mcu', { modes: ['high', 'high', 'low', 'high'] }), // D0=PWMA, D1=AIN1, D2=AIN2, D3=STBY
   node('bat', 'battery', { pack: 'eneloop4' }),
   node('drv', 'motorDriver'),
   node('mot', 'motor'),
   node('sonar', 'ultrasonic', { distanceCm: 25 })
  ],
  wires: [
   { from: 'bat', pin: 0, to: 'drv', toPin: 8 }, // VM
   { from: 'bat', pin: 0, to: 'drv', toPin: 9 }, // VCC
   { from: 'bat', pin: 1, to: 'drv', toPin: 7 }, // GND
   { from: 'mcu', pin: 0, to: 'drv', toPin: 0 }, // PWMA
   { from: 'mcu', pin: 1, to: 'drv', toPin: 2 }, // AIN1 = HIGH
   { from: 'mcu', pin: 2, to: 'drv', toPin: 1 }, // AIN2 = LOW
   { from: 'mcu', pin: 3, to: 'drv', toPin: 3 }, // STBY = HIGH
   { from: 'drv', pin: 11, to: 'mot', toPin: 0 }, // AO1 -> M+
   { from: 'drv', pin: 12, to: 'mot', toPin: 1 }, // AO2 -> M-
   { from: 'bat', pin: 0, to: 'sonar', toPin: 0 }, // VCC
   { from: 'bat', pin: 1, to: 'sonar', toPin: 3 }, // GND
   { from: 'mcu', pin: 0, to: 'sonar', toPin: 1 } // TRIG
  ]
 };
 assert.equal(M.valid(s), true);
 assert.equal(M.wireRole(s, s.wires[0]), 'power');
 assert.equal(M.wireRole(s, s.wires[2]), 'ground');
 assert.equal(M.wireRole(s, s.wires[3]), 'signal');
 // Forward: AO1 HIGH, AO2 LOW
 assert.equal(M.input(s, s.nodes[3], 0, true, 0), true);
 assert.equal(M.input(s, s.nodes[3], 1, true, 0), false);
 // Standby LOW stops outputs
 s.nodes[0].modes[3] = 'low';
 assert.equal(M.input(s, s.nodes[3], 0, true, 0), false);
 // Reverse: STBY HIGH, AIN1 LOW, AIN2 HIGH
 s.nodes[0].modes[3] = 'high';
 s.nodes[0].modes[1] = 'low';
 s.nodes[0].modes[2] = 'high';
 assert.equal(M.input(s, s.nodes[3], 0, true, 0), false);
 assert.equal(M.input(s, s.nodes[3], 1, true, 0), true);
 // HC-SR04 ECHO responds when VCC, GND, TRIG are active
 assert.equal(M.output(s, s.nodes[4], 2, true, 0), true);
 s.nodes[0].modes[0] = 'low';
 assert.equal(M.output(s, s.nodes[4], 2, true, 0), false);
});

test('diagnostics flags common beginner hardware hazards', () => {
 const espModes = M.espPins.map(() => 'low');
 const espDirs = M.espPins.map(p => p.kind);
 espDirs[1] = 'input'; // D1 as input
 const s = {
  name: 'Hazards',
  boards: [],
  nodes: [
   node('bat9', 'battery', { pack: 'nineVolt' }),
   node('led', 'led'),
   node('mcu', 'mcu'),
   node('mot', 'motor'),
   node('esp', 'esp8266', { modes: espModes, pinDirections: espDirs }),
   node('sonar', 'ultrasonic'),
   node('servo', 'servo')
  ],
  wires: [
   { from: 'bat9', pin: 0, to: 'led', toPin: 0 },
   { from: 'mcu', pin: 0, to: 'mot', toPin: 0 },
   { from: 'sonar', pin: 2, to: 'esp', toPin: 1 },
   { from: 'bat9', pin: 0, to: 'servo', toPin: 1 }
  ]
 };
 assert.equal(M.valid(s), true);
 const titles = M.diagnostics(s).map(d => d.title);
 assert.ok(titles.some(t => /LED wired directly to battery/.test(t)));
 assert.ok(titles.some(t => /Motor driven directly by GPIO/.test(t)));
 assert.ok(titles.some(t => /5 V HC-SR04 ECHO/.test(t)));
 assert.ok(titles.some(t => /9 V battery on 4\.8 V servo/.test(t)));
 assert.ok(titles.some(t => /missing a ground/.test(t)));
});

test('cells connect in series with voltage sum, short-circuit protection, and common ground nets', () => {
 const registry = require('../dist/component-registry.js');
 const original = registry.all();
 const coinCell = {
  id: 'cr2032', name: 'CR2032 3V Coin Cell', renderer: 'generic',
  pins: [{ id: 'pos', name: '+', kind: 'power' }, { id: 'neg', name: '−', kind: 'ground' }]
 };
 const lipoCell = {
  id: 'lipo37', name: 'Lithium Ion Polymer Battery - 3.7v 2500mAh', renderer: 'generic',
  pins: [{ id: 'pos', name: '+', kind: 'power' }, { id: 'neg', name: '−', kind: 'ground' }]
 };
 const gndBus = {
  id: 'gndRail', name: 'Ground rail', renderer: 'generic',
  pins: ['G1', 'G2', 'G3'].map(id => ({ id, name: id, kind: 'passive-ground' })),
  conductors: [['G1', 'G2', 'G3']]
 };
 try {
  registry.replace([...original, coinCell, lipoCell, gndBus]);
  const s = {
   name: 'Series and Common Ground',
   boards: [],
   nodes: [
    node('c1', 'cr2032', { modes: ['low', 'low'] }),
    node('c2', 'cr2032', { modes: ['low', 'low'] }),
    node('led', 'led'),
    node('servo', 'servo'),
    node('esp', 'esp8266', { modes: M.espPins.map(() => 'low') }),
    node('rail', 'gndRail', { modes: ['low', 'low', 'low'] })
   ],
   wires: []
  };

  // Connect c1 (+) -> c2 (-) in series (even when passed in reverse order)
  const wSeries = M.connection(s, { id: 'c2', pin: 1 }, { id: 'c1', pin: 0 });
  assert.deepEqual(wSeries, { from: 'c1', pin: 0, to: 'c2', toPin: 1 });
  s.wires.push(wSeries);
  assert.equal(M.valid(s), true);
  assert.equal(M.wireRole(s, wSeries), 'power');

  const info = M.seriesInfo(s, 'c2');
  assert.equal(info.count, 2);
  assert.equal(info.position, 2);
  assert.equal(info.totalVoltage, 6);
  assert.equal(info.mismatched, false);

  // Short-circuit loop (c2 + -> c1 -) must be rejected
  assert.equal(M.connection(s, { id: 'c2', pin: 0 }, { id: 'c1', pin: 1 }), null);
  // Grounding the intermediate series junction (c2 - -> c1 -) must be rejected (would short c1)
  assert.equal(M.connection(s, { id: 'c2', pin: 1 }, { id: 'c1', pin: 1 }), null);
  // Non-cell power (NodeMCU 3V3 pin 11) -> cell ground (c1 -) must stay rejected
  assert.equal(M.connection(s, { id: 'esp', pin: 11 }, { id: 'c1', pin: 1 }), null);

  // Common ground: NodeMCU GND (pin 12) <-> c1 (-) is allowed!
  const wCommonGnd = M.connection(s, { id: 'esp', pin: 12 }, { id: 'c1', pin: 1 });
  assert.ok(wCommonGnd);
  s.wires.push(wCommonGnd);

  // Daisy-chained ground-inputs: c1 (-) -> servo GND -> LED cathode grounds the LED!
  const wServoGnd = M.connection(s, { id: 'c1', pin: 1 }, { id: 'servo', pin: 2 });
  const wLedChain = M.connection(s, { id: 'servo', pin: 2 }, { id: 'led', pin: 1 });
  assert.ok(wServoGnd && wLedChain);
  s.wires.push(wServoGnd, wLedChain);
  assert.equal(M.valid(s), true);
  assert.ok(M.driverLookup(s)(s.nodes[2], 1)); // LED cathode is grounded via daisy chain

  // Passive ground rail accepts multiple ground references (common ground bus)
  const wRail1 = M.connection(s, { id: 'c1', pin: 1 }, { id: 'rail', pin: 0 });
  const wRail2 = M.connection(s, { id: 'esp', pin: 12 }, { id: 'rail', pin: 1 });
  assert.ok(wRail1 && wRail2);
  s.wires.push(wRail1, wRail2);
  assert.equal(M.valid(s), true);

  // Mismatched + LiPo series warnings
  const sMix = {
   name: 'Mix',
   boards: [],
   nodes: [
    node('c1', 'cr2032', { modes: ['low', 'low'] }),
    node('c2', 'lipo37', { modes: ['low', 'low'] })
   ],
   wires: [{ from: 'c1', pin: 0, to: 'c2', toPin: 1 }]
  };
  assert.equal(M.valid(sMix), true);
  const diagTitles = M.diagnostics(sMix).map(d => d.title);
  assert.ok(diagTitles.some(t => /Mismatched cells/.test(t)));
  assert.ok(diagTitles.some(t => /BMS/.test(t)));
 } finally {
  registry.replace(original);
 }
});
