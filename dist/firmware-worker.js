'use strict';
self.window=self;
importScripts('vendor/esp8266/xtensa-esp8266.js?v=20261124.3','vendor/esp8266/rom-symbols.js?v=20261124.3','vendor/esp8266/rom8266.js?v=20261124.3','vendor/esp8266/firmware/blink.js?v=20261124.3','firmware-engine.js?v=20261124.3');
let machine=null,active=false,timer=null,serial='',last=0,scale=1;
function publish(){if(!machine)return;postMessage({type:'state',...machine.outputs(),serial});serial=''}
function stop(){active=false;clearTimeout(timer);timer=null;last=0}
function fail(e){stop();postMessage({type:'error',message:e.message||String(e)})}
function frame(){if(!active||!machine)return;try{const now=performance.now(),budget=Math.min(last?now-last:16,50)*1000,until=machine.sys.getUs()+budget,before=machine.sys.getInstret();last=now;machine.sys.setInsnScale(scale);let batches=0;do{machine.step(1024);batches++}while(machine.sys.getUs()<until&&performance.now()-now<7&&batches<1000);machine.sys.addUs(Math.max(0,until-machine.sys.getUs()));const want=budget*80/Math.max(1,machine.sys.getInstret()-before);scale+=(Math.min(64,Math.max(1,want))-scale)/4;publish();timer=setTimeout(frame,8)}catch(e){fail(e)}}
onmessage=({data:m})=>{try{
 if(m.type==='load'){stop();machine=null;serial='';scale=1;if(m.firmware.preset==='micropython'&&!self.ESP8266_FW_MICROPYTHON)importScripts('vendor/esp8266/firmware/micropython.js?v=20261124.3');machine=FirmwareEngine.create(m.firmware,b=>{serial+=String.fromCharCode(b);if(serial.length>16000)serial=serial.slice(-12000)});publish()}
 if(m.type==='run'&&machine&&!active){active=true;last=0;frame()}
 if(m.type==='pause'){stop();publish()}
 if(m.type==='serial'&&machine)machine.send(String(m.text).slice(0,2048));
 if(m.type==='inputs'&&machine)machine.inputs(m.mask,m.value);
 }catch(e){fail(e)}};
