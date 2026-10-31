// The registration patch is the source of truth, independent of overlay defaults.
export function registeredApiPrefixes(base,profile){
 const valid=value=>typeof value==='string'&&/^mcp__[a-z][a-z0-9-]{0,31}__$/.test(value);
 if(!Array.isArray(base)||base.some(v=>!valid(v))||!Array.isArray(profile))throw Error('api_file_registry_invalid');
 const requested=profile.find(entry=>entry.id==='uptokey-api-file')?.config?.servers??[];
 if(!Array.isArray(requested)||requested.some(v=>!valid(v)))throw Error('api_file_registry_invalid');
 const plugins=profile.flatMap(entry=>Array.isArray(entry.insert)?entry.insert:[]);
 const installed=new Set(plugins.filter(entry=>entry.name==='@deepseek-ai/dsh-mcp-client'&&!entry.disabled&&entry.id==='uptokey-api-'+entry.config?.serverName).map(entry=>'mcp__'+entry.config.serverName+'__'));
 return [...new Set([...base,...requested.filter(prefix=>installed.has(prefix))])];
}
