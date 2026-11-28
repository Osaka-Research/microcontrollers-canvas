'use strict';
window.Firmware=(()=>{
 const sessions=new Map();let lastInputTime=0,lastPanelTime=0;
 const config=n=>n.firmware||{preset:'blink'};
 function appendSerial(s,text){for(const ch of text){const b=ch.charCodeAt(0);if(s.escape===1){s.escape=b===91?2:0;continue}if(s.escape===2){if(b>=64&&b<=126)s.escape=0;continue}if(b===27){s.escape=1;continue}if(b===13)continue;if(b===8||b===127){s.log=s.log.slice(0,-1);continue}if(b===10||b===9||b>=32)s.log+=ch}if(s.log.length>20000)s.log=s.log.slice(-16000)}
 function destroy(id){const s=sessions.get(id);s?.worker?.terminate();sessions.delete(id)}
 function sync(){
  const nodes=state.nodes.filter(n=>RobotModel.firmwareTarget(state,n));for(const id of sessions.keys())if(!nodes.some(n=>n.id===id))destroy(id);
  for(const n of nodes){const signature=JSON.stringify(config(n));let s=sessions.get(n.id);if(s&&s.signature!==signature){destroy(n.id);s=null}
   if(!s){s={signature,worker:null,ready:false,playing:false,out:0,enable:0,duty:[],freq:[],pulseUs:[],instructions:0,log:'',escape:0,error:'',status:'Ready',lastInputs:'',lastAdc:null};sessions.set(n.id,s);
    try{if(typeof Worker==='undefined')throw Error('This browser does not support Web Workers.');s.worker=new Worker('firmware-worker.js?v=20261128.1');s.worker.onmessage=({data:m})=>{if(sessions.get(n.id)!==s)return;if(m.type==='error'){s.error=m.message;s.status='Firmware error';s.out=0;s.enable=0;s.duty=[];s.freq=[];s.pulseUs=[];s.playing=false;toast(m.message)}else if(m.type==='state'){s.ready=true;s.out=m.out;s.enable=m.enable;s.duty=m.duty||[];s.freq=m.freq||[];s.pulseUs=m.pulseUs||[];s.instructions=m.instructions;s.pc=m.pc;s.us=m.us;appendSerial(s,m.serial||'');s.status=s.playing?'Running':'Paused'}updateSignals();refreshPanel()};s.worker.onerror=e=>{s.error=e.message||'Could not start the firmware worker.';s.out=0;s.enable=0;s.status='Firmware error';s.playing=false;updateSignals();refreshPanel(true)};s.worker.postMessage({type:'load',firmware:config(n)})}catch(e){s.error=e.message;s.status='Unavailable'}
   }
   if(s.worker&&!s.error&&s.playing!==running){s.playing=running;s.worker.postMessage({type:running?'run':'pause'});s.status=running?'Starting…':'Paused'}
  }
 }
 function read(n,p){const s=sessions.get(n.id),pin=RobotModel.pins(state,n)[p],gpio=pin?.gpio;if(!s||s.error||gpio==null)return false;return !!((s.out&s.enable)&(1<<gpio))}
 function pwm(n,p){
  const s=sessions.get(n.id),pin=RobotModel.pins(state,n)[p],gpio=pin?.gpio;
  if(!s||s.error||gpio==null)return null;
  const bit=!!((s.out&s.enable)&(1<<gpio));
  return {duty:s.duty[gpio]??(bit?1:0),freq:s.freq[gpio]??0,pulseUs:s.pulseUs[gpio]??0};
 }
 function sendInputs(){
  const now=performance.now();if(now-lastInputTime<20)return;lastInputTime=now;
  const driver=RobotModel.driverLookup(state);
  for(const n of state.nodes){
   const s=sessions.get(n.id);if(!s?.worker||s.error)continue;
   let mask=0,value=0,adcIndex=-1;
   const ps=RobotModel.pins(state,n);
   ps.forEach((p,i)=>{
    if(p.id==='A0')adcIndex=i;
    if(p.kind!=='input'||p.gpio==null||!driver(n,i))return;
    mask|=1<<p.gpio;
    if(RobotModel.input(state,n,i,started,elapsed,read,driver))value|=1<<p.gpio;
   });
   const key=mask+':'+value;
   if(key!==s.lastInputs){s.lastInputs=key;s.worker.postMessage({type:'inputs',mask,value})}
   if(adcIndex>=0){
    const adcVal=Math.round(RobotModel.analogInput(state,n,adcIndex,started,elapsed,read,pwm,driver)*1000)/1000;
    if(adcVal!==s.lastAdc){s.lastAdc=adcVal;s.worker.postMessage({type:'adc',value:adcVal})}
   }
  }
 }
 function reset(id){destroy(id);sync();refreshPanel(true);toast('Firmware restarted. Runtime files and serial output were cleared.')}
 function send(id,text){const s=sessions.get(id);if(!s?.worker||s.error)return toast('The firmware runtime is unavailable.');if(!running)return toast('Run the simulation before sending serial input.');s.worker.postMessage({type:'serial',text})}
 function refreshPanel(force=false){const now=performance.now();if(!force&&now-lastPanelTime<100)return;lastPanelTime=now;const s=sessions.get(selected);if(!s)return;const status=$('#firmwareStatus');if(status)status.textContent=s.error||`${s.status} · ${Math.round((s.instructions||0)/1000)}k instructions`;const consoleEl=$('#serialOutput');if(consoleEl&&consoleEl.textContent!==s.log){const bottom=consoleEl.scrollHeight-consoleEl.scrollTop-consoleEl.clientHeight<25;consoleEl.textContent=s.log||'Run simulation to start the firmware.';if(bottom)consoleEl.scrollTop=consoleEl.scrollHeight}}
 window.addEventListener('beforeunload',()=>{for(const id of sessions.keys())destroy(id)});
 return {sync,read,pwm,sendInputs,reset,send,refreshPanel,clear(id){const s=sessions.get(id);if(s)s.log='';refreshPanel(true)}};
})();
const microPythonExamples={
 blink:'from machine import Pin\nimport time\n\nled = Pin(2, Pin.OUT)\nfor _ in range(4):\n    led.value(1)\n    time.sleep_ms(300)\n    led.value(0)\n    time.sleep_ms(300)',
 pwmFade:'from machine import Pin, PWM\nimport time\n\nled = PWM(Pin(2), freq=200, duty=0)\nfor d in (128, 384, 768, 1023, 512, 128):\n    led.duty(d)\n    print("duty:", d)\n    time.sleep_ms(400)',
 potServo:'from machine import Pin, PWM, ADC\nimport time\n\nadc = ADC(0)\nservo = PWM(Pin(2), freq=50, duty=77)\nfor _ in range(12):\n    val = adc.read()\n    duty = int(26 + (val / 1024) * 102)\n    servo.duty(duty)\n    print("ADC:", val, "duty:", duty)\n    time.sleep_ms(300)',
 buzzerTone:'from machine import Pin, PWM\nimport time\n\nbuz = PWM(Pin(2), freq=440, duty=512)\nfor f in (440, 523, 587, 659, 784):\n    buz.freq(f)\n    print("Hz:", f)\n    time.sleep_ms(300)\nbuz.duty(0)'
};
const defaultMicroPythonScript=microPythonExamples.blink;
function firmwareInspector(n){
 const pins=RobotModel.pins(state,n),preset=n.firmware?.preset||'blink';
 $('#inspectorContent').innerHTML=`<h2 class="inspect-name">${esc(nodeName(n))}</h2><span class="firmware-tag">ESP8266 · PWM + ADC + MICROPYTHON</span><label class="field-label" for="firmwarePreset">FIRMWARE</label><select id="firmwarePreset" class="firmware-select"><option value="blink" ${preset==='blink'?'selected':''}>Blink · D4 / GPIO2</option><option value="micropython" ${preset==='micropython'?'selected':''}>MicroPython v1.23.0</option>${preset==='uploaded'?`<option value="uploaded" selected>${esc(n.firmware.name)}</option>`:''}</select><label class="upload-button outlined firmware-upload">↑ Load firmware .bin<input id="firmwareFile" type="file" accept=".bin,application/octet-stream" hidden></label><p class="inspect-help">Uploads: ESP8266 v1 images at flash offset 0, up to 2 MB. Arduino and NodeMCU Lua builds are unverified.</p><div id="firmwareStatus" class="reading">Ready</div><div class="firmware-buttons"><button id="resetFirmware" class="remove-wire">Reset CPU</button><button id="clearSerial" class="remove-wire">Clear console</button></div><label class="field-label" for="serialOutput">SERIAL CONSOLE · UART0</label><pre id="serialOutput" tabindex="0" aria-label="Serial output">Run simulation to start the firmware.</pre><form id="serialForm"><input id="serialInput" aria-label="Serial input" placeholder="e.g. print(2+2)" maxlength="2048" autocomplete="off"><button class="outlined" type="submit">Send</button></form><div class="firmware-buttons"><button id="serialInterrupt" class="remove-wire">Ctrl+C</button>${preset==='micropython'?'<button id="pythonPinHigh" class="remove-wire">D4 High</button><button id="pythonPinLow" class="remove-wire">D4 Low</button>':''}</div>${preset==='micropython'?`<label class="field-label" for="pythonScript">MICROPYTHON SCRIPT</label><div class="firmware-buttons"><button type="button" class="remove-wire" data-py-example="blink">Blink</button><button type="button" class="remove-wire" data-py-example="pwmFade">PWM Fade</button><button type="button" class="remove-wire" data-py-example="potServo">Pot→Servo</button><button type="button" class="remove-wire" data-py-example="buzzerTone">Melody</button></div><textarea id="pythonScript" class="python-script" rows="6" spellcheck="false" maxlength="1900" aria-label="MicroPython script">${esc(n._script??defaultMicroPythonScript)}</textarea><div class="firmware-buttons"><button type="button" id="runPythonScript" class="outlined">▶ Run script on board</button></div>`:''}<p class="inspect-help">For MicroPython, wait for &gt;&gt;&gt;. D4 is GPIO2, A0 reads Potentiometer (0–1024), and PWM drives LED brightness, servo angle, and buzzer tones.</p><details class="firmware-pin-details"><summary>Pin mapping & connections</summary>${pins.map((p,i)=>`<div class="signal-row"><span>${esc(p.name)}<small class="pin-kind">${p.gpio!=null?'GPIO'+p.gpio:esc(p.kind)}</small></span>${n.type==='esp8266'&&p.gpio!=null?`<select data-direction="${i}" aria-label="${esc(p.name)} canvas direction"><option value="output" ${p.kind==='output'?'selected':''}>Output</option><option value="input" ${p.kind==='input'?'selected':''}>Input</option></select>`:`<span>${esc(p.kind)}</span>`}</div>`).join('')}<p class="inspect-help">Canvas direction controls wiring. Configure the corresponding pin direction in your firmware too.</p></details><p class="firmware-limits">Supports GPIO, FRC1 hardware PWM, UART0 REPL, and A0 ADC. No Wi-Fi, GPIO interrupts, or external I²C/SPI yet. <a href="vendor/esp8266/NOTICE.txt" target="_blank" rel="noopener">Runtime details & credits</a></p>${n.type==='board'?'<button class="remove-wire" id="editThisBoard">Edit image & GPIO mapping</button>':''}<button class="remove-wire" id="disconnectFirmware">Disconnect all</button><button class="remove-wire" id="removeSelected">Remove component</button>`;
 $('#firmwarePreset').onchange=e=>{snapshot();n.firmware={preset:e.target.value};render()};
 $('#resetFirmware').onclick=()=>Firmware.reset(n.id);$('#clearSerial').onclick=()=>Firmware.clear(n.id);$('#serialInterrupt').onclick=()=>Firmware.send(n.id,'\x03');
 $('#serialForm').onsubmit=e=>{e.preventDefault();const field=$('#serialInput');Firmware.send(n.id,field.value+'\r');if(running)field.value=''};
 if($('#pythonPinHigh')){$('#pythonPinHigh').onclick=()=>Firmware.send(n.id,'from machine import Pin; Pin(2, Pin.OUT).value(1)\r');$('#pythonPinLow').onclick=()=>Firmware.send(n.id,'from machine import Pin; Pin(2, Pin.OUT).value(0)\r')}
 document.querySelectorAll('[data-py-example]').forEach(btn=>btn.onclick=()=>{const code=microPythonExamples[btn.dataset.pyExample];if(!code||!$('#pythonScript'))return;n._script=code;$('#pythonScript').value=code});
 if($('#pythonScript')){$('#pythonScript').oninput=e=>{n._script=e.target.value};$('#runPythonScript').onclick=()=>{const code=$('#pythonScript').value.replace(/\r\n/g,'\n').trim();if(!code)return;Firmware.send(n.id,'\x05'+code.replace(/\n/g,'\r')+'\r\x04')}}
 $('#firmwareFile').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>2*1024*1024)throw Error('Firmware must be at most 2 MB.');const bytes=new Uint8Array(await file.arrayBuffer());FirmwareEngine.parseImage(bytes);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));const b64=btoa(binary);if(!state.nodes.includes(n))return;const total=state.nodes.filter(k=>k!==n).reduce((sum,k)=>sum+(k.firmware?.b64?.length||0),0)+b64.length;if(total>3000000)throw Error('Uploaded firmware is limited to 3 MB of encoded data per project.');snapshot();n.firmware={preset:'uploaded',name:file.name.slice(0,120),b64};render();toast('Firmware loaded. Compatibility depends on its peripherals.')}catch(err){toast(err.message)}e.target.value=''};
 document.querySelectorAll('[data-direction]').forEach(el=>el.onchange=()=>{snapshot();n.pinDirections=pins.map(p=>p.kind);n.pinDirections[+el.dataset.direction]=el.value;state.wires=state.wires.filter(w=>RobotModel.wireValid(state,w));pending=null;render();toast('Canvas pin direction updated. Incompatible connections were removed.')});
 if($('#editThisBoard'))$('#editThisBoard').onclick=()=>openBoardEditor(n.boardId);
 $('#disconnectFirmware').onclick=()=>{snapshot();state.wires=state.wires.filter(w=>w.from!==n.id&&w.to!==n.id);render()};$('#removeSelected').onclick=removeSelected;Firmware.refreshPanel(true);
}
Firmware.sync();
