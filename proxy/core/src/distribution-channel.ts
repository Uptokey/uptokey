declare const UPTOKEY_DISTRIBUTION_CHANNEL: string | undefined;

export type DistributionChannel = "native" | "npm";
// A build-time contract, never an environment switch or fallback after vault failure.
const channel = typeof UPTOKEY_DISTRIBUTION_CHANNEL === "string" ? UPTOKEY_DISTRIBUTION_CHANNEL : "native";
if (channel !== "native" && channel !== "npm") throw new Error("distribution_channel_invalid");
export const DISTRIBUTION_CHANNEL: DistributionChannel = channel;
