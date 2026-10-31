import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseClientKeyPolicy, parseClientKeyView, parseKeyMutation } from '../client-keys.js';

const policy={schemaVersion:1,id:randomUUID(),revision:1,label:'synthetic',principalId:'local',projectIds:[],providerIds:[],modelIds:[],scopes:['models:read'],expiresAt:null,enabled:true};
const metadata={prefixMasked:'utk_local_synthetic',createdAt:'2026-09-25T00:00:00.000Z',lastUsedAt:null,revokedAt:null,usageBasis:'synthetic'};

test('legacy policy and view preserve omission of retentionMode',()=>{
  assert.deepEqual(parseClientKeyPolicy(policy),policy);
  assert.equal(Object.hasOwn(parseClientKeyView({...policy,...metadata}),'retentionMode'),false);
});

test('explicit retention modes survive policy and safe metadata projection',()=>{
  for(const retentionMode of ['standard','ephemeral']){
    assert.equal(parseClientKeyPolicy({...policy,retentionMode}).retentionMode,retentionMode);
    assert.equal(parseClientKeyView({...policy,...metadata,retentionMode}).retentionMode,retentionMode);
  }
});

test('unknown retention values fail closed in policy and view',()=>{
  for(const retentionMode of [null,true,0,'normal','EPHEMERAL','',{},[]]){
    assert.throws(()=>parseClientKeyPolicy({...policy,retentionMode}),/client_key_invalid/);
    assert.throws(()=>parseClientKeyView({...policy,...metadata,retentionMode}),/client_key_invalid/);
  }
});

test('canonical create and update mutations preserve valid retention mode and reject unknown values',()=>{
  for(const retentionMode of ['standard','ephemeral']){
    assert.equal(parseKeyMutation({kind:'create',operationId:randomUUID(),expectedRevision:1,label:'synthetic',scopes:['models:read'],limits:null,retentionMode}).retentionMode,retentionMode);
    assert.equal(parseKeyMutation({kind:'update',operationId:randomUUID(),expectedRevision:1,retentionMode}).retentionMode,retentionMode);
  }
  for(const retentionMode of [null,true,'normal','']){
    assert.throws(()=>parseKeyMutation({kind:'update',operationId:randomUUID(),expectedRevision:1,retentionMode}));
    assert.throws(()=>parseKeyMutation({kind:'create',operationId:randomUUID(),expectedRevision:1,label:'synthetic',scopes:['models:read'],limits:null,retentionMode}));
  }
});
