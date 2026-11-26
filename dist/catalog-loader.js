'use strict';
(()=>{
 const endpoint=window.COMPONENT_CATALOG_ENDPOINT||(window.CANVAS_AI_ENDPOINT?new URL(window.CANVAS_AI_ENDPOINT,location.href).origin+'/api/components':'/api/components');
 fetch(endpoint,{headers:{Accept:'application/json'}}).then(async response=>{
  if(!response.ok)throw Error(`Catalog request failed (${response.status})`);
  const data=await response.json();
  if(!Array.isArray(data.definitions)||!data.definitions.length)throw Error('Catalog is empty');
  window.refreshComponentRegistry(data.definitions);
 }).catch(error=>{console.info('Component catalog unavailable:',error.message);const status=document.querySelector('#noResults');if(status){status.textContent='Component catalog unavailable. Check the server and database configuration.';status.hidden=false}});
})();
