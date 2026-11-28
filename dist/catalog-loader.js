'use strict';
(()=>{
 const endpoint=window.COMPONENT_CATALOG_ENDPOINT||(window.CANVAS_AI_ENDPOINT?new URL(window.CANVAS_AI_ENDPOINT,location.href).origin+'/api/components':'/api/components');
 const templatesEndpoint=new URL(endpoint,location.href).origin+'/api/templates';
 let previous='',previousTemplates='',componentsEtag='',templatesEtag='',lastCheck=0;
 async function refreshTemplates(){
  try{
   const headers={Accept:'application/json'};
   if(templatesEtag)headers['If-None-Match']=templatesEtag;
   const response=await fetch(templatesEndpoint,{headers,cache:'no-cache'});
   if(response.status===304)return;
   if(!response.ok)return;
   const nextEtag=response.headers?.get?.('etag')||'';
   if(nextEtag)templatesEtag=nextEtag;
   const data=await response.json();
   if(!Array.isArray(data.templates))return;
   const signature=JSON.stringify(data.templates);
   if(signature!==previousTemplates){window.refreshTemplates?.(data.templates);previousTemplates=signature}
  }catch{}
 }
 async function refresh(force=false){
  if(!force&&document.hidden)return;
  lastCheck=Date.now();
  try{
   const headers={Accept:'application/json'};
   if(componentsEtag)headers['If-None-Match']=componentsEtag;
   const response=await fetch(endpoint,{headers,cache:'no-cache'});
   if(response.status===304){refreshTemplates();return}
   if(!response.ok)throw Error(`Catalog request failed (${response.status})`);
   const nextEtag=response.headers?.get?.('etag')||'';
   if(nextEtag)componentsEtag=nextEtag;
   const data=await response.json();
   if(!Array.isArray(data.definitions)||!data.definitions.length)throw Error('Catalog is empty');
   const signature=JSON.stringify(data.definitions);
   if(signature!==previous){window.refreshComponentRegistry(data.definitions);previous=signature}
  }catch(error){
   if(!previous){console.info('Component catalog unavailable:',error.message);const status=document.querySelector('#noResults');if(status){status.textContent='Component catalog unavailable. Check the server and database configuration.';status.hidden=false}}
  }
  refreshTemplates();
 }
 refresh(true);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastCheck>=15000)refresh(true)});
 window.setInterval(()=>refresh(false),15000);
})();
