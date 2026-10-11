import os from "node:os";

export interface HardwareProfile {
  os: "windows" | "macos" | "linux" | "unknown";
  architecture: string;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  cpuCores: number;
  gpu: { present: boolean | null; vendor: "apple" | "nvidia" | "amd" | "intel" | "unknown" };
  source: "local-only";
}

function platform(value: NodeJS.Platform): HardwareProfile["os"] {
  if (value === "win32") return "windows";
  if (value === "darwin") return "macos";
  if (value === "linux") return "linux";
  return "unknown";
}

export function detectHardwareProfile(): HardwareProfile {
  const osName = platform(process.platform);
  return {
    os: osName,
    architecture: process.arch,
    totalMemoryBytes: os.totalmem(),
    availableMemoryBytes: os.freemem(),
    cpuCores: Math.max(1, os.cpus().length),
    gpu: { present: osName === "macos" && process.arch === "arm64" ? true : null, vendor: osName === "macos" && process.arch === "arm64" ? "apple" : "unknown" },
    source: "local-only",
  };
}
