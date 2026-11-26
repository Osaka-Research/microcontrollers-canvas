'use strict';
(()=>{
 const $=s=>document.querySelector(s);
 const link=document.createElement('link');link.rel='stylesheet';link.href='ai-builder.css?v=20261126.2';document.head.append(link);
 const main=document.querySelector('main');
 const panel=document.createElement('section');panel.id='aiBuilder';panel.className='ai-builder';panel.setAttribute('aria-label','AI circuit builder');
 panel.innerHTML=`<div class="ai-heading"><div class="ai-title"><span class="ai-spark">✳</span><span><strong>AI circuit builder</strong><small id="aiState">Paste your API key to connect</small></span></div><button type="button" id="aiDisconnect" class="ai-disconnect" hidden>Clear key</button></div><div id="aiMessages" class="ai-messages" aria-live="polite"><div class="ai-message assistant">Paste your OpenAI API key in the box below. Once the server confirms it works, this same box becomes your circuit chat.</div></div><form id="aiForm" class="ai-form"><label class="sr-only" id="aiInputLabel" for="aiPrompt">OpenAI API key</label><input id="aiPrompt" type="password" autocomplete="off" spellcheck="false" maxlength="1200" placeholder="Paste your OpenAI API key" required><button id="aiSend" class="primary" type="submit" aria-label="Check API key">Connect</button></form><div class="ai-note">The key is sent over HTTPS to the project server and held only in this tab. AI can make mistakes; check part ratings before wiring hardware.</div>`;
 main.append(panel);
 const keyStatus=$('#aiState'),disconnect=$('#aiDisconnect'),form=$('#aiForm'),prompt=$('#aiPrompt'),send=$('#aiSend'),messages=$('#aiMessages'),inputLabel=$('#aiInputLabel');
 let apiKey='',busy=false,history=[];
 function addMessage(role,text,sources=[]){const el=document.createElement('div');el.className=`ai-message ${role}`;el.textContent=text;messages.append(el);if(role==='assistant'&&sources.length){const refs=document.createElement('div');refs.className='ai-sources';const label=document.createElement('strong');label.textContent='Research sources';refs.append(label);for(const source of sources.slice(0,5)){if(!source||typeof source.url!=='string'||!/^https:\/\//.test(source.url))continue;const a=document.createElement('a');a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=source.title||new URL(source.url).hostname;refs.append(a)}if(refs.childElementCount>1)messages.append(refs)}messages.scrollTop=messages.scrollHeight}
 function setConnected(){prompt.value='';prompt.type='text';prompt.placeholder='Describe a circuit idea…';inputLabel.textContent='Describe a circuit idea';keyStatus.textContent='API key works · Describe your circuit';disconnect.hidden=false;send.textContent='Build';send.setAttribute('aria-label','Build this idea');panel.classList.add('ai-ready');addMessage('assistant','Your key works. Describe a circuit and I’ll add the supported parts and connections.')}
 disconnect.onclick=()=>{apiKey='';history=[];prompt.value='';prompt.type='password';prompt.placeholder='Paste your OpenAI API key';inputLabel.textContent='OpenAI API key';keyStatus.textContent='Paste your API key to connect';disconnect.hidden=true;send.textContent='Connect';send.setAttribute('aria-label','Check API key');panel.classList.remove('ai-ready');addMessage('assistant','The API key was cleared from this tab. Paste a key to reconnect.')};
 function currentState(){return {components:window.CanvasAI.current()}}
 async function ask(idea){
  const endpoint=window.CANVAS_AI_ENDPOINT||'/api/build';
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'build',apiKey,idea,context:currentState(),history:history.slice(-8)})});
  let data;try{data=await response.json()}catch{throw Error(response.status===404?'No AI server is deployed at this site. Deploy the project server or configure its HTTPS URL in dist/ai-config.js.':'The project server returned an unreadable response.')}
  if(!response.ok)throw Error(data?.error||`The project server could not complete this request (${response.status}).`);
  if(!data?.plan)throw Error('The project server did not return a build plan. Try describing the circuit more simply.');
  if(Array.isArray(data.definitions)&&data.definitions.length){
   const definitions=new Map(ComponentRegistry.all().map(def=>[def.id,def]));
   for(const def of data.definitions)definitions.set(def.id,def);
   window.refreshComponentRegistry([...definitions.values()]);
  }
  const applied=window.CanvasAI.apply(data.plan);return {summary:data.plan.summary, ...applied,sources:Array.isArray(data.sources)?data.sources:[]};
 }
 async function checkKey(candidate){const endpoint=window.CANVAS_AI_ENDPOINT||'/api/build';const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'check',apiKey:candidate})});let data;try{data=await response.json()}catch{throw Error(response.status===404?'No AI server is deployed at this site. Configure its HTTPS URL in dist/ai-config.js.':'The project server returned an unreadable response.')};if(!response.ok||!data?.valid)throw Error(data?.error||`The project server could not check this key (${response.status}).`)}
 form.onsubmit=async e=>{e.preventDefault();if(busy)return;const value=prompt.value.trim();if(!value)return;
  if(!apiKey){busy=true;send.disabled=true;send.textContent='Checking…';keyStatus.textContent='Checking whether the key works…';try{await checkKey(value);apiKey=value;setConnected()}catch(err){keyStatus.textContent='Could not verify key';addMessage('assistant',`I couldn’t connect that key: ${err.message}`)}finally{busy=false;send.disabled=false;if(!apiKey)send.textContent='Connect';prompt.focus()}return}
  const idea=value;
  prompt.value='';addMessage('user',idea);busy=true;send.disabled=true;send.textContent='Building…';keyStatus.textContent='Thinking and checking connections…';
  try{const result=await ask(idea);const parts=result.added?`${result.added} part${result.added===1?'':'s'}`:'existing parts';const wires=result.connected?` and ${result.connected} connection${result.connected===1?'':'s'}`:'';const note=`${result.summary||'Build added.'} Added ${parts}${wires}. Press Run simulation when you’re ready.`;addMessage('assistant',note,result.sources);history.push({role:'user',content:idea},{role:'assistant',content:note});history=history.slice(-12);keyStatus.textContent='AI ready · Project server'}catch(err){addMessage('assistant',`I couldn’t build that yet: ${err.message}`);keyStatus.textContent='AI ready · Project server'}finally{busy=false;send.disabled=false;send.innerHTML='Build <span>↗</span>';prompt.focus()}
 };
 prompt.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();form.requestSubmit()}});
})();
