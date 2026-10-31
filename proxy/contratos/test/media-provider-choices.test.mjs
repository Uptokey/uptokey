import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMediaConfigurationInfo} from '../media-profile.js';

const choice={id:'custom-openai',label:'OpenAI',endpoint:'https://api.openai.com/v1/images/generations',editEndpoint:'https://api.openai.com/v1/images/edits',models:[{id:'openai/gpt-image-1',label:'gpt-image-1'}],modelSource:'catalog',documentationUrl:'https://developers.openai.com/api/reference/resources/images/methods/generate',getKeyUrl:'https://platform.openai.com/api-keys'};
const info={kind:'image',mode:'managed',configured:false,available:false,profileRevision:0,profile:null,connections:[],providers:[choice]};

test('media choices remain optional for old clients and distinguish declared models from account availability',()=>{
 const legacy={...info};delete legacy.providers;assert.equal(parseMediaConfigurationInfo(legacy).providers,undefined);
 const parsed=parseMediaConfigurationInfo(info);assert.equal(parsed.configured,false);assert.equal(parsed.available,false);assert.equal(parsed.providers[0].modelSource,'catalog');assert.equal(parsed.providers[0].models[0].id,'openai/gpt-image-1');
});

test('media discovery metadata cannot cross kind, origin, credential or model boundaries',()=>{
 for(const patch of [
  {endpoint:'https://api.openai.com/v1/audio/speech'},
  {endpoint:'https://key@api.openai.com/v1/images/generations'},
  {endpoint:'https://api.openai.com/v1/images/generations?api_key=synthetic'},
  {editEndpoint:'https://other.example/v1/images/edits'},
  {models:[{id:'openai/gpt-image-1'},{id:'openai/gpt-image-1'}]},
  {models:[{id:'openai/gpt-image-1',secret:'synthetic'}]},
  {getKeyUrl:'http://example.com/keys'},
  {credential:'synthetic'},
 ])assert.throws(()=>parseMediaConfigurationInfo({...info,providers:[{...choice,...patch}]}),/media_profile_invalid/);
 const {id,label,documentationUrl,getKeyUrl,...fields}=choice;
 assert.throws(()=>parseMediaConfigurationInfo({...info,providers:[],connections:[{id:'11111111-1111-4111-8111-111111111111',providerId:id,label,endpointOrigin:'https://other.example',revision:'a'.repeat(64),...fields}]}),/media_profile_invalid/);
});
