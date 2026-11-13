import type {ApiCompositePlanInput} from './public-contract.ts';

type Step = ApiCompositePlanInput['steps'][number];

const countryAliases = new Map([
  ['brasil','BR'],['brazil','BR'],['portugal','PT'],['argentina','AR'],
  ['alemanha','DE'],['germany','DE'],['japao','JP'],['japan','JP'],
  ['estados unidos','US'],['united states','US'],['reino unido','GB'],['united kingdom','GB'],
]);
const currencyAliases = new Map([
  ['dolar','USD'],['dolar americano','USD'],['us dollar','USD'],
  ['real','BRL'],['real brasileiro','BRL'],['brazilian real','BRL'],
  ['euro','EUR'],['iene','JPY'],['yen','JPY'],['libra esterlina','GBP'],['pound sterling','GBP'],
]);
const readVerb = /^(?:consulte|liste|busque|mostre|list|look up|show)\s+/iu;
const normalizeName = (name:string)=>name.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const worldBankOperationId = 'api.world_bank.get_country_indicator';

function countryCode(name:string):string|undefined {
  return countryAliases.get(normalizeName(name))??(/^[A-Z]{2,3}$/.test(name)?name:undefined);
}

function currency(name:string):string|undefined {
  return currencyAliases.get(normalizeName(name))??(/^[a-z]{3}$/i.test(name)?name.toUpperCase():undefined);
}

function requestedRead(clause:string):Step | undefined {
  const github=/^(issues?|pull requests?)\s+(?:abertos?\s+|abertas?\s+)?(?:de|do|for|in)\s+([a-z\d][a-z\d-]{0,38})\/([a-z\d_][a-z\d_.-]{0,99})(?:\s+(?:no|on)\s+GitHub)?$/iu.exec(clause);
  if(github){
    const operation=github[1]!.toLowerCase().startsWith('issue')?'issues':'pulls';
    return {operationId:'api.github_public.get_public_repository_'+operation,parameters:{owner:github[2]!,repo:github[3]!,state:'open',per_page:5}};
  }
  const national=/^(?:(?:a|o|the)\s+)?(população|populacao|population|pib|gdp)\s+(?:de|do|da|of)\s+([\p{L} ]{2,45}?)(?:\s+(?:no Banco Mundial|from the World Bank))?$/iu.exec(clause);
  if(national){
    const country=countryCode(national[2]!);
    const indicator=/^(pib|gdp)$/i.test(national[1]!)?'NY.GDP.MKTP.CD':'SP.POP.TOTL';
    if(country)return {operationId:worldBankOperationId,parameters:{country,indicator,format:'json',per_page:5}};
  }
  const exchange=/^(?:(?:a|the)\s+)?(?:(?:cotação|cotacao|taxa de câmbio|taxa de cambio)\s+de\s+|exchange rate\s+(?:from\s+|for\s+)?)([\p{L} ]{3,24}?)\s+(?:para|to)\s+([\p{L} ]{3,24})$/iu.exec(clause);
  if(exchange){
    const base=currency(exchange[1]!), symbols=currency(exchange[2]!);
    if(base&&symbols&&base!==symbols)return {operationId:'api.frankfurter.get_latest_exchange_rates',parameters:{base,symbols}};
  }
  const earthquakes=/^(?:terremotos\s+de magnitude|earthquakes\s+of magnitude)\s+(\d{1,2}(?:[.,]\d)?)\s*(?:ou mais|or higher)?(?:\s+(?:desde|since)\s+(\d{4}-\d{2}-\d{2}))?$/iu.exec(clause);
  if(earthquakes){
    const minmagnitude=Number(earthquakes[1]!.replace(',','.'));
    const starttime=earthquakes[2];
    if(minmagnitude>10)return;
    if(starttime){
      const date=new Date(starttime);
      if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==starttime)return;
    }
    return {operationId:'api.usgs_earthquakes.search_earthquakes',parameters:{format:'geojson',limit:5,minmagnitude,...(starttime?{starttime}:{})}};
  }
}

/** Route only complete read requests. Arbitrary prose and attachments stay with the normal chat. */
export function publicApiChatSteps(text:string):Step[] | undefined {
  if(text.length>420||/[\u0000-\u001f]/u.test(text))return;
  const command=text.trim().replace(/^(?:por favor[,]?\s+|please\s+)/iu,'');
  const verb=readVerb.exec(command);
  if(!verb)return;
  const request=command.slice(verb[0].length).replace(/\s*[.!?]$/u,'').trim();
  const single=requestedRead(request);
  if(single)return [single];
  // Each side must parse completely. Conjunctions in names do not imply a second effect.
  let pair:Step[]|undefined;
  for(const separator of request.matchAll(/\s+(?:e|and)\s+/giu)){
    const first=requestedRead(request.slice(0,separator.index));
    if(!first)continue;
    const tail=request.slice(separator.index+separator[0].length).replace(readVerb,'');
    let second=requestedRead(tail);
    if(!second&&first.operationId===worldBankOperationId){
      const country=countryCode(tail.replace(/^(?:de|do|da|of)\s+/iu,'').replace(/\s+(?:no Banco Mundial|from the World Bank)$/iu,''));
      if(country)second={operationId:worldBankOperationId,parameters:{...first.parameters,country}};
    }
    if(!second||(first.operationId===second.operationId&&JSON.stringify(first.parameters)===JSON.stringify(second.parameters)))continue;
    if(pair)return;
    pair=[first,second];
  }
  return pair;
}
