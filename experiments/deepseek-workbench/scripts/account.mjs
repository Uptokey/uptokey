import {requestAccount} from './account-client.mjs';
import {nativeSecret} from './core-bridge-server.mjs';
import {disconnectAccount} from './account-disconnect.mjs';
const action=process.argv[2]??'status';
try{const options={token:nativeSecret('client-token')};console.log(JSON.stringify(await (action==='disconnect'?disconnectAccount(options):requestAccount(action,options))))}
catch{console.log(JSON.stringify({state:'unavailable',authenticated:false}));process.exitCode=1}
