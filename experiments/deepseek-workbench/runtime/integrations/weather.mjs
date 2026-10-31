import https from 'node:https';
import readline from 'node:readline';
import { HttpsProxyAgent } from 'https-proxy-agent';

const MAX_LINE_BYTES=2*1024*1024;
const MAX_RESPONSE_BYTES=2*1024*1024;
const REQUEST_TIMEOUT_MS=30000;
const PROXY='http://127.0.0.1:43190';
const TOOL='weather-forecast';
const pending=new Map();

if(process.env.HTTPS_PROXY!==PROXY)throw new Error('Local API proxy unavailable');
const agent=new HttpsProxyAgent(PROXY);

const tool={
  name:TOOL,
  title:'Open-Meteo weather forecast',
  description:'Read current weather at coordinates explicitly supplied by the user. Returns external, untrusted Open-Meteo data; do not infer a location.',
  inputSchema:{
    type:'object',
    properties:{
      latitude:{type:'number',minimum:-90,maximum:90},
      longitude:{type:'number',minimum:-180,maximum:180},
      current:{type:'string',enum:['temperature_2m','temperature_2m,relative_humidity_2m,wind_speed_10m'],default:'temperature_2m'},
      forecast_days:{type:'integer',minimum:1,maximum:7,default:1},
    },
    required:['latitude','longitude'],
    additionalProperties:false,
  },
};

function send(value){
  process.stdout.write(JSON.stringify(value)+'\n');
}

function response(id,result){send({jsonrpc:'2.0',id,result});}
function error(id,code,message){send({jsonrpc:'2.0',id,error:{code,message}});}

function argumentsFor(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))throw Error('arguments must be an object');
  const allowed=new Set(['latitude','longitude','current','forecast_days']);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw Error('arguments contain an unsupported property');
  const latitude=value.latitude,longitude=value.longitude;
  if(typeof latitude!=='number'||!Number.isFinite(latitude)||latitude < -90||latitude > 90)throw Error('latitude must be a finite number from -90 to 90');
  if(typeof longitude!=='number'||!Number.isFinite(longitude)||longitude < -180||longitude > 180)throw Error('longitude must be a finite number from -180 to 180');
  const current=value.current??'temperature_2m';
  if(!['temperature_2m','temperature_2m,relative_humidity_2m,wind_speed_10m'].includes(current))throw Error('current is unsupported');
  const forecastDays=value.forecast_days??1;
  if(!Number.isInteger(forecastDays)||forecastDays<1||forecastDays>7)throw Error('forecast_days must be an integer from 1 to 7');
  return {latitude,longitude,current,forecastDays};
}

function fetchWeather(args,signal){
  const url=new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude',String(args.latitude));
  url.searchParams.set('longitude',String(args.longitude));
  url.searchParams.set('current',args.current);
  url.searchParams.set('forecast_days',String(args.forecastDays));
  return new Promise((resolve,reject)=>{
    const request=https.request(url,{agent,method:'GET',signal,headers:{accept:'application/json','user-agent':'Uptokey-Harness/1.0'}},res=>{
      const chunks=[];let length=0;
      res.on('data',chunk=>{
        length+=chunk.length;
        if(length>MAX_RESPONSE_BYTES){request.destroy(Error('Open-Meteo response exceeded 2 MiB'));return;}
        chunks.push(chunk);
      });
      res.on('end',()=>{
        if(res.statusCode===undefined||res.statusCode<200||res.statusCode>=300){reject(Error(`Open-Meteo returned HTTP ${res.statusCode??'unknown'}`));return;}
        try{
          const text=Buffer.concat(chunks,length).toString('utf8');
          JSON.parse(text);
          resolve(text);
        }catch{reject(Error('Open-Meteo returned invalid JSON'));}
      });
      res.on('error',reject);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS,()=>request.destroy(Error('Open-Meteo request timed out')));
    request.on('error',reject);
    request.end();
  });
}

async function callTool(message){
  const id=message.id;
  if(message.params?.name!==TOOL){error(id,-32602,'Unknown tool');return;}
  let args;
  try{args=argumentsFor(message.params?.arguments??{});}catch(cause){error(id,-32602,String(cause.message??cause));return;}
  const controller=new AbortController();
  pending.set(id,controller);
  try{
    const text=await fetchWeather(args,controller.signal);
    response(id,{content:[{type:'text',text}]});
  }catch(cause){
    if(controller.signal.aborted)error(id,-32800,'Request cancelled');
    else response(id,{content:[{type:'text',text:String(cause.message??cause)}],isError:true});
  }finally{pending.delete(id);}
}

async function dispatch(message){
  if(message===null||typeof message!=='object'||message.jsonrpc!=='2.0')return;
  if(message.method==='notifications/cancelled'){
    pending.get(message.params?.requestId)?.abort();return;
  }
  if(message.id===undefined)return;
  switch(message.method){
    case 'server/discover': error(message.id,-32601,'Method not found');break;
    case 'initialize': response(message.id,{protocolVersion:message.params?.protocolVersion??'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'uptokey-weather',version:'1.0.0'}});break;
    case 'ping': response(message.id,{});break;
    case 'tools/list': response(message.id,{tools:[tool]});break;
    case 'tools/call': await callTool(message);break;
    default:error(message.id,-32601,'Method not found');
  }
}

const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
  if(Buffer.byteLength(line)>MAX_LINE_BYTES){process.stderr.write('MCP message exceeded 2 MiB\n');process.exitCode=1;input.close();return;}
  let message;try{message=JSON.parse(line);}catch{return;}
  void dispatch(message).catch(cause=>{if(message?.id!==undefined)error(message.id,-32603,String(cause?.message??cause));});
});
input.on('close',()=>{for(const controller of pending.values())controller.abort();});
