'use strict';
const RobotModel=(()=>{
 const kinds=['output','input','drive-input','power','ground','power-input','ground-input','reserved'];
 const espPinDefs=()=>ComponentRegistry.pins('esp8266');
 const id=v=>typeof v==='string'&&/^[\w-]{1,80}$/.test(v);
 const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
 const unique=a=>new Set(a).size===a.length;
 const image=v=>typeof v==='string'&&v.length<=750000&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);
 function boardValid(b){return !!b&&id(b.id)&&text(b.name,60)&&image(b.image)&&Number.isInteger(b.width)&&b.width>0&&b.width<=1200&&Number.isInteger(b.height)&&b.height>0&&b.height<=1200&&(b.runtime===undefined||['logic','esp8266'].includes(b.runtime))&&Array.isArray(b.pins)&&b.pins.length>0&&b.pins.length<=64&&b.pins.every(p=>p&&id(p.id)&&text(p.name,32)&&kinds.includes(p.kind)&&(p.gpio==null||(Number.isInteger(p.gpio)&&p.gpio>=0&&p.gpio<=16&&['input','output'].includes(p.kind)))&&Number.isFinite(p.x)&&p.x>=0&&p.x<=1&&Number.isFinite(p.y)&&p.y>=0&&p.y<=1)&&unique(b.pins.map(p=>p.id))&&unique(b.pins.map(p=>p.name.trim().toLowerCase()))&&unique(b.pins.filter(p=>p.gpio!=null).map(p=>p.gpio))&&(b.runtime!=='esp8266'||b.pins.some(p=>p.gpio!=null))}
 const pinPositionValid=p=>(p.x===undefined&&p.y===undefined)||(Number.isFinite(p.x)&&p.x>=0&&p.x<=1&&Number.isFinite(p.y)&&p.y>=0&&p.y<=1);
 const board=(s,n)=>s.boards?.find(b=>b.id===n.boardId);
 function pins(s,n){if(!n)return [];if(n.type==='board')return board(s,n)?.pins||[];const definition=ComponentRegistry.get(n.type);if(!definition||!definition.pins.every(pinPositionValid))return [];if(n.type==='esp8266')return espPinDefs().map((p,i)=>({...p,kind:p.gpio!=null?(n.pinDirections?.[i]||p.kind):p.kind}));return ComponentRegistry.pins(n.type)}
 function pinIndex(pin){return pin==='in'?0:Number(pin)}
 function kind(s,n,pin){const index=pinIndex(pin);return Number.isInteger(index)?pins(s,n)[index]?.kind:undefined}
 const firmwareTarget=(s,n)=>n&&(n.type==='esp8266'||(n.type==='board'&&board(s,n)?.runtime==='esp8266'));
 function firmwareValid(f){return f===undefined||(f&&['blink','micropython','uploaded'].includes(f.preset)&&(f.preset!=='uploaded'||(typeof f.b64==='string'&&f.b64.length<=2796204&&/^[A-Za-z0-9+/]+={0,2}$/.test(f.b64)&&typeof f.name==='string'&&f.name.length<=120)))}
 const sourceKind=k=>['output','power','ground'].includes(k);
 const targetKey=w=>w.to+':'+(w.toPin??0);
 function accepts(s,source,target,sourcePin,targetPin){const sk=kind(s,source,sourcePin),tk=kind(s,target,targetPin);return (sk==='output'&&['input','drive-input'].includes(tk))||(sk==='power'&&(tk==='drive-input'||tk==='power-input'))||(sk==='ground'&&tk==='ground-input')}
 function wireValid(s,w){if(!w)return false;const a=s.nodes.find(n=>n.id===w.from),b=s.nodes.find(n=>n.id===w.to);return !!a&&!!b&&a!==b&&Number.isInteger(w.pin)&&w.pin>=0&&Number.isInteger(w.toPin??0)&&(w.toPin??0)>=0&&sourceKind(kind(s,a,w.pin))&&['input','drive-input','power-input','ground-input'].includes(kind(s,b,w.toPin??0))&&accepts(s,a,b,w.pin,w.toPin??0)}
 function valid(s){
  if(!s||!text(s.name,60)||!Array.isArray(s.nodes)||s.nodes.length>150||!Array.isArray(s.wires)||s.wires.length>600)return false;
  const boards=s.boards??[];if(!Array.isArray(boards)||boards.length>32||!boards.every(boardValid)||!unique(boards.map(b=>b.id))||boards.reduce((sum,b)=>sum+b.image.length,0)>3000000)return false;
  if(!s.nodes.every(n=>n&&id(n.id)&&ComponentRegistry.types().includes(n.type)&&Number.isFinite(n.x)&&Math.abs(n.x)<100000&&Number.isFinite(n.y)&&Math.abs(n.y)<100000&&Array.isArray(n.modes)&&(n.type==='board'?n.modes.length===board(s,n)?.pins.length:n.type==='esp8266'?n.modes.length===espPinDefs().length:ComponentRegistry.get(n.type)?.renderer==='generic'?[4,pins(s,n).length].includes(n.modes.length):n.modes.length===4)&&n.modes.every(m=>['low','high','blink'].includes(m))&&Number.isFinite(n.period)&&n.period>=.2&&n.period<=5&&firmwareValid(n.firmware)&&(n.pinDirections===undefined||(n.type==='esp8266'&&Array.isArray(n.pinDirections)&&n.pinDirections.length===espPinDefs().length&&n.pinDirections.every((k,i)=>espPinDefs()[i].gpio!=null?['input','output'].includes(k):k===espPinDefs()[i].kind)))&&(n.type!=='board'||!!board(s,n))))return false;
  if(s.nodes.filter(n=>firmwareTarget(s,n)).length>4||s.nodes.reduce((sum,n)=>sum+(n.firmware?.b64?.length||0),0)>3000000)return false;
  return unique(s.nodes.map(n=>n.id))&&s.wires.every(w=>wireValid(s,w))&&unique(s.wires.map(targetKey));
 }
 function output(s,n,p,started,elapsed,firmwareRead){if(!started||!n)return false;const k=kind(s,n,p);if(k==='power')return true;if(k!=='output')return false;if(firmwareTarget(s,n))return firmwareRead?!!firmwareRead(n,p):false;return n.modes[p]==='high'||(n.modes[p]==='blink'&&elapsed%(n.period*1000)<n.period*500)}
 function input(s,n,p,started,elapsed,firmwareRead){const w=s.wires.find(w=>w.to===n.id&&(w.toPin??0)===p);return w?output(s,s.nodes.find(n=>n.id===w.from),w.pin,started,elapsed,firmwareRead):false}
 function connection(s,one,two){const a=s.nodes.find(n=>n.id===one.id),b=s.nodes.find(n=>n.id===two.id);if(!a||!b||a===b)return null;let from,to;if(accepts(s,a,b,one.pin,two.pin)){from=one;to=two}else if(accepts(s,b,a,two.pin,one.pin)){from=two;to=one}else return null;return {from:from.id,pin:pinIndex(from.pin),to:to.id,toPin:pinIndex(to.pin)}}
 function replaceBoard(s,next){const old=s.boards.find(b=>b.id===next.id);if(!old){s.boards.push(next);return}const nodes=s.nodes.filter(n=>n.type==='board'&&n.boardId===next.id),ids=new Set(nodes.map(n=>n.id));const remap=i=>next.pins.findIndex(p=>p.id===old.pins[i]?.id);s.wires=s.wires.flatMap(w=>{const v={...w};if(ids.has(v.from))v.pin=remap(v.pin);if(ids.has(v.to))v.toPin=remap(v.toPin??0);return v.pin<0||(v.toPin??0)<0?[]:[v]});for(const n of nodes)n.modes=next.pins.map(p=>n.modes[old.pins.findIndex(k=>k.id===p.id)]||'low');s.boards[s.boards.indexOf(old)]=next;s.wires=s.wires.filter(w=>wireValid(s,w))}
 return {boardValid,valid,get espPins(){return espPinDefs()},firmwareTarget,firmwareValid,board,pins,kind,sourceKind,targetKey,wireValid,output,input,connection,replaceBoard};
})();
if(typeof module!=='undefined')module.exports=RobotModel;
