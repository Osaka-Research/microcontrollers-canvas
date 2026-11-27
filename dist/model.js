'use strict';
const RobotModel=(()=>{
 const kinds=['output','input','drive-input','power','ground','power-input','ground-input','reserved','bidirectional'];
 const espPinDefs=()=>ComponentRegistry.pins('esp8266');
 const id=v=>typeof v==='string'&&/^[\w-]{1,80}$/.test(v);
 const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
 const unique=a=>new Set(a).size===a.length;
 const image=v=>typeof v==='string'&&v.length<=750000&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);
 function boardValid(b){return !!b&&id(b.id)&&text(b.name,60)&&image(b.image)&&Number.isInteger(b.width)&&b.width>0&&b.width<=1200&&Number.isInteger(b.height)&&b.height>0&&b.height<=1200&&(b.runtime===undefined||['logic','esp8266'].includes(b.runtime))&&Array.isArray(b.pins)&&b.pins.length>0&&b.pins.length<=64&&b.pins.every(p=>p&&id(p.id)&&text(p.name,32)&&kinds.includes(p.kind)&&(p.gpio==null||(Number.isInteger(p.gpio)&&p.gpio>=0&&p.gpio<=16&&['input','output'].includes(p.kind)))&&Number.isFinite(p.x)&&p.x>=0&&p.x<=1&&Number.isFinite(p.y)&&p.y>=0&&p.y<=1)&&unique(b.pins.map(p=>p.id))&&unique(b.pins.map(p=>p.name.trim().toLowerCase()))&&unique(b.pins.filter(p=>p.gpio!=null).map(p=>p.gpio))&&(b.runtime!=='esp8266'||b.pins.some(p=>p.gpio!=null))}
 const pinPositionValid=p=>(p.x===undefined&&p.y===undefined)||(Number.isFinite(p.x)&&p.x>=0&&p.x<=1&&Number.isFinite(p.y)&&p.y>=0&&p.y<=1);
 const board=(s,n)=>s.boards?.find(b=>b.id===n.boardId);
 function pins(s,n){if(!n)return [];if(n.type==='board')return board(s,n)?.pins||[];const definition=ComponentRegistry.get(n.type);if(!definition||!definition.pins.every(pinPositionValid))return [];if(n.type==='esp8266')return espPinDefs().map((p,i)=>({...p,kind:p.gpio!=null?(n.pinDirections?.[i]||p.kind):p.kind}));return ComponentRegistry.pins(n.type).map((pin,index)=>pin.kind==='bidirectional'
  ?{...pin,kind:n.pinDirections?.[index]||'input'}:pin)}
 function pinIndex(pin){return pin==='in'?0:Number(pin)}
 function kind(s,n,pin){const index=pinIndex(pin);return Number.isInteger(index)?pins(s,n)[index]?.kind:undefined}
 const firmwareTarget=(s,n)=>n&&(n.type==='esp8266'||(n.type==='board'&&board(s,n)?.runtime==='esp8266'));
 function firmwareValid(f){return f===undefined||(f&&['blink','micropython','uploaded'].includes(f.preset)&&(f.preset!=='uploaded'||(typeof f.b64==='string'&&f.b64.length<=2796204&&/^[A-Za-z0-9+/]+={0,2}$/.test(f.b64)&&typeof f.name==='string'&&f.name.length<=120)))}
 const sourceKind=k=>['output','power','ground'].includes(k);
 const targetKey=w=>w.to+':'+(w.toPin??0);
 const passiveKinds=new Map([['passive-signal','output'],['passive-power','power'],['passive-ground','ground']]);
 function attachmentKey(s,w){
  const target=s.nodes.find(n=>n.id===w.to);
  const terminal=ComponentRegistry.get(target?.type)?.pins[w.toPin??0];
  if(!passiveKinds.has(terminal?.kind))return targetKey(w);
  return [w.from+':'+w.pin,targetKey(w)].sort().join('|');
 }
 function accepts(s,source,target,sourcePin,targetPin){
  const sk=kind(s,source,sourcePin),tk=kind(s,target,targetPin);
  const driver=passiveKinds.get(sk)||sk;
  if(passiveKinds.has(tk))return driver===passiveKinds.get(tk);
  return (driver==='output'&&['input','drive-input'].includes(tk))||
   (driver==='power'&&['drive-input','power-input'].includes(tk))||(driver==='ground'&&tk==='ground-input');
 }
 // Treat each documented conductor as one electrical node, scoped to its component instance.
 function passiveNetwork(s,wires){
  const contacts=new Map(),adjacent=new Map(),drivers=new Map();
  for(const n of s.nodes){
   const def=ComponentRegistry.get(n.type);
   if(!def?.conductors?.length)continue;
   const indices=new Map(def.pins.map((pin,i)=>[pin.id,i]));
   for(const group of def.conductors){
    const net=adjacent.size;
    adjacent.set(net,new Set());
    for(const id of group)contacts.set(n.id+':'+indices.get(id),net);
   }
  }
  for(const w of wires){
   const from=contacts.get(w.from+':'+w.pin),to=contacts.get(targetKey(w));
   if(from!==undefined&&to!==undefined){adjacent.get(from).add(to);adjacent.get(to).add(from)}
   else if(to!==undefined){
    if(!drivers.has(to))drivers.set(to,[]);
    drivers.get(to).push(w);
   }
  }
  const sources=new Map();
  for(const net of adjacent.keys()){
   if(sources.has(net))continue;
   const connected=new Set([net]),uniqueDrivers=new Map();
   for(const current of connected){
    for(const next of adjacent.get(current))connected.add(next);
    for(const w of drivers.get(current)||[])uniqueDrivers.set(w.from+':'+w.pin,w);
   }
   if(uniqueDrivers.size>1)return null;
   const driver=uniqueDrivers.values().next().value;
   for(const current of connected)sources.set(current,driver);
  }
  return {contacts,sources};
 }
 function wireValid(s,w){
  if(!w)return false;
  const a=s.nodes.find(n=>n.id===w.from),b=s.nodes.find(n=>n.id===w.to);
  return !!a&&!!b&&a!==b&&Number.isInteger(w.pin)&&w.pin>=0&&Number.isInteger(w.toPin??0)&&
   (w.toPin??0)>=0&&accepts(s,a,b,w.pin,w.toPin??0);
 }
 function directionsValid(s,n){
  if(n.pinDirections===undefined)return true;
  if(n.type==='esp8266')return true;
  const definitions=ComponentRegistry.get(n.type)?.pins||[];
  return Array.isArray(n.pinDirections)&&n.pinDirections.length===definitions.length&&
   n.pinDirections.every((direction,index)=>definitions[index].kind==='bidirectional'
    ?['input','output'].includes(direction):direction===definitions[index].kind);
 }
 function valid(s){
  if(!s||!text(s.name,60)||!Array.isArray(s.nodes)||s.nodes.length>150||!Array.isArray(s.wires)||s.wires.length>600)return false;
  const boards=s.boards??[];if(!Array.isArray(boards)||boards.length>32||!boards.every(boardValid)||!unique(boards.map(b=>b.id))||boards.reduce((sum,b)=>sum+b.image.length,0)>3000000)return false;
  if(!s.nodes.every(n=>n&&id(n.id)&&ComponentRegistry.types().includes(n.type)&&Number.isFinite(n.x)&&Math.abs(n.x)<100000&&Number.isFinite(n.y)&&Math.abs(n.y)<100000&&Array.isArray(n.modes)&&(n.type==='board'?n.modes.length===board(s,n)?.pins.length:n.type==='esp8266'?n.modes.length===espPinDefs().length:ComponentRegistry.get(n.type)?.renderer==='generic'?[4,pins(s,n).length].includes(n.modes.length):n.modes.length===4)&&n.modes.every(m=>['low','high','blink'].includes(m))&&Number.isFinite(n.period)&&n.period>=.2&&n.period<=5&&(n.distanceCm===undefined||(Number.isFinite(n.distanceCm)&&n.distanceCm>=2&&n.distanceCm<=400))&&firmwareValid(n.firmware)&&(n.pinDirections===undefined||(n.type==='esp8266'&&Array.isArray(n.pinDirections)&&n.pinDirections.length===espPinDefs().length&&n.pinDirections.every((k,i)=>espPinDefs()[i].gpio!=null?['input','output'].includes(k):k===espPinDefs()[i].kind)))&&(n.type!=='board'||!!board(s,n))&&directionsValid(s,n)))return false;
  if(s.nodes.filter(n=>firmwareTarget(s,n)).length>4||s.nodes.reduce((sum,n)=>sum+(n.firmware?.b64?.length||0),0)>3000000)return false;
  return unique(s.nodes.map(n=>n.id))&&s.wires.every(w=>wireValid(s,w))&&unique(s.wires.map(w=>attachmentKey(s,w)))&&!!passiveNetwork(s,s.wires);
 }
 function output(s,n,p,started,elapsed,firmwareRead,lookup,visited){
  if(!started||!n)return false;
  const k=kind(s,n,p);
  if(k==='power')return true;
  if(k!=='output')return false;
  if(firmwareTarget(s,n))return firmwareRead?!!firmwareRead(n,p):false;
  if(n.type==='motorDriver'||n.type==='ultrasonic'){
   const key=n.id+':'+p,seen=visited||new Set();
   if(seen.has(key))return false;
   const nextSeen=new Set(seen);nextSeen.add(key);
   const resolve=lookup||driverLookup(s);
   const readIn=pin=>input(s,n,pin,started,elapsed,firmwareRead,resolve,nextSeen);
   const hasIn=pin=>!!resolve(n,pin);
   if(n.type==='motorDriver'){
    const powered=readIn(8)&&readIn(9)&&(hasIn(7)||hasIn(10)||hasIn(15))&&readIn(3);
    if(!powered)return false;
    if(p===11||p===12){const pwm=readIn(0),a1=readIn(2),a2=readIn(1);return pwm&&a1!==a2&&(p===11?a1:a2)}
    if(p===13||p===14){const pwm=readIn(6),b1=readIn(4),b2=readIn(5);return pwm&&b1!==b2&&(p===14?b1:b2)}
    return false;
   }
   if(n.type==='ultrasonic')return p===2&&readIn(0)&&hasIn(3)&&readIn(1);
  }
  return n.modes[p]==='high'||(n.modes[p]==='blink'&&elapsed%(n.period*1000)<n.period*500);
 }
 // Build one lookup per simulation update so all reads see the same wiring.
 function driverLookup(s){
  const network=passiveNetwork(s,s.wires),incoming=new Map();
  for(const w of s.wires)incoming.set(targetKey(w),w);
  return (n,p)=>{
   if(!network)return undefined;
   const key=n.id+':'+p;
   if(network.contacts.has(key))return network.sources.get(network.contacts.get(key));
   const w=incoming.get(key);
   if(!w)return undefined;
   const net=network.contacts.get(w.from+':'+w.pin);
   return net===undefined?w:network.sources.get(net);
  };
 }
 function input(s,n,p,started,elapsed,firmwareRead,lookup,visited){
  if(!started)return false;
  const resolve=lookup||driverLookup(s),driver=resolve(n,p);
  return driver?output(s,s.nodes.find(node=>node.id===driver.from),driver.pin,started,elapsed,firmwareRead,resolve,visited):false;
 }
 function wireRole(s,w){
  const from=s.nodes.find(n=>n.id===w.from),to=s.nodes.find(n=>n.id===w.to);
  const ks=[kind(s,from,w.pin),kind(s,to,w.toPin??0)];
  if(ks.some(k=>k==='power'||k==='power-input'||k==='passive-power'))return 'power';
  if(ks.some(k=>k==='ground'||k==='ground-input'||k==='passive-ground'))return 'ground';
  return 'signal';
 }
 function diagnostics(s){
  const issues=[],resolve=driverLookup(s),byId=new Map(s.nodes.map(n=>[n.id,n]));
  const sourceNode=(n,p)=>{const d=resolve(n,p);return d?byId.get(d.from):null};
  for(const n of s.nodes){
   if(n.type==='led'){
    const src=sourceNode(n,0);
    if(src?.type==='battery')issues.push({severity:'warning',nodeId:n.id,title:'LED wired directly to battery',detail:'Add a series current-limiting resistor (for example 220 Ω at 3.3 V) so the LED does not burn out.'});
    else if(src&&(src.type==='mcu'||src.type==='esp8266'||src.type==='board'))issues.push({severity:'info',nodeId:n.id,title:'Remember a series resistor on real hardware',detail:'A 5 mm red LED needs a current-limiting resistor (around 220 Ω for 3.3 V GPIO) in a physical circuit.'});
   }else if(n.type==='motor'){
    const s0=sourceNode(n,0),s1=sourceNode(n,1);
    if([s0,s1].some(src=>src&&(src.type==='mcu'||src.type==='esp8266'||src.type==='board'))){
     issues.push({severity:'warning',nodeId:n.id,title:'Motor driven directly by GPIO',detail:'The Pololu #1101 gearmotor draws up to ~1.6 A stall current. Drive it through an H-bridge motor driver like the TB6612FNG instead of a microcontroller pin.'});
    }
   }else if(n.type==='esp8266'){
    const ps=pins(s,n);
    for(let i=0;i<ps.length;i++){
     if(ps[i].kind!=='input')continue;
     const d=resolve(n,i);
     if(d&&byId.get(d.from)?.type==='ultrasonic'&&d.pin===2){
      issues.push({severity:'warning',nodeId:n.id,title:'5 V HC-SR04 ECHO on 3.3 V NodeMCU pin',detail:'HC-SR04 ECHO can reach 5 V while NodeMCU GPIO is 3.3 V and not 5 V tolerant. Use a level shifter or resistor divider on real hardware.'});
      break;
     }
    }
   }else if(n.type==='servo'){
    const pwr=sourceNode(n,1);
    if(pwr?.type==='battery'&&pwr.pack==='nineVolt')issues.push({severity:'warning',nodeId:n.id,title:'9 V battery on 4.8 V servo',detail:'SG90 servos are rated for 4.8 V and draw high peak current. A 9 V PP3 alkaline battery can damage the servo or sag under load.'});
    if(resolve(n,1)&&!resolve(n,2))issues.push({severity:'warning',nodeId:n.id,title:'Servo is missing a ground connection',detail:'Connect the servo GND (brown/black) wire to ground and share ground with the controller.'});
   }else if(n.type==='motorDriver'){
    const vm=sourceNode(n,8);
    if(vm?.type==='battery'&&vm.pack==='nineVolt')issues.push({severity:'warning',nodeId:n.id,title:'9 V PP3 battery on motor power (VM)',detail:'Rectangular 9 V alkaline batteries are intended for low-drain devices and sag quickly when driving DC gearmotors. Prefer an AA NiMH or regulated pack.'});
    if((resolve(n,8)||resolve(n,9))&&!(resolve(n,7)||resolve(n,10)||resolve(n,15)))issues.push({severity:'warning',nodeId:n.id,title:'Motor driver is missing ground',detail:'Connect at least one GND pin on the TB6612FNG so logic and motor power share a ground reference.'});
   }
  }
  return issues;
 }
 function connection(s,one,two){
  const a=s.nodes.find(n=>n.id===one.id),b=s.nodes.find(n=>n.id===two.id);
  if(!a||!b||a===b)return null;
  let from=one,to=two;
  if(!accepts(s,a,b,one.pin,two.pin)){
   if(!accepts(s,b,a,two.pin,one.pin))return null;
   from=two;to=one;
  }
  if(passiveKinds.has(kind(s,a,one.pin))&&passiveKinds.has(kind(s,b,two.pin))&&a.id>b.id){from=two;to=one}
  const wire={from:from.id,pin:pinIndex(from.pin),to:to.id,toPin:pinIndex(to.pin)};
  if(passiveKinds.has(kind(s,a,one.pin))||passiveKinds.has(kind(s,b,two.pin))){
   if(!passiveNetwork(s,[...s.wires,wire]))return null;
  }
  return wire;
 }
 function replaceBoard(s,next){const old=s.boards.find(b=>b.id===next.id);if(!old){s.boards.push(next);return}const nodes=s.nodes.filter(n=>n.type==='board'&&n.boardId===next.id),ids=new Set(nodes.map(n=>n.id));const remap=i=>next.pins.findIndex(p=>p.id===old.pins[i]?.id);s.wires=s.wires.flatMap(w=>{const v={...w};if(ids.has(v.from))v.pin=remap(v.pin);if(ids.has(v.to))v.toPin=remap(v.toPin??0);return v.pin<0||(v.toPin??0)<0?[]:[v]});for(const n of nodes)n.modes=next.pins.map(p=>n.modes[old.pins.findIndex(k=>k.id===p.id)]||'low');s.boards[s.boards.indexOf(old)]=next;s.wires=s.wires.filter(w=>wireValid(s,w))}
 return {boardValid,valid,get espPins(){return espPinDefs()},firmwareTarget,firmwareValid,board,pins,kind,sourceKind,targetKey,attachmentKey,wireValid,wireRole,diagnostics,output,input,driverLookup,connection,replaceBoard};
})();
if(typeof module!=='undefined')module.exports=RobotModel;
