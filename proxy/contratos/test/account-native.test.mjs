import test from 'node:test';
import assert from 'node:assert/strict';
import {readAccountConnectionResponse,readAccountLoginResponse,readAccountRetryAfter} from '../account-native.js';

const now=100_000;
const id='123e4567-e89b-42d3-a456-426614174000';
const https=`https://app.uptokey.com/api/account/native/authorize?id=${id}`;

test('shares the canonical native login and existing-session envelope',()=>{
 assert.deepEqual(readAccountLoginResponse({loginUrl:https,userCode:'123E4567',expiresAt:now+60_000},{now,expectedOrigin:'https://app.uptokey.com'}),{loginUrl:https,userCode:'123E4567',expiresAt:now+60_000});
 const session={authenticated:true};assert.deepEqual(readAccountLoginResponse({session}),{session});
});

test('admits HTTPS and loopback authorize URLs but no alternate authority or hidden input',()=>{
 const login=(loginUrl,extra={})=>readAccountLoginResponse({loginUrl,userCode:'123E4567',expiresAt:now+60_000,...extra},{now});
 assert.equal(login(`http://localhost:21435/api/account/native/authorize?id=${id}`).loginUrl,`http://localhost:21435/api/account/native/authorize?id=${id}`);
 for(const loginUrl of [`http://remote.test/api/account/native/authorize?id=${id}`,`https://user:secret@app.uptokey.com/api/account/native/authorize?id=${id}`,`${https}&token=secret`,`${https}&id=${id}`,`${https}#fragment`])assert.throws(()=>login(loginUrl),/account_response_invalid/);
 assert.throws(()=>login(https,{privateKey:'secret'}),/account_response_invalid/);
 assert.throws(()=>readAccountLoginResponse({loginUrl:https,userCode:'12ZZ4567',expiresAt:now+60_000},{now}),/account_response_invalid/);
 assert.throws(()=>readAccountLoginResponse({loginUrl:https,userCode:'123E4567',expiresAt:now+360_001},{now}),/account_response_invalid/);
 assert.throws(()=>readAccountLoginResponse({loginUrl:https,userCode:'123E4567',expiresAt:now+60_000},{now,expectedOrigin:'https://other.test'}),/account_response_invalid/);
});

test('reuses an authenticated grant with its longer session expiry',()=>{
 const value={loginUrl:https,expiresAt:now+86_400_000};
 assert.deepEqual(readAccountConnectionResponse(value,{now,expectedOrigin:'https://app.uptokey.com'}),value);
 for(const bad of [{...value,expiresAt:now},{...value,privateKey:'secret'},{...value,loginUrl:https+'&token=secret'}])assert.throws(()=>readAccountConnectionResponse(bad,{now}),/account_response_invalid/);
});

test('bounds retry advice without importing transport state',()=>{
 assert.equal(readAccountRetryAfter('9',now),9000);assert.equal(readAccountRetryAfter('0',now),4000);assert.equal(readAccountRetryAfter('999999',now),360000);assert.equal(readAccountRetryAfter(new Date(now+10_000).toUTCString(),now),10000);assert.equal(readAccountRetryAfter('invalid',now),4000);
});
