'use strict';
(()=>{
 const endpoint=window.COMPONENT_CATALOG_ENDPOINT||(window.CANVAS_AI_ENDPOINT?new URL(window.CANVAS_AI_ENDPOINT,location.href).origin+'/api/components':'/api/components');
 let previous='',lastCheck=0;
 async function refresh(force=false){
  if(!force&&document.hidden)return;
  lastCheck=Date.now();
  try{
   const response=await fetch(endpoint,{headers:{Accept:'application/json'},cache:'no-store'});
   if(!response.ok)throw Error(`Catalog request failed (${response.status})`);
   const data=await response.json();
   if(!Array.isArray(data.definitions)||!data.definitions.length)throw Error('Catalog is empty');
   const signature=JSON.stringify(data.definitions);
   if(signature!==previous){window.refreshComponentRegistry(data.definitions);previous=signature}
  }catch(error){
   if(!previous){console.info('Component catalog unavailable:',error.message);const status=document.querySelector('#noResults');if(status){status.textContent='Component catalog unavailable. Check the server and database configuration.';status.hidden=false}}
  }
 }
 refresh(true);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastCheck>=15000)refresh(true)});
 window.setInterval(()=>refresh(false),15000);
})();
