import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { openPty } from './lib/pty-session.mjs';
import { tuiEvidenceDirectory } from './lib/tui-evidence.mjs';
const core=resolve(import.meta.dirname,'..');
const evidence=tuiEvidenceDirectory(core);
const project=join(evidence,'project');await mkdir(project,{recursive:true});
const cli=join(core,'dist','cli.js');
const term=await openPty({file:process.execPath,args:[cli,project],cwd:project,env:{...process.env,UPTOKEY_LANG:'',LANG:'pt_BR.UTF-8',LC_ALL:'pt_BR.UTF-8',UPTOKEY_TUI_FRONTEND_DIR:'',UPTOKEY_TUI_FRONTEND:''}});
const checks={};let failure=null;const shots=[];
try{
  await term.until(()=>/ctrl\+p/i.test(term.screen())&&/Build|Ask anything|Message/.test(term.screen()),'default CLI did not open the English terminal',60000);
  checks.defaultCliOpensCanonicalTerminal=true;
  checks.englishDefaultWithPortugueseOS=true;
  assert.ok(!/Construir|Peça qualquer|Conectar um provedor/.test(term.screen()));
  await term.send('mcp');
  await term.until(()=>/\bmcp\b/.test(term.screen()),'ordinary letters did not reach the composer',10000);
  assert.ok(!/Select a model|Connect a provider|Choose a model/.test(term.screen()));
  checks.ordinaryLettersRemainDraft=true;shots.push(term.screen());
  await term.send('\x03');await new Promise(done=>setTimeout(done,700));await term.send('\x03');
  await term.until(()=>term.exited().exited,'installed CLI did not exit',15000);
  assert.equal(term.exited().exitCode,0);checks.cleanExit=true;
}catch(error){failure=error;shots.push(term.screen())}finally{await term.close()}
const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const result={journey:'installed-cli',date:new Date().toISOString(),result:failure?'failed':'passed',checks,error:failure?.message??null,command:[process.execPath,cli,project],exitCode:failure?1:0,artifactManifestSha256:await digest(join(core,'dist/tui/BUILD_INFO.json')),cliSha256:await digest(cli),runtime:'installed canonical CLI and terminal; real daemon/vault; no inference',requests:0};
await writeFile(join(evidence,'installed-cli.txt'),shots.join('\n\n'));await writeFile(join(evidence,'installed-cli.json'),JSON.stringify(result,null,2)+'\n');console.log(result.result);if(failure)process.exitCode=1;
