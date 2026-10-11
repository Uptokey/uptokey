export type HostedPendingRequest = {requestId:string;reservedMicros:number;createdAt:string;dispatchStartedAt:string|null};
export function projectHostedPending(value:unknown): HostedPendingRequest[] | undefined;
