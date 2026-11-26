'use strict';
let boardDraft=null,selectedPin=null,draftDirty=false,imageLoading=false,uploadSequence=0,markerDrag=null,suppressStageClick=false;
const editor=$('#boardEditor');
window.renderBoardLibrary=()=>{
 $('#customBoards').innerHTML=state.boards.length?`<div class="category">YOUR BOARDS</div>${state.boards.map(b=>`<div class="custom-board-entry"><button class="part custom-part" data-board="${b.id}" title="Add ${esc(b.name)}"><img src="${b.image}" alt=""><span><strong>${esc(b.name)}</strong><small>${b.pins.length} marked pins</small></span><span class="add">+</span></button><div class="board-library-actions"><button data-edit="${b.id}">Edit pins</button><button data-remove="${b.id}" aria-label="Delete ${esc(b.name)} from library">Delete</button></div></div>`).join('')}`:'';
 $('#customBoards').querySelectorAll('[data-board]').forEach(b=>b.onclick=()=>addBoard(b.dataset.board));
 $('#customBoards').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openBoardEditor(b.dataset.edit));
 $('#customBoards').querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{if(state.nodes.some(n=>n.boardId===b.dataset.remove))return toast('Remove this board’s canvas instances before deleting it from the library.');snapshot();state.boards=state.boards.filter(board=>board.id!==b.dataset.remove);render();toast('Board removed. Undo restores it.')});
 $('#libraryCount').textContent=document.querySelectorAll('#componentLibrary .part').length+state.boards.length;
 if($('#search').value)$('#search').oninput({target:$('#search')});
};
window.openBoardEditor=(id)=>{
 if(!id&&state.boards.length>=32)return toast('You can save up to 32 custom boards per project.');
 const existing=state.boards.find(b=>b.id===id);
 boardDraft=existing?structuredClone(existing):{id:uid(),name:'',image:'',width:0,height:0,pins:[]};selectedPin=boardDraft.pins[0]?.id||null;draftDirty=false;imageLoading=false;uploadSequence++;
 $('#boardRuntime').value=boardDraft.runtime||'logic';$('#boardName').value=boardDraft.name;$('#boardImageFile').value='';$('#editorZoom').value=100;$('#editorZoomLabel').textContent='100%';$('#editorTitle').textContent=existing?'Edit custom board':'Create a custom board';$('#editorError').textContent='';$('#saveBoard').disabled=false;
 editor.showModal();renderEditorImage();renderPinEditor();$('#boardName').focus();
};
function renderEditorImage(){const has=!!boardDraft.image;$('#pinStage').hidden=!has;$('#uploadPlaceholder').hidden=has;if(has){$('#boardPreview').src=boardDraft.image;$('#boardPreview').style.aspectRatio=`${boardDraft.width}/${boardDraft.height}`;setEditorZoom()}else $('#boardPreview').removeAttribute('src')}
function setEditorZoom(){const scale=+$('#editorZoom').value/100;const available=Math.max(180,$('#imageViewport').clientWidth-40);const base=Math.min(680,available);$('#pinStage').style.width=`${base*scale}px`;$('#editorZoomLabel').textContent=`${Math.round(scale*100)}%`}
function renderPinEditor(){
 if(!boardDraft)return;
 $('#pinCount').textContent=boardDraft.pins.length+' / 64';
 $('#pinMarkers').innerHTML=boardDraft.pins.map((p,i)=>`<button type="button" class="editor-pin ${p.kind} ${p.id===selectedPin?'selected':''}" data-marker="${p.id}" style="left:${p.x*100}%;top:${p.y*100}%" title="${esc(p.name)}" aria-label="Move ${esc(p.name)}" aria-pressed="${p.id===selectedPin}">${i+1}</button>`).join('');
 $('#pinList').innerHTML=boardDraft.pins.length?boardDraft.pins.map((p,i)=>`<button type="button" data-select-pin="${p.id}" class="pin-list-item ${p.id===selectedPin?'selected':''}"><span>${i+1}</span><strong>${esc(p.name)}</strong><small>${p.kind}</small></button>`).join(''):'<p class="inspect-help">No pins yet. Upload an image, then click each pin location.</p>';
 const p=boardDraft.pins.find(p=>p.id===selectedPin);$('#pinDetails').hidden=!p;
 if(p){$('#pinName').value=p.name;$('#pinKind').value=p.kind;$('#pinGpio').value=p.gpio??'';$('#pinGpio').disabled=['power','ground'].includes(p.kind);syncCoordinates(p)}
 $('#pinList').querySelectorAll('[data-select-pin]').forEach(b=>b.onclick=()=>{selectedPin=b.dataset.selectPin;renderPinEditor()});
 $('#pinMarkers').querySelectorAll('[data-marker]').forEach(b=>{
  b.onclick=e=>e.stopPropagation();
  b.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();selectedPin=b.dataset.marker;const p=boardDraft.pins.find(p=>p.id===selectedPin);markerDrag={element:b,pin:p,moved:false};b.setPointerCapture(e.pointerId)};
  b.onpointermove=e=>{if(!markerDrag||markerDrag.element!==b)return;const r=$('#pinStage').getBoundingClientRect();markerDrag.pin.x=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));markerDrag.pin.y=Math.max(0,Math.min(1,(e.clientY-r.top)/r.height));b.style.left=markerDrag.pin.x*100+'%';b.style.top=markerDrag.pin.y*100+'%';markerDrag.moved=true;draftDirty=true;syncCoordinates(markerDrag.pin)};
  const finish=e=>{if(!markerDrag||markerDrag.element!==b)return;e.stopPropagation();markerDrag=null;suppressStageClick=true;renderPinEditor();setTimeout(()=>suppressStageClick=false,0)};
  b.onpointerup=finish;b.onpointercancel=finish;
  b.onkeydown=e=>{const deltas={ArrowLeft:[-.001,0],ArrowRight:[.001,0],ArrowUp:[0,-.001],ArrowDown:[0,.001]};if(!deltas[e.key])return;e.preventDefault();selectedPin=b.dataset.marker;const p=boardDraft.pins.find(p=>p.id===selectedPin),d=deltas[e.key],factor=e.shiftKey?10:1;p.x=Math.max(0,Math.min(1,p.x+d[0]*factor));p.y=Math.max(0,Math.min(1,p.y+d[1]*factor));draftDirty=true;renderPinEditor();$('#pinMarkers').querySelector(`[data-marker="${p.id}"]`).focus()};
 });
}
function syncCoordinates(p){$('#pinX').value=(p.x*100).toFixed(1);$('#pinY').value=(p.y*100).toFixed(1)}
function error(message){$('#editorError').textContent=message}
$('#openDev').onclick=()=>openBoardEditor();
$('#boardName').oninput=e=>{boardDraft.name=e.target.value;draftDirty=true};
$('#editorZoom').oninput=setEditorZoom;
$('#boardRuntime').onchange=e=>{boardDraft.runtime=e.target.value;draftDirty=true};
$('#pinGpio').onchange=e=>{const p=boardDraft.pins.find(p=>p.id===selectedPin);if(p){p.gpio=e.target.value===''?null:Number(e.target.value);draftDirty=true}};
$('#pinStage').onclick=e=>{if(suppressStageClick||e.target.closest('.editor-pin')||!boardDraft?.image)return;if(boardDraft.pins.length>=64)return error('Maximum 64 pins per board.');const r=$('#pinStage').getBoundingClientRect();let number=0;while(boardDraft.pins.some(p=>p.name==='D'+number))number++;const p={id:uid(),name:'D'+number,kind:'output',x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};boardDraft.pins.push(p);selectedPin=p.id;draftDirty=true;error('');renderPinEditor()};
$('#pinName').oninput=e=>{const p=boardDraft.pins.find(p=>p.id===selectedPin);if(!p)return;p.name=e.target.value;draftDirty=true;const label=$('#pinList').querySelector(`[data-select-pin="${p.id}"] strong`);if(label)label.textContent=p.name;$('#pinMarkers').querySelector(`[data-marker="${p.id}"]`).title=p.name};
$('#pinKind').onchange=e=>{const p=boardDraft.pins.find(p=>p.id===selectedPin);if(p){p.kind=e.target.value;if(['power','ground'].includes(p.kind))p.gpio=null;draftDirty=true;renderPinEditor()}};
for(const [selector,key] of [['#pinX','x'],['#pinY','y']])$(selector).onchange=e=>{const p=boardDraft.pins.find(p=>p.id===selectedPin);if(!p)return;const value=Number(e.target.value);if(Number.isFinite(value)){p[key]=Math.min(100,Math.max(0,value))/100;draftDirty=true}renderPinEditor()};
$('#removePin').onclick=()=>{const i=boardDraft.pins.findIndex(p=>p.id===selectedPin);if(i<0)return;boardDraft.pins.splice(i,1);selectedPin=boardDraft.pins[Math.max(0,i-1)]?.id||null;draftDirty=true;renderPinEditor()};
$('#boardImageFile').onchange=async e=>{
 const f=e.target.files[0];if(!f)return;const seq=++uploadSequence;error('');
 if(!['image/png','image/jpeg','image/webp'].includes(f.type))return error('Choose a PNG, JPEG, or WebP image.');if(f.size>8*1024*1024)return error('Choose an image smaller than 8 MB.');
 imageLoading=true;$('#saveBoard').disabled=true;error('Preparing image…');const url=URL.createObjectURL(f);
 try{const img=new Image();img.src=url;await img.decode();if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>50000000)throw Error('Image dimensions are too large. Use an image below 50 megapixels.');const canvas=document.createElement('canvas');let scale=Math.min(1,1200/img.naturalWidth,1200/img.naturalHeight),data;
  do{canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);data=canvas.toDataURL('image/png');scale*=.8}while(data.length>750000&&canvas.width>32&&canvas.height>32);
  if(data.length>750000)throw Error('This image is too complex. Try a smaller image.');
  if(seq!==uploadSequence||!editor.open)return;boardDraft.image=data;boardDraft.width=canvas.width;boardDraft.height=canvas.height;draftDirty=true;if(!boardDraft.name){boardDraft.name=f.name.replace(/\.[^.]+$/,'').slice(0,60);$('#boardName').value=boardDraft.name}renderEditorImage();renderPinEditor();error('Image ready. Click the image to mark your pins.');
 }catch(err){if(seq===uploadSequence)error(err.message||'Could not read this image. Try another file.')}finally{URL.revokeObjectURL(url);if(seq===uploadSequence){imageLoading=false;$('#saveBoard').disabled=false}e.target.value=''}
};
function closeEditor(){if(draftDirty&&!confirm('Discard your unsaved board edits?'))return;uploadSequence++;editor.close();boardDraft=null;markerDrag=null;$('#openDev').focus()}
$('#closeEditor').onclick=closeEditor;$('#cancelEditor').onclick=closeEditor;editor.addEventListener('cancel',e=>{e.preventDefault();closeEditor()});
$('#boardForm').onsubmit=e=>{
 e.preventDefault();if(imageLoading)return error('Wait for the image to finish loading.');boardDraft.name=$('#boardName').value.trim();boardDraft.pins.forEach(p=>p.name=p.name.trim());
 if(!boardDraft.image)return error('Upload a board image first.');if(!boardDraft.name)return error('Give your board a name.');if(!boardDraft.pins.length)return error('Mark at least one pin on the image.');if(boardDraft.pins.some(p=>!p.name))return error('Every pin needs a name.');if(new Set(boardDraft.pins.map(p=>p.name.toLowerCase())).size!==boardDraft.pins.length)return error('Use a unique name for every pin.');if(boardDraft.runtime==='esp8266'&&!boardDraft.pins.some(p=>p.gpio!=null))return error('Map at least one pin to its ESP8266 GPIO number.');if(new Set(boardDraft.pins.filter(p=>p.gpio!=null).map(p=>p.gpio)).size!==boardDraft.pins.filter(p=>p.gpio!=null).length)return error('Map each ESP8266 GPIO number only once.');if(!RobotModel.boardValid(boardDraft))return error('Check the image, board name, and pin details.');
 const total=state.boards.filter(b=>b.id!==boardDraft.id).reduce((sum,b)=>sum+b.image.length,0)+boardDraft.image.length;if(total>3000000)return error('This project’s board images exceed 3 MB. Use smaller images or remove unused boards.');
 const candidate=structuredClone(state);RobotModel.replaceBoard(candidate,structuredClone(boardDraft));if(!RobotModel.valid(candidate))return error('The board could not be saved. Check its pin definitions.');
 try{localStorage.setItem('robot-canvas-v1',JSON.stringify(candidate))}catch{return error('Browser storage is full or unavailable. Export your current project, then free some space before saving.')}
 const before=state.wires.length;snapshot();state=candidate;selectedPin=null;pending=null;draftDirty=false;uploadSequence++;editor.close();boardDraft=null;render();toast(before>state.wires.length?'Board saved. Connections to removed or changed pin types were disconnected.':'Board saved. Add it from Your boards in Controls.');$('#openDev').focus();
};
window.addEventListener('resize',()=>{if(editor.open)setEditorZoom()});
renderBoardLibrary();
