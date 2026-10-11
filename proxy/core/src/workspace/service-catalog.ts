import {CROSSREF_CAPABILITY,OPEN_LIBRARY_CAPABILITY,RSS_CAPABILITY} from './capabilities.ts';
import {ALL_CURATED_OPERATIONS} from '../../../integracoes/api-instruments/src/index.ts';
import {CURATED_SPECS} from '../../../integracoes/api-instruments/src/specs/index.ts';
import {PUBLIC_SERVICE_ALIASES} from '../../../integracoes/api-instruments/src/specs/public-services.ts';
import type {ServiceView,ServiceOperation} from '@uptokey/sync-contract/service-access';
import type {CuratedOperation} from '../../../integracoes/api-instruments/src/types.ts';
export type ServiceDefinition=Pick<ServiceView,'id'|'runtimeId'|'label'|'resourceIds'|'aliases'|'kind'|'scope'|'auth'|'documentationUrl'|'getKeyUrl'|'endpointUrl'|'setup'>&{operations:ServiceOperation[];apiOperations?:readonly CuratedOperation[];apiAuth?:{kind:'bearer'}|{kind:'header-api-key';headerName:string};bindingDigest?:string;executable?:boolean;revalidate?:()=>Promise<void>};
const aliases:Record<string,readonly string[]>={...PUBLIC_SERVICE_ALIASES,open_meteo:['openmeteo','public-open-meteo'],nager_date:['nager-date','public-nager-date'],rest_countries:['rest-countries','public-rest-countries'],time_api:['timeapi'],zippopotam:['zippopotam','public-zippopotam-us'],frankfurter:['frankfurter','public-frankfurter'],github_public:['github'],pokeapi:['pokeapi','public-pokeapi'],world_bank:['worldbank','public-world-bank'],pubmed:['pubmed'],arxiv:['arxiv','public-arxiv'],nasa:['nasa','public-nasa']};
const names:Record<string,string>={open_meteo:'Open-Meteo',nager_date:'Nager.Date',rest_countries:'REST Countries',time_api:'TimeAPI',zippopotam:'Zippopotam.us',frankfurter:'Frankfurter',github_public:'GitHub',pokeapi:'PokéAPI',world_bank:'World Bank',pubmed:'PubMed',arxiv:'arXiv',nasa:'NASA APOD'};
const specNames=new Map(CURATED_SPECS.map(spec=>[spec.info['x-uptokey-metadata'].serviceId,spec.info.title]));
export function serviceCatalog():ServiceDefinition[]{
 const grouped=new Map<string,ServiceDefinition>();
 for(const op of ALL_CURATED_OPERATIONS){
  let service=grouped.get(op.serviceId);
  if(!service){service={id:op.serviceId,runtimeId:op.serviceId,label:names[op.serviceId]??specNames.get(op.serviceId)??op.serviceId,resourceIds:[op.serviceId,...(aliases[op.serviceId]??[])].filter((id,index,list)=>list.indexOf(id)===index),aliases:[],kind:'api',scope:'device',auth:'none',documentationUrl:op.metadata.specUrl,getKeyUrl:null,endpointUrl:op.serverUrl,operations:[]};grouped.set(op.serviceId,service);}
  const parameters=op.parameters.filter(parameter=>!/(?:api[_-]?key|token|secret|password|authorization)/i.test(parameter.name));
  service.operations.push({id:op.id,label:op.operationId.replaceAll('_',' '),effect:'read_external',inputSchema:{type:'object',properties:Object.fromEntries(parameters.map(parameter=>[parameter.name,{...parameter.schema,description:parameter.description}])),required:parameters.filter(parameter=>parameter.required).map(parameter=>parameter.name),additionalProperties:false}});
 }
 return [...grouped.values(),
  ...([
   {id:'crossref',label:'Crossref',resourceIds:['crossref'],capability:CROSSREF_CAPABILITY,documentationUrl:'https://www.crossref.org/documentation/retrieve-metadata/rest-api/',endpointUrl:'https://api.crossref.org'},
   {id:'open_library',label:'Open Library',resourceIds:['openlibrary','public-open-library'],capability:OPEN_LIBRARY_CAPABILITY,documentationUrl:'https://openlibrary.org/developers/api',endpointUrl:'https://openlibrary.org'},
   {id:'rss',label:'RSS',resourceIds:['rss'],capability:RSS_CAPABILITY,documentationUrl:null,endpointUrl:null},
  ]).map(item=>({id:item.id,runtimeId:item.capability.id,label:item.label,resourceIds:item.resourceIds,aliases:[],kind:'tool' as const,scope:'project' as const,auth:'none' as const,documentationUrl:item.documentationUrl,getKeyUrl:null,endpointUrl:item.endpointUrl,operations:[],executable:item.capability.availability==='executable'})),
  {id:'poststack',runtimeId:'poststack',label:'PostStack',resourceIds:['poststack','public-poststack'],aliases:[],kind:'mcp',scope:'device',auth:'api-key',endpointUrl:'https://api.poststack.dev/mcp',documentationUrl:'https://poststack.dev/docs/mcp',getKeyUrl:'https://poststack.dev/dashboard/api-keys',operations:[]},
  ...(['resend','brevo','slack'] as const).map(id=>({id,runtimeId:id,label:({resend:'Resend',brevo:'Brevo',slack:'Slack'})[id],resourceIds:[id,`public-${id}`],aliases:[],kind:'channel' as const,scope:'project' as const,auth:'api-key' as const,endpointUrl:null,documentationUrl:({resend:'https://resend.com/docs',brevo:'https://developers.brevo.com',slack:'https://api.slack.com'})[id],getKeyUrl:({resend:'https://resend.com/api-keys',brevo:'https://app.brevo.com/settings/keys/api',slack:'https://api.slack.com/apps'})[id],operations:[]})),
  {id:'google_tasks',runtimeId:'google_tasks',label:'Google Tasks',resourceIds:['google_tasks','google-tasks'],aliases:[],kind:'productivity',scope:'device',auth:'oauth',documentationUrl:'https://developers.google.com/tasks',getKeyUrl:null,endpointUrl:'https://tasks.googleapis.com',setup:{kind:'oauth',providerId:'oauth-google',scopes:['https://www.googleapis.com/auth/tasks']},operations:[]},
 ];
}
