'use strict';
window.Wiring=(()=>{
 const ns='http://www.w3.org/2000/svg',overlay=document.createElementNS(ns,'svg'),preview=document.createElementNS(ns,'path');
 overlay.id='wirePreview';overlay.setAttribute('width','1');overlay.setAttribute('height','1');overlay.setAttribute('aria-hidden','true');preview.setAttribute('class','wire-preview');overlay.append(preview);world.append(overlay);overlay.setAttribute('hidden','');
 let gesture=null,ignoreClickUntil=0;
 const endpoint=el=>({id:el.closest('.node').dataset.id,pin:el.dataset.pin});
 const pins=()=>[...document.querySelectorAll('#nodes button.pin')];
 function clearHighlights(){for(const p of pins())p.classList.remove('wire-source','wire-compatible','wire-target','wire-invalid','pending')}
 function highlight(from){clearHighlights();for(const p of pins()){const ep=endpoint(p);if(ep.id===from.id&&String(ep.pin)===String(from.pin))p.classList.add('wire-source');else if(RobotModel.connection(state,from,ep))p.classList.add('wire-compatible')}}
 function cancel(){const current=gesture;gesture=null;overlay.setAttribute('hidden','');preview.removeAttribute('d');clearHighlights();viewport.classList.remove('wire-dragging');if(current){ignoreClickUntil=performance.now()+500;try{if(viewport.hasPointerCapture?.(current.pointerId))viewport.releasePointerCapture(current.pointerId)}catch{}}}
 function targetAt(x,y,source,pointerType){
  const hit=document.elementFromPoint?.(x,y);if(hit&&!viewport.contains(hit))return null;
  const direct=hit?.closest('#nodes button.pin');if(direct)return direct;
  const vr=viewport.getBoundingClientRect();if(x<vr.left||x>vr.right||y<vr.top||y>vr.bottom)return null;
  const radius=pointerType==='touch'?26:17;let nearest=null,best=radius;
  for(const p of pins()){if(!RobotModel.connection(state,source,endpoint(p)))continue;const r=p.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;if(cx<vr.left||cx>vr.right||cy<vr.top||cy>vr.bottom)continue;const distance=Math.hypot(x-cx,y-cy);if(distance<best){nearest=p;best=distance}}
  return nearest;
 }
 function update(x,y){if(!gesture)return;const g=gesture;g.moved||=Math.hypot(x-g.startX,y-g.startY)>5;g.x=x;g.y=y;const target=targetAt(x,y,g.source,g.pointerType),connection=target&&RobotModel.connection(state,g.source,endpoint(target));g.target=target;g.valid=!!connection;
  for(const p of pins())p.classList.remove('wire-target','wire-invalid');if(target&&target!==g.element)target.classList.add(g.valid?'wire-target':'wire-invalid');
  const a=pinPoint(g.element),origin=world.getBoundingClientRect(),b=g.valid?pinPoint(target):{x:(x-origin.left)/zoom,y:(y-origin.top)/zoom};
  const n=state.nodes.find(n=>n.id===g.source.id);preview.setAttribute('d',RobotModel.kind(state,n,g.source.pin)==='input'?wireCurve(b,a):wireCurve(a,b));preview.classList.toggle('snapped',g.valid);preview.classList.toggle('invalid',!!target&&!g.valid&&target!==g.element);
 }
 viewport.addEventListener('pointerdown',e=>{
  const pin=e.target.closest('#nodes button.pin');if(!pin||e.button!==0||e.isPrimary===false)return;e.preventDefault();e.stopImmediatePropagation();cancel();ignoreClickUntil=0;
  gesture={source:endpoint(pin),element:pin,pointerId:e.pointerId,pointerType:e.pointerType,startX:e.clientX,startY:e.clientY,x:e.clientX,y:e.clientY,moved:false,target:null,valid:false};highlight(gesture.source);overlay.removeAttribute('hidden');viewport.classList.add('wire-dragging');try{viewport.setPointerCapture(e.pointerId)}catch{}update(e.clientX,e.clientY);
 },true);
 viewport.addEventListener('pointermove',e=>{if(!gesture||gesture.pointerId!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();update(e.clientX,e.clientY)},true);
 viewport.addEventListener('pointerup',e=>{
  if(!gesture||gesture.pointerId!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();update(e.clientX,e.clientY);const g=gesture,drop=g.valid?endpoint(g.target):null;cancel();ignoreClickUntil=performance.now()+500;
  if(g.moved){pending=null;if(drop)commitConnection(g.source,drop);else{render();toast('Wire cancelled. Drop onto a highlighted input or output pin.')}}else connect(g.source.id,g.source.pin);
 },true);
 for(const name of ['pointercancel','lostpointercapture'])viewport.addEventListener(name,e=>{if(gesture?.pointerId!==e.pointerId)return;e.stopImmediatePropagation();cancel();pending=null},true);
 viewport.addEventListener('wheel',e=>{if(gesture){e.preventDefault();e.stopImmediatePropagation()}}, {capture:true,passive:false});
 $('#nodes').addEventListener('click',e=>{const pin=e.target.closest('button.pin');if(!pin)return;e.preventDefault();e.stopPropagation();if(e.detail!==0&&performance.now()<ignoreClickUntil)return;connect(endpoint(pin).id,pin.dataset.pin)});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(gesture||pending)){e.preventDefault();e.stopImmediatePropagation();cancel();pending=null;render()}},true);
 window.addEventListener('blur',()=>{cancel();pending=null});
 return {cancel,highlight};
})();
