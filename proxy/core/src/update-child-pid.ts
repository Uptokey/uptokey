import { readLiveProxyPid } from "./daemon-lifecycle.ts";

export function assertUpdateChildPid(expectedPid: number | undefined, readPid: () => number = readLiveProxyPid): void {
  if (!Number.isSafeInteger(expectedPid) || expectedPid === undefined || expectedPid <= 1) throw new Error("update_child_pid_missing");
  if (readPid() !== expectedPid) throw new Error("update_child_pid_mismatch");
}
