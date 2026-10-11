import { Agent } from 'node:http';
import { SpanKind, SpanStatusCode, TraceFlags, type Attributes, type HrTime } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import { createOtlpHttpExportDelegate } from '@opentelemetry/otlp-exporter-base/node-http';
import { JsonTraceSerializer, TraceExporterMetricsHelper } from '@opentelemetry/otlp-transformer';
import { asDataRecord, projectDataArray } from '@uptokey/sync-contract/plain-data';
import type { WorkspaceTelemetrySpan } from './telemetry.ts';
import { TELEMETRY_SPAN_NAMES as spanNames } from './telemetry.ts';

export const WORKSPACE_TELEMETRY_MAX_BATCH = 256;
export const WORKSPACE_TELEMETRY_MAX_BYTES = 256 * 1024;
export interface WorkspaceTelemetryCredentials { readonly publicKey:string; readonly secretKey:string; }
export interface WorkspaceTelemetryExporterOptions {
  readonly endpoint:string;
  readonly resolveCredentials:(signal:AbortSignal)=>Promise<WorkspaceTelemetryCredentials>;
  readonly timeoutMillis?:number;
}
export interface WorkspaceTelemetryExporter {
  export(spans:readonly WorkspaceTelemetrySpan[]):Promise<boolean>;
  shutdown():Promise<void>;
}

