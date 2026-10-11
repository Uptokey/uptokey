export type HostedReceipt={requestId:string;state:'reserved'|'settled';currency:'USD';unit:'micro_usd';reservedMicros:number;chargedMicros:number|null;createdAt:string;dispatchStartedAt:string|null;settledAt:string|null;priceVersion:string|null};
export function projectHostedReceipt(value:unknown):HostedReceipt;
