const money=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e12;
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function projectHostedReceipt(value){
 if(!value||typeof value.requestId!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(value.requestId)||
   !['reserved','settled'].includes(value.state)||value.currency!=='USD'||value.unit!=='micro_usd'||!money(value.reservedMicros)||
   !date(value.createdAt)||(value.dispatchStartedAt!==null&&!date(value.dispatchStartedAt))||
   (value.state==='reserved'&&(value.chargedMicros!==null||value.settledAt!==null))||
   (value.state==='settled'&&(!money(value.chargedMicros)||value.chargedMicros>value.reservedMicros||!date(value.settledAt)))||
   (value.priceVersion!==null&&(typeof value.priceVersion!=='string'||!/^[A-Za-z0-9._-]{1,80}$/.test(value.priceVersion))))throw new Error('hosted_receipt_invalid');
 return {requestId:value.requestId,state:value.state,currency:'USD',unit:'micro_usd',reservedMicros:value.reservedMicros,
   chargedMicros:value.chargedMicros,createdAt:value.createdAt,dispatchStartedAt:value.dispatchStartedAt,settledAt:value.settledAt,priceVersion:value.priceVersion};
}
