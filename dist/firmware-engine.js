/* Robot Canvas adapter for the CC0 ESP8266 core from emulators.org. */
'use strict';
const FirmwareEngine=(()=>{
 const MAX_IMAGE=2*1024*1024;
 const read32=(d,o)=>(d[o]|d[o+1]<<8|d[o+2]<<16|d[o+3]<<24)>>>0;
 function parseImage(d){
  if(!(d instanceof Uint8Array)||d.length<16||d.length>MAX_IMAGE)throw Error('Choose an ESP8266 flash image between 16 bytes and 2 MB.');
  if(d[0]!==0xe9)throw Error('Unsupported image format. Use an ESP8266 v1 image flashed at offset 0 (0xE9 header), such as the ESP8266 MicroPython image.');
  const count=d[1],entry=read32(d,4),segments=[];if(count<1||count>16)throw Error('Invalid ESP8266 segment count.');
  let pos=8,checksum=0xef;
  for(let i=0;i<count;i++){
   if(pos+8>d.length)throw Error('Truncated firmware segment header.');const address=read32(d,pos),size=read32(d,pos+4);pos+=8;
   if(size>d.length-pos)throw Error('Truncated firmware segment.');
   const end=address+size,valid=(address>=0x40100000&&end<=0x40108000)||(address>=0x3ffe8000&&end<=0x40000000);
   if(!valid||size===0)throw Error('Firmware uses an unsupported load address.');
   segments.push({address,offset:pos,size});for(let j=pos;j<pos+size;j++)checksum^=d[j];pos+=size;
  }
  const at=(Math.floor(pos/16)*16)+15;if(at>=d.length||d[at]!==checksum)throw Error('Firmware checksum failed; the image may be corrupt.');
  if(!segments.some(s=>entry>=s.address&&entry<s.address+s.size&&s.address>=0x40100000))throw Error('Firmware entry point is outside its loaded code.');
  return {entry,segments};
 }
 function decode(b64){const raw=atob(b64),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}
 function create(spec,emit=()=>{}){
  const sys=globalThis.ESP8266.createSystem();let rom=null,data,image,steps=0;
  const uart=b=>emit(b&255);
  if(spec.preset==='blink'){
   const fw=globalThis.ESP8266_FW_BLINK;data=decode(fw.b64);sys.loadImage(data,fw.loadAddr);sys.setEntry(fw.entry);sys.onUartTx=uart;
  }else{
   data=decode(spec.preset==='micropython'?globalThis.ESP8266_FW_MICROPYTHON.b64:spec.b64);image=parseImage(data);
   rom=globalThis.ESP8266_ROMHLE.makeRomHle({sys,uartPut:uart,log:()=>{},onChipReset:()=>reset(true)});
   sys.mem.flash.fill(255);sys.mem.flash.set(data);sys.mem.flash[3]=(data[3]&15)|0x40;
   function reset(inside=false){sys.reset(inside);sys.mem.sramI.fill(0);sys.mem.sramD.fill(0);rom.__reset(!inside);for(const s of image.segments)sys.loadImage(data.subarray(s.offset,s.offset+s.size),s.address);rom.__installRomData();sys.setEntry(image.entry);sys.setSp(0x3ffffff0)}
   sys.onUartTx=uart;sys.setRomHook(pc=>{if(pc===rom.__IRQ_RETURN){rom.__irqReturn();return true}const handler=rom[globalThis.ESP8266_ROMSYM[pc>>>0]];if(handler)return handler();sys.setAr(2,0);return false});reset();
  }
  return {sys,step(count=1){for(let i=0;i<count;i++){sys.step();if((++steps&1023)===0)rom?.__pumpIrq();if(sys.isHalted())throw Error('Firmware halted at 0x'+sys.getPc().toString(16)+'. This image may require unsupported instructions or peripherals.')}},send(text){if(sys.rxfifoLen()+text.length>4096)throw Error('Serial input buffer is full. Run the firmware before sending more.');for(const ch of text)sys.feedRx(ch.charCodeAt(0))},inputs(mask,value){sys.setExternalInputs(mask,value)},outputs(){return {out:(sys.gpio.out|((sys.getPeri(0x60000768)&1)<<16))>>>0,enable:(sys.gpio.enable|((sys.getPeri(0x60000774)&1)<<16))>>>0,pc:sys.getPc(),instructions:sys.getInstret(),us:sys.getUs()}}};
 }
 return {parseImage,create,decode};
})();
if(typeof module!=='undefined')module.exports=FirmwareEngine;
