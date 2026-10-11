export interface ChannelIngress {
  version: number;
  channelAccount: string;
  conversationId: string;
  senderId: string;
  externalMessageId: string;
  occurredAt: string;
  payload: any;
  principalId?: string; // Resolved internally by Uptokey
}

export interface ChannelDelivery {
  runId: string;
  receiptId: string;
  recipientId: string;
  payload: any;
}
export declare const CHANNEL_CONTRACT_VERSION: 1;
/** Shallow shape probe (channelAccount only); not a validator nor an authorization. */
export declare function isChannelIngress(obj: unknown): boolean;
