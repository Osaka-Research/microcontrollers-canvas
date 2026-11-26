const {parentPort}=require('node:worker_threads');const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
global.self=globalThis;global.onmessage=null;global.postMessage=m=>parentPort.postMessage(m);global.importScripts=(...names)=>{for(const name of names)vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../dist',name.split('?')[0]),'utf8'),{filename:name})};
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../dist/firmware-worker.js'),'utf8'),{filename:'firmware-worker.js'});parentPort.on('message',data=>global.onmessage({data}));
