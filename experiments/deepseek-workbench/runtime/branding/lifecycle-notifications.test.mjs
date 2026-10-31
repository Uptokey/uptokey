import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('./lifecycle-notifications.js',import.meta.url),'utf8');
const brandClient=await readFile(new URL('./client.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function status({running=false,completionUnread=false,pendingInteraction}={}){
 return {running,completionUnread,pendingInteraction};
}
function pending(kind,key=kind){return {kind,key,sessionId:'session'};}
function load(){
 const window=new EventTarget();
 runInNewContext(source,{window,CustomEvent});
 return {window,api:window.UptokeyHarnessLifecycleNotifications};
}

test('projects only authoritative pending and unread-completion edges',()=>{
 const {api}=load(),before=new Map([
  ['done',status({running:true})],
  ['question',status()],
  ['approval',status({pendingInteraction:pending('approval','same')})],
  ['main',status({running:true})],
 ]),after=new Map([
  ['done',status({running:false,completionUnread:true})],
  ['question',status({pendingInteraction:pending('question','q1')})],
  ['approval',status({pendingInteraction:pending('approval','same')})],
  ['plan',status({pendingInteraction:pending('plan-review','p1')})],
  ['main',status({running:false,completionUnread:false})],
 ]);
 assert.deepEqual(plain(api.transitions(before,after)),['session-done','question','question']);
});

test('does not manufacture an error event from unknown or idle state',()=>{
 const {api}=load(),before=new Map([['one',status()]]),after=new Map([
  ['one',status({pendingInteraction:pending('future-kind','f1')})],
  ['two',status({running:false,completionUnread:true})],
 ]);
 assert.deepEqual(plain(api.transitions(before,after)),[]);
});

test('replacement request notifies once and a stable request remains quiet',()=>{
 const {api}=load();
 const first=new Map([['one',status({pendingInteraction:pending('approval','a1')})]]);
 const same=new Map([['one',status({pendingInteraction:pending('approval','a1')})]]);
 const replacement=new Map([['one',status({pendingInteraction:pending('approval','a2')})]]);
 assert.deepEqual(plain(api.transitions(first,same)),[]);
 assert.deepEqual(plain(api.transitions(same,replacement)),['permission']);
});

test('subscribes after baseline, dispatches fixed native-attention detail and tears down',()=>{
 const {window,api}=load(),events=[];let current=new Map([['one',status({running:true})]]),listener,unsubscribed=0,cleanup;
 window.addEventListener('uptokey:native-attention',event=>events.push(event.detail));
 const ctx={uiSession:{sessionStatus:{getSnapshot:()=>current,subscribe:next=>{listener=next;return()=>{listener=undefined;unsubscribed++;};}}},effect:run=>{cleanup=run();}};
 api.apply(ctx);assert.deepEqual(events,[]);
 current=new Map([['one',status({running:false,completionUnread:true})]]);listener();
 assert.deepEqual(plain(events),[{kind:'session-done'}]);
 cleanup();assert.equal(unsubscribed,1);assert.equal(listener,undefined);
 current=new Map([['one',status({pendingInteraction:pending('question','q1')})]]);
 assert.deepEqual(plain(events),[{kind:'session-done'}]);
});

test('maps the authoritative session error event without forwarding its message',()=>{
 const {window,api}=load(),events=[];let listener,cleanup,disposed=0;
 window.addEventListener('uptokey:native-attention',event=>events.push(event.detail));
 const ctx={remote:{$on:(name,next)=>{assert.equal(name,'api-session/error');listener=next;return()=>{listener=undefined;disposed++;};}},effect:run=>{cleanup=run();}};
 api.apply(ctx);assert.deepEqual(events,[]);
 listener('session','provider secret should never cross the native boundary');
 assert.deepEqual(plain(events),[{kind:'error'}]);
 cleanup();assert.equal(disposed,1);assert.equal(listener,undefined);
});

test('is inert without either canonical lifecycle source',()=>{
 const {api}=load();let effects=0;
 api.apply({effect(){effects++;}});api.apply({uiSession:{sessionStatus:{}},effect(){effects++;}});
 assert.equal(effects,0);
});

test('a passive remote cannot break the authoritative status projection',()=>{
 const {window,api}=load(),events=[];let current=new Map([['one',status({running:true})]]),listener,cleanup;
 window.addEventListener('uptokey:native-attention',event=>events.push(event.detail));
 const ctx={
  remote:{$on(){throw new Error('client api: forwarded events require interactions=answer');}},
  uiSession:{sessionStatus:{getSnapshot:()=>current,subscribe:next=>{listener=next;return()=>{listener=undefined;};}}},
  effect:run=>{cleanup=run();},
 };
 api.apply(ctx);
 current=new Map([['one',status({running:false,completionUnread:true})]]);listener();
 assert.deepEqual(plain(events),[{kind:'session-done'}]);
 cleanup();assert.equal(listener,undefined);
});

test('the brand plugin declares the remote gateway before subscribing',()=>{
 assert.match(brandClient,/inject:\['slots','uiSession','remote'\]/);
});
