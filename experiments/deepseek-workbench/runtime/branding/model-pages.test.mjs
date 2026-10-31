import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('./model-pages.js',import.meta.url),'utf8');
const native=(await readFile(new URL('../../desktop/src/account_bridge.rs',import.meta.url),'utf8')).match(/pub const INITIALIZATION_SCRIPT:&str=r#"([\s\S]*?)"#;/)[1];

function fixture(desktop,lang='en'){
 const slots=[],effects=[],updates=[];let disposed=false;
 const window={UptokeyDesktop:desktop};
 const require=id=>id==='react/jsx-runtime'?{jsx:(type,props)=>({type,props})}:id==='react'?{
  useRef:value=>({current:value}),useState:value=>[value,next=>updates.push({next,disposed})],useEffect:callback=>effects.push(callback),
 }:{Toast:()=>null};
 runInNewContext(source,{window,document:{documentElement:{lang}}});
 const ctx={slots:{inject:(_name,callback)=>{const result=callback();if(result?.next)for(const _ of result){}},register:(entry,render)=>{slots.push({entry,render});return()=>{};}}};
 window.UptokeyHarnessModelPages.apply(ctx,require);
 return{slots,updates,mount:()=>{const clean=effects.splice(0).map(callback=>callback());return()=>{disposed=true;clean.forEach(callback=>callback?.());};}};
}
test('native compatibility object routes model URLs and provider IDs through distinct existing IPC kinds',async()=>{
 const calls=[],window=new EventTarget();window.__TAURI_INTERNALS__={invoke:(...args)=>{calls.push(args);return Promise.resolve();}};
 runInNewContext(native,{window,location:{origin:'http://127.0.0.1:43180'},Event});
 await window.UptokeyDesktop.openModelPage('https://ollama.com/download');
 await window.UptokeyDesktop.openProviderPortal('groq');
 await window.UptokeyDesktop.refreshProviderModels('deepseek');
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[
  ['harness_open_account_page',{url:'https://ollama.com/download',kind:'model'}],
  ['harness_open_account_page',{url:'groq',kind:'provider'}],
  ['harness_refresh_provider_models',{providerId:'deepseek'}],
 ]);
 const wrong=new EventTarget();wrong.__TAURI_INTERNALS__=window.__TAURI_INTERNALS__;
 runInNewContext(native,{window:wrong,location:{origin:'https://other.example'},Event});assert.equal(wrong.UptokeyDesktop,undefined);
});
test('does not add inert model links in a browser without both native methods',()=>{
 for(const desktop of [undefined,{}, {openModelPage(){}}])assert.equal(fixture(desktop).slots.length,0);
});
test('only built-in routes get a portal; custom routes and namespaces never infer one from labels or endpoints',async()=>{
 const calls=[],f=fixture({openModelPage(){},openProviderPortal:id=>{calls.push(id);}});
 assert.deepEqual(f.slots.map(row=>row.entry.key).filter(Boolean),['llm-pi-ai','llm-deepseek']);
 const Portal=f.slots[0].render;
 for(const provider of [undefined,{settingsNs:'custom',provider:'openai'},{settingsNs:'llm-pi-ai',provider:'openai',declared:true},{settingsNs:'llm-pi-ai',provider:'synthetic',displayName:'OpenAI',defaultBaseURL:'https://api.openai.com/v1'},{settingsNs:'llm-pi-ai',provider:'constructor'}])assert.equal(Portal({provider}),null);
 const page=Portal({provider:{settingsNs:'llm-pi-ai',provider:'groq'}}),button=page.props.children[0],nodes=button.type(button.props),dispose=f.mount();
 await nodes[0].props.onClick();assert.deepEqual(calls,['groq']);dispose();
});
test('refreshes provider models in place without adding a settings card',async()=>{
 const calls=[],f=fixture({openModelPage(){},openProviderPortal(){},refreshProviderModels:id=>{calls.push(id);}}),Portal=f.slots[0].render;
 const page=Portal({provider:{settingsNs:'llm-deepseek',provider:'deepseek-official'}});assert.equal(page.type,'div');assert.equal(page.props.children.length,2);
 const refresh=page.props.children[1],nodes=refresh.type(refresh.props),dispose=f.mount();await nodes[0].props.onClick();dispose();assert.deepEqual(calls,['deepseek']);
});
test('local footer passes fixed public destinations and normalized documentation locale only after a click',async()=>{
 const calls=[],f=fixture({openModelPage:url=>{calls.push(url);},openProviderPortal(){}},'pt-BR');
 const Footer=f.slots.find(row=>row.entry.name==='settings.models.footer').render;
 const buttons=Footer().props.children;assert.equal(calls.length,0);assert.equal(buttons.length,4);
 for(const button of buttons){const nodes=button.type(button.props);const dispose=f.mount();await nodes[0].props.onClick();dispose();}
 assert.deepEqual(calls,['https://docs.uptokey.com/pt-br/concepts/local-models/','https://ollama.com/download','https://lmstudio.ai/download','https://jan.ai/download']);
});
test('double clicks coalesce and a disposed button ignores late native rejection',async()=>{
 const pending=Promise.withResolvers();let count=0;
 const f=fixture({openModelPage:()=>{count++;return pending.promise;},openProviderPortal(){}});
 const button=f.slots.find(row=>row.entry.name==='settings.models.footer').render().props.children[0];
 const nodes=button.type(button.props),dispose=f.mount();const first=nodes[0].props.onClick(),second=nodes[0].props.onClick();
 assert.equal(count,1);dispose();pending.reject(new Error('synthetic_sensitive_detail'));await Promise.all([first,second]);
 assert.equal(f.updates.some(row=>row.disposed),false);
});
