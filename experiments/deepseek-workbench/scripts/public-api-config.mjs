export function publicApiConfig({id,baseUrl,spec,specPath}) {
  // The original MCP client reserves serverName namespaces of at most 32 chars.
  if(!/^[a-z][a-z0-9-]{0,31}$/.test(id))throw Error('Invalid API name');
  const url=new URL(baseUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port||!url.hostname.includes('.')||/^(?:[\d.]+|\[)/.test(url.hostname)||/\.(?:local|localhost|internal)$/.test(url.hostname))throw Error('Public API requires a credential-free HTTPS DNS URL');
  if(!/^3\./.test(spec?.openapi??'')||!spec.paths||typeof spec.paths!=='object')throw Error('OpenAPI 3 JSON required');
  const inspect=value=>{
    if(!value||typeof value!=='object')return;
    if(typeof value.$ref==='string'&&!value.$ref.startsWith('#/'))throw Error('External schema references are unsupported');
    if(value.security?.length)throw Error('Use the credentials integration for authenticated APIs');
    for(const child of Object.values(value))inspect(child);
  };
  inspect(spec);
  let operations=0;
  for(const [path,item] of Object.entries(spec.paths)){
    if(!path.startsWith('/')||path.startsWith('//'))throw Error('Invalid API path');
    if(item.servers)throw Error('Per-path servers are unsupported');
    for(const method of ['put','post','delete','patch','head','options','trace'])if(item[method])throw Error('Public API registration currently accepts GET operations only');
    if(item.get){if(item.get.servers)throw Error('Per-operation servers are unsupported');operations++}
  }
  if(!operations)throw Error('No GET operations found');
  if(!/^\/home\/node\/\.dsh\/attachments\/\.uptokey-public-apis\/[a-f0-9]{64}\.json$/.test(specPath))throw Error('Invalid isolated schema path');
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  const argv=['/usr/local/bin/node','/opt/integrations/openapi.mjs','--api-base-url',url.href,'--openapi-spec',specPath,'--tools','all','--operation','get','--verbose','false'];
  return {id:`uptokey-api-${id}`,name:'@deepseek-ai/dsh-mcp-client',config:{serverName:id,transport:'stdio',command:'/usr/bin/ssh',args:['-T','-o','BatchMode=yes','workbench-executor','HTTPS_PROXY=http://127.0.0.1:43190 '+argv.map(quote).join(' ')],failOnStartupError:false}};
}
