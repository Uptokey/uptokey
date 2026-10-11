import {parentPort,workerData} from 'node:worker_threads';
import Ajv from 'ajv';
if(!parentPort)throw new Error('service_schema_worker_invalid');
const port=parentPort;
port.postMessage({ready:true});
try{
 const Constructor=(Ajv as unknown as {default:typeof import('ajv').Ajv}).default??Ajv;
 const validator=new Constructor({strict:false,allErrors:false,validateFormats:false,addUsedSchema:false});
 port.postMessage({valid:validator.compile(workerData.schema)(workerData.parameters)===true});
}catch{port.postMessage({valid:false});}
finally{port.close();}
