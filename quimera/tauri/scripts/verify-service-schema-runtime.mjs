import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

/** Exercise the shipped worker without the developer node_modules or inherited secrets. */
export function verifyServiceSchemaRuntime(runtime, directory) {
  const entry = pathToFileURL(join(directory, 'service-schema-worker.js')).href;
  const script = `
    import assert from 'node:assert/strict';
    import {Worker} from 'node:worker_threads';
    async function probe(schema, parameters, timeoutExpected = false) {
      const worker = new Worker(new URL(${JSON.stringify(entry)}), {
        workerData: {schema, parameters}, env: {}, execArgv: [],
        resourceLimits: {maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2},
        stdout: true, stderr: true,
      });
      worker.stdout.resume(); worker.stderr.resume();
      try {
        return await new Promise((resolve, reject) => {
          let ready = false;
          let timer = setTimeout(() => reject(Error('schema_worker_start_timeout')), 5000);
          worker.on('message', value => {
            if(value?.ready === true && !ready) {
              ready = true; clearTimeout(timer);
              timer = setTimeout(() => timeoutExpected ? resolve('bounded') : reject(Error('schema_worker_timeout')), 500);
            } else if(typeof value?.valid === 'boolean' && ready) { clearTimeout(timer); resolve(value.valid); }
            else { clearTimeout(timer); reject(Error('schema_worker_protocol')); }
          });
          worker.once('error', error => {clearTimeout(timer); reject(error);});
          worker.once('exit', code => {clearTimeout(timer); if(code !== 0) reject(Error('schema_worker_exit'));});
        });
      } finally { await worker.terminate(); }
    }
    const schema = {type: 'object', properties: {value: {type: 'integer'}}, required: ['value'], additionalProperties: false};
    assert.equal(await probe(schema, {value: 1}), true);
    assert.equal(await probe(schema, {value: 'wrong'}), false);
    assert.equal(await probe({type:'object',properties:{value:{type:'string',pattern:'^(a+)+$'}}}, {value:'a'.repeat(48)+'!'}, true), 'bounded');
    console.log(JSON.stringify({passed: 3, failed: 0, packagedWorker: true, pathologicalSchemaTerminated: true}));
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot','windir','path','pathext','temp','tmp'].includes(key.toLowerCase())));
  const result = spawnSync(runtime, ['--input-type=module', '-e', script], {cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 20000});
  assert.equal(result.status, 0, `packaged_schema_worker_failed:${result.error?.code ?? result.signal ?? result.stderr}`);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.passed, 3);
  return proof;
}

if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2]);
  console.log(JSON.stringify(verifyServiceSchemaRuntime(join(directory, process.platform === 'win32' ? 'uptokey-windows.exe' : 'uptokey'), directory)));
}
