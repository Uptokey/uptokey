export const CHANNEL_CONTRACT_VERSION = 1;
export function isChannelIngress(obj) {
  return obj && typeof obj === 'object' && typeof obj.channelAccount === 'string';
}
