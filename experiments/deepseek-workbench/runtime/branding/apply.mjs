// Build-only branding of the pinned distribution. Original upstream sources and
// package licenses remain intact; the manifest records every adapted artifact.
import {readFileSync,writeFileSync,readdirSync,copyFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {patchAttachmentPreview} from './file-preview-patch.mjs';
import {patchModelCatalogReset} from './model-catalog-patch.mjs';
import {patchPluginBoundary} from './plugin-boundary-patch.mjs';
import {patchExplicitApproval} from './explicit-approval-patch.mjs';
import {patchNativeFocusApproval} from './native-focus-patch.mjs';
const root='/opt/harness/node_modules/@deepseek-ai/';
const assets='/opt/harness/branding/';
const hash=data=>createHash('sha256').update(data).digest('hex');
const changes=[];
assert.equal(JSON.parse(readFileSync(root+'dsh/package.json')).version,'0.2.1-rc.2');
const mark='data:image/png;base64,'+readFileSync(assets+'mark.png').toString('base64');
function save(path,content){
 const before=readFileSync(path);const after=Buffer.from(content);
 if(before.equals(after))return;
 writeFileSync(path,after);changes.push({path:path.replace(root,''),before:hash(before),after:hash(after)});
}
// Title is compiled into the official distribution, not runtime-configurable.
// Adapt only the product display name, leaving provider names and module IDs.
for(const entry of readdirSync(root).filter(p=>p.startsWith('dsh-client-'))){
 const path=root+entry+'/lib/client.js';let text;
 try{text=readFileSync(path,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
 text=text.replaceAll('DeepSeek Harness','Uptokey');
 if(entry==='dsh-client-ui-conversation'){
  assert.ok(text.includes('"hero.headline": "Into the Unknown"'));
  text=text.replace('"hero.headline": "Into the Unknown"','"hero.headline": "Uptokey"')
   .replace('"hero.headline": "探索未至之境"','"hero.headline": "Uptokey"');
 }
 if(entry==='dsh-client-ui-settings-models'){
  text=text.replace(/welcomeBody:\s*"(?:\\.|[^"\\])*"/g,
   'welcomeBody: "Uptokey — local workspaces, your models and your keys."');
 }
 if(entry==='dsh-client-ui-model-selection')text=patchModelCatalogReset(text);
 if(entry==='dsh-client-ui-approval')text=patchNativeFocusApproval(text);
 if(entry==='dsh-client-ui-chat'){
  text=patchAttachmentPreview(text);
  // Keep the existing run clock and shimmer; replace only its copy and mark.
  for(const [before,after] of [
   ['"chat.deepDiving": "Deep diving"','"chat.deepDiving": "Working"'],
   ['"chat.deepDivingFor": "Deep diving for {duration} ···"','"chat.deepDivingFor": "Working for {duration} ···"'],
   ['"chat.deepDiving": "深度求索中"','"chat.deepDiving": "正在处理"'],
   ['"chat.deepDivingFor": "深度求索中，用时 {duration} ···"','"chat.deepDivingFor": "正在处理，用时 {duration} ···"'],
  ]){
   assert.ok(text.includes(before),`Missing pinned running status: ${before}`);
   text=text.replace(before,after);
  }
  const start=text.indexOf('function RunningWhaleTail() {');
  const end=text.indexOf('//#endregion',start);
  assert.ok(start>0&&end>start&&text.slice(start,end).includes('runningWhaleAnimated'));
  const mask=`url(${JSON.stringify(mark)})`;
  const icon=`function RunningWhaleTail() {
    return (0, react_jsx_runtime.jsx)("span", {
      className: ChatView_module_css_default.runningIcon,
      "aria-hidden": "true",
      children: (0, react_jsx_runtime.jsx)("span", {
        style: { width: "100%", height: "100%", backgroundColor: "currentColor",
          maskImage: ${JSON.stringify(mask)}, maskRepeat: "no-repeat", maskPosition: "center", maskSize: "contain",
          WebkitMaskImage: ${JSON.stringify(mask)}, WebkitMaskRepeat: "no-repeat",
          WebkitMaskPosition: "center", WebkitMaskSize: "contain" }
      })
    });
  }
  `;
  text=text.slice(0,start)+icon+text.slice(end);
 }
 save(path,text);
}
assert.ok(changes.some(c=>c.path==='dsh-client-ui-layout/lib/client.js'));
const pluginTools=root+'dsh-plugin-manager/lib/types/tools.js';
save(pluginTools,patchPluginBoundary(readFileSync(pluginTools,'utf8')));
const approvalService=root+'dsh-user-approval/lib/index.js';
save(approvalService,patchExplicitApproval(readFileSync(approvalService,'utf8')));
// Reuse the official brand row and its native slots; replace its occupant only.
const template=['theme.js','workspace.js','workspace-feedback.js','model-catalog.js','model-pages.js','public-api.js','lifecycle-notifications.js','client.js'].map(file=>readFileSync(assets+file,'utf8')).join('\n');
save(root+'dsh-client-ui-brand-official/lib/client.js',template.replace('__UPTOKEY_MARK__',mark));
const web=root+'dsh-web-frontend/dist/';
let html=readFileSync(web+'index.html','utf8').replace('<title>DeepSeek Harness</title>','<title>Uptokey</title>');
html=html.replaceAll('type="image/svg+xml"','type="image/png"')
 .replace('./favicon-dark.svg','./uptokey-white.png').replace('./favicon.svg','./uptokey-black.png');
const accountFiles=['canonical.js','canonical.css','harness.js','harness.css'];
mkdirSync(web+'uptokey-account',{recursive:true});
for(const file of accountFiles){
 const content=readFileSync('/opt/harness/account/'+file);
 writeFileSync(web+'uptokey-account/'+file,content);
 changes.push({path:'dsh-web-frontend/dist/uptokey-account/'+file,after:hash(content)});
}
assert.ok(html.includes('</head>'));
html=html.replace('</head>','<link rel="stylesheet" href="/uptokey-account/canonical.css"><link rel="stylesheet" href="/uptokey-account/harness.css"><script src="/uptokey-account/canonical.js"></script><script src="/uptokey-account/harness.js"></script></head>');
save(web+'index.html',html);
const manifest=JSON.parse(readFileSync(web+'manifest.webmanifest'));
manifest.name='Uptokey';manifest.short_name='Uptokey';
manifest.icons=[{src:'uptokey-icon.png',sizes:'256x256',type:'image/png',purpose:'any'}];
save(web+'manifest.webmanifest',JSON.stringify(manifest,null,2)+'\n');
for(const [source,dest] of [['mark.png','uptokey-black.png'],['white.png','uptokey-white.png'],['icon.png','uptokey-icon.png']]){
 copyFileSync(assets+source,web+dest);changes.push({path:'dsh-web-frontend/dist/'+dest,after:hash(readFileSync(web+dest))});
}
writeFileSync(assets+'applied.json',JSON.stringify({baseVersion:'0.2.1-rc.2',product:'Uptokey',sourceTreeEdited:false,licensesPreserved:true,changes},null,2)+'\n');
console.log(JSON.stringify({product:'Uptokey',adaptedArtifacts:changes.length}));
