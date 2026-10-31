import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBrowserReadRequest,canonicalBrowserReadPayload,parseBrowserFillRequest,canonicalBrowserFillPayload} from '../browser.js';
test('browser read envelope is immutable and canonical before any navigation',()=>{
  const input={schemaVersion:1,url:'http://127.0.0.1:21439/example'};
  const parsed=parseBrowserReadRequest(input);input.url='http://127.0.0.1:21439/changed';
  assert.equal(parsed.url,'http://127.0.0.1:21439/example');assert.equal(Object.isFrozen(parsed),true);
  assert.equal(canonicalBrowserReadPayload(parsed),'{"schemaVersion":1,"url":"http://127.0.0.1:21439/example"}');
});
test('initial browser profile rejects remote, credentialed and ambiguous targets',()=>{
  for(const url of ['https://example.com/','http://localhost:21439/','http://127.0.0.1/','http://127.0.0.1:80/',
    'http://user:pass@127.0.0.1:21439/','http://127.0.0.1:21439/?token=value','http://127.0.0.1:21439/#target',
    'file:///test','javascript:alert(1)','http://127.0.0.1:21439/a/../b'])
    assert.throws(()=>parseBrowserReadRequest({schemaVersion:1,url}),/browser_read_invalid/);
});
test('browser envelope cannot introduce tool calls, storage state or alternate versions',()=>{
  const valid={schemaVersion:1,url:'http://127.0.0.1:21439/'};
  for(const input of [null,{...valid,schemaVersion:2},{...valid,tool:'browser_evaluate'},{...valid,storageState:'profile'},
    {url:valid.url},Object.create(valid)])assert.throws(()=>parseBrowserReadRequest(input),/browser_read_invalid/);
});

test('fill binds exact labels and values immutably without submission or executable instructions',()=>{
  const input={schemaVersion:1,url:'http://127.0.0.1:21439/form',fields:[{label:'Nome',value:' Ana "teste" '}]};
  const parsed=parseBrowserFillRequest(input);input.fields[0].value='changed';
  assert.equal(parsed.fields[0].value,' Ana "teste" ');assert.equal(Object.isFrozen(parsed.fields[0]),true);
  assert.equal(JSON.parse(canonicalBrowserFillPayload(parsed)).fields[0].value,parsed.fields[0].value);
  for(const bad of [{...parsed,submit:true},{...parsed,code:'page.click()'},{...parsed,fields:[]},
    {...parsed,fields:[parsed.fields[0],parsed.fields[0]]},{...parsed,fields:[{label:'x',value:'\ud800'}]},
    {...parsed,fields:[{label:'x',value:'x'.repeat(2001)}]},
    {...parsed,fields:Array.from({length:8},(_,i)=>({label:String(i),value:'x'.repeat(2000)}))}])
    assert.throws(()=>parseBrowserFillRequest(bad),/browser_fill_invalid/);
});

test('fill rejects accessor arrays and fields without invoking getters',()=>{
  let calls=0;const fields=[];Object.defineProperty(fields,'0',{enumerable:true,get(){calls++;return {label:'x',value:'y'};}});
  const field=Object.defineProperty({label:'x'},'value',{enumerable:true,get(){calls++;return 'y';}});
  for(const items of [fields,[field]])assert.throws(()=>parseBrowserFillRequest({schemaVersion:1,url:'http://127.0.0.1:21439/',fields:items}),/browser_fill_invalid/);
  assert.equal(calls,0);
});
