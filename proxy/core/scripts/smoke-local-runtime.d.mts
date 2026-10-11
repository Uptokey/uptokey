export interface RuntimeSmokeOptions {
  fetchImpl?: typeof fetch;
  portListening?: (port: number) => Promise<boolean>;
  latestProxySourceMtimeMs?: number;
  latestControlPlaneSourceMtimeMs?: number;
  expectedPublishedThrough?: number;
  requestTimeoutMs?: number;
}

export function verifyLocalRuntime(options?: RuntimeSmokeOptions): Promise<"runtime_boundaries_valid">;
