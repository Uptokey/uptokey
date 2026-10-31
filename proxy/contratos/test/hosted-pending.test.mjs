import test from 'node:test';
import assert from 'node:assert/strict';
import {projectHostedPending} from '../hosted-pending.js';
const row={requestId:'request-1',reservedMicros:10,createdAt:'2026-09-14T10:00:00.000Z',dispatchStartedAt:null};
test('pending projection strips ledger internals and validates bounded public data',()=>{
  assert.deepEqual(projectHostedPending([{...row,prompt:'private',key:'private',walletId:'other'}]),[row]);
  assert.equal(projectHostedPending(undefined),undefined);
  assert.deepEqual(projectHostedPending([]),[]);
  for(const value of [null,{},Array(11).fill(row),[{...row,reservedMicros:-1}],[{...row,createdAt:'invalid'}],[{...row,dispatchStartedAt:0}],[{...row,requestId:'<script>'}]])assert.throws(()=>projectHostedPending(value));
});