/** Manual, bounded export only. No global provider, detector, environment configuration or auto-instrumentation. */
export function createWorkspaceTelemetryExporter(options:WorkspaceTelemetryExporterOptions):WorkspaceTelemetryExporter {
  let endpoint:string;
  const timeoutMillis=options.timeoutMillis??2000;
  try {
    const url=new URL(options.endpoint);
    if(url.href!==options.endpoint||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||
      url.username||url.password||url.search||url.hash||url.pathname!=='/api/public/otel/v1/traces'||
      !Number.isInteger(timeoutMillis)||timeoutMillis<50||timeoutMillis>30_000||typeof options.resolveCredentials!=='function')throw new Error();
    endpoint=url.href;
  } catch {throw new Error('workspace_telemetry_export_config_invalid');}
  const resolveCredentials=options.resolveCredentials;
  let closed=false,active:AbortController|null=null,activeFinished:Promise<void>|undefined;
  const cleanups=new Set<Promise<void>>();
  let closing:Promise<void>|undefined;
  return {
    async export(input) {
      if(closed||active||cleanups.size)return false;
      let spans:ReadableSpan[];
      try {
        const batch=projectDataArray(input,WORKSPACE_TELEMETRY_MAX_BATCH);
        if(!batch)return false;
        spans=batch.map(readableSpan);
        if(spans.length===0)return true;
        // Size is checked against the real SDK serialization; this is never a parallel OTLP encoder.
        const body=JsonTraceSerializer.serializeRequest(spans);
        if(!body||body.byteLength>WORKSPACE_TELEMETRY_MAX_BYTES)return false;
      } catch {return false;}
      const controller=new AbortController();active=controller;
      let finishActive!:()=>void;
      activeFinished=new Promise<void>(resolve=>{finishActive=resolve;});
      const agent=new Agent({keepAlive:false,maxSockets:1,maxTotalSockets:1});
      const abort=()=>agent.destroy();controller.signal.addEventListener('abort',abort,{once:true});
      let sdk:OTLPExporterBase<ReadableSpan[]>|undefined,authorization:string|undefined,rejected=false,sdkFinished=false;
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const deadline=new Promise<boolean>(resolve=>{
          controller.signal.addEventListener('abort',()=>resolve(false),{once:true});
          timer=setTimeout(()=>controller.abort(),timeoutMillis);
        });
        const operation=(async()=>{
          try {
            const credentials=await resolveCredentials(controller.signal);
            if(closed||controller.signal.aborted)return false;
            const keys=asDataRecord(credentials);
            if(!keys||Object.keys(keys).sort().join(',')!=='publicKey,secretKey'||
              !credential(keys.publicKey)||!credential(keys.secretKey)||keys.publicKey.includes(':'))return false;
            authorization=`Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`,'utf8').toString('base64')}`;
            // OTLPTraceExporter merges OTEL_* headers even with explicit headers. These public SDK
            // components are its actual JSON serializer and Node transport, configured without env.
            // Each batch owns its authorization closure: a late retry cannot borrow a later key.
            const delegate=createOtlpHttpExportDelegate({
              url:endpoint,timeoutMillis,concurrencyLimit:1,compression:'none',agentFactory:()=>agent,
              headers:async()=>{
                if(closed||controller.signal.aborted||!authorization)throw new Error('workspace_telemetry_export_unavailable');
                return {'Content-Type':'application/json',Authorization:authorization,'x-langfuse-ingestion-version':'4'};
              },
            },{
              serializeRequest:JsonTraceSerializer.serializeRequest,
              deserializeResponse:data=>{
                // The SDK otherwise reports HTTP 200 partial rejection as success and logs the
                // server's free-form errorMessage. Keep only acceptance, never response text.
                try {
                  if(data.byteLength>4096)throw new Error();
                  if(data.byteLength)JSON.parse(new TextDecoder().decode(data)); // syntax gate before SDK diagnostics
                  const response=asDataRecord(JsonTraceSerializer.deserializeResponse(data));
                  if(!response||Object.keys(response).some(key=>key!=='partialSuccess'))throw new Error();
                  if(response.partialSuccess!==undefined){
                    const partial=asDataRecord(response.partialSuccess);
                    if(!partial||Object.keys(partial).some(key=>!['rejectedSpans','errorMessage'].includes(key))||
                      ![undefined,0,'0'].includes(partial.rejectedSpans as number|string|undefined))rejected=true;
                  }
                } catch {rejected=true;}
                return {};
              },
            },'otlp_http_span_exporter',TraceExporterMetricsHelper,undefined);
            sdk=new OTLPExporterBase(delegate);
            return await new Promise<boolean>(resolve=>{
              try {sdk!.export(spans,result=>{sdkFinished=true;resolve(!closed&&!controller.signal.aborted&&!rejected&&result.code===ExportResultCode.SUCCESS);});}
              catch {resolve(false);}
            });
          } catch {return false;}
        })();
        return await Promise.race([operation,deadline]);
      } finally {
        clearTimeout(timer);controller.abort();authorization=undefined;
        if(sdk){
          const cleanup=sdk.shutdown().catch(()=>undefined);
          cleanups.add(cleanup);void cleanup.finally(()=>cleanups.delete(cleanup));
          // Normal callbacks have settled transport; complete SDK cleanup before accepting the next
          // sequential batch. A hard deadline may leave a scheduled retry, whose closure is aborted.
          if(sdkFinished)await cleanup;
        }
        if(active===controller)active=null;
        finishActive();activeFinished=undefined;
      }
    },
    shutdown() {
      if(closing)return closing;
      closed=true;const pending=activeFinished;active?.abort();
      closing=(async()=>{await pending;await Promise.all([...cleanups]);})();
      return closing;
    },
  };
}

function credential(input:unknown):input is string {
  return typeof input==='string'&&input.length>0&&input.length<=512&&!/[\u0000-\u0020\u007f]/.test(input);
}
// Closed allowlist shared with the canonical projector (telemetry.ts): the
// serializer accepts exactly the families the projector can emit, no more.
const resource=resourceFromAttributes({'service.name':'quimera-workspace'});
export function readableSpan(input:unknown):ReadableSpan {
  const item=asDataRecord(input);
  if(!item||Object.keys(item).some(key=>!['name','traceId','spanId','startedAt','finishedAt','attributes'].includes(key))||
    !id(item.traceId,32)||!id(item.spanId,16))throw new Error();
  const attributes=asDataRecord(item.attributes);
  if(!attributes||!id(attributes['quimera.run.correlation_id'],64))throw new Error();
  if(item.name==='quimera.run') {
    if(Object.keys(attributes).sort().join(',')!=='quimera.run.correlation_id,quimera.run.status'||!oneOf(attributes['quimera.run.status'],['succeeded','failed','cancelled']))throw new Error();
  } else {
    const capability=attributes['quimera.capability'],basis=attributes['quimera.usage.basis'];
    if(typeof capability!=='string'||!Object.hasOwn(spanNames,capability)||item.name!==spanNames[capability]||
      !oneOf(attributes['quimera.attempt.status'],['succeeded','failed','unknown'])||!oneOf(basis,['unknown','estimated','provider_reported']))throw new Error();
    for(const [key,value] of Object.entries(attributes)) {
      if(['quimera.run.correlation_id','quimera.attempt.status','quimera.capability','quimera.usage.basis'].includes(key))continue;
      if(!['quimera.usage.input_tokens','quimera.usage.output_tokens','quimera.usage.cached_input_tokens'].includes(key)||
        basis!=='provider_reported'||typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error();
    }
  }
  const startTime=time(item.startedAt),endTime=time(item.finishedAt);
  let seconds=endTime[0]-startTime[0],nanos=endTime[1]-startTime[1];
  if(nanos<0){seconds--;nanos+=1e9;}
  if(seconds<0)throw new Error();
  const context={traceId:item.traceId,spanId:item.spanId,traceFlags:TraceFlags.SAMPLED};
  return {name:item.name as string,kind:SpanKind.INTERNAL,spanContext:()=>context,
    startTime,endTime,duration:[seconds,nanos],ended:true,status:{code:SpanStatusCode.UNSET},
    attributes:{...attributes} as Attributes,links:[],events:[],resource,
    instrumentationScope:{name:'quimera.workspace.journal',version:'1'},
    droppedAttributesCount:0,droppedEventsCount:0,droppedLinksCount:0};
}
function id(value:unknown,length:number):value is string {
  return typeof value==='string'&&value.length===length&&/^[a-f0-9]+$/.test(value)&&!/^0+$/.test(value);
}
function oneOf(value:unknown,values:readonly string[]):boolean{return typeof value==='string'&&values.includes(value);}
function time(value:unknown):HrTime {
  if(typeof value!=='string')throw new Error();
  const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if(!match)throw new Error();
  const ms=Date.parse(`${match[1]}.000Z`);
  if(!Number.isFinite(ms)||new Date(ms).toISOString()!==`${match[1]}.000Z`)throw new Error();
  return [ms/1000,Number((match[2]??'').padEnd(9,'0'))];
}
