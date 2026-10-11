/**
 * E2-18-D — observação real de transporte (cloudflared/tailscale), somente leitura.
 *
 * Fronteiras (18-ARCHITECTURE): NUNCA instala, faz download, login ou herda HOME/tokens
 * pessoais; sem shell formado com input — binários de nome fixo, args fixos, execFile com
 * timeout e windowsHide. Padrões de descoberta adaptados da referência 9Router (MIT,
 * revisão 17c4cc7) com a governança do produto: sem execSync/pkill, sem string interpolation.
 *
 * Cache com TTL: primeira chamada resolve `installed` de forma síncrona e exata (fs),
 * versão/autenticação chegam na próxima observação após o probe assíncrono terminar.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import type { TransportObservation } from "./remote-access-ops.ts";
import type { RemoteAccessTransportKind } from "./remote-access-profile.ts";

export type DiscoverPlatform = "windows" | "macos" | "linux";

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 10_000;

const BINARY_NAME: Record<RemoteAccessTransportKind, { posix: string; windows: string }> = {
  cloudflared: { posix: "cloudflared", windows: "cloudflared.exe" },
  tailscale: { posix: "tailscale", windows: "tailscale.exe" },
};

function pathSeparator(platform: DiscoverPlatform): ";" | ":" {
  return platform === "windows" ? ";" : ":";
}

/** Join determinístico pelo platform informado — o host não decide o formato do caminho. */
function joinFor(platform: DiscoverPlatform, ...segments: string[]): string {
  return platform === "windows" ? pathWin32.join(...segments) : pathPosix.join(...segments);
}

/** Caminhos candidatos: binário do projeto, instalações conhecidas e PATH — só fs, sem shell. */
export function resolveTransportBinaryCandidates(
  kind: RemoteAccessTransportKind,
  platform: DiscoverPlatform,
  opts: { pathEnv?: string; projectBinDir?: string; home?: string } = {},
): string[] {
  const names = BINARY_NAME[kind];
  const binName = platform === "windows" ? names.windows : names.posix;
  const candidates: string[] = [];
  if (opts.projectBinDir) candidates.push(joinFor(platform, opts.projectBinDir, binName));
  if (platform === "windows") {
    if (kind === "tailscale") candidates.push(joinFor(platform, "C:\\Program Files\\Tailscale", "tailscale.exe"));
  } else {
    const unixRoots = kind === "tailscale"
      ? ["/usr/local/bin", "/opt/homebrew/bin", "/usr/sbin", "/usr/bin", "/snap/bin"]
      : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];
    candidates.push(...unixRoots.map((root) => joinFor(platform, root, binName)));
    if (platform === "macos" && opts.home) {
      candidates.push(joinFor(platform, opts.home, "Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale"));
    }
  }
  const pathEnv = opts.pathEnv ?? "";
  for (const dir of pathEnv.split(pathSeparator(platform))) {
    if (!dir) continue;
    candidates.push(joinFor(platform, dir, binName));
  }
  return candidates;
}

/** Extração tolerante do primeiro token de versão (formatos variam entre releases). */
export function parseTransportVersion(stdout: string): string | null {
  const firstLine = stdout.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const match = firstLine.match(/(\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*)/);
  return match ? match[1]! : null;
}

/** `tailscale status --json`: BackendState Running = autenticado; outros estados = não. */
export function parseTailscaleStatus(stdout: string): { authenticated: boolean } | null {
  try {
    const parsed = JSON.parse(stdout) as { BackendState?: unknown };
    if (typeof parsed.BackendState !== "string") return null;
    return { authenticated: parsed.BackendState === "Running" };
  } catch {
    return null;
  }
}

export interface DiscoverDeps {
  exists?: (path: string) => boolean;
  run?: (binary: string, args: readonly string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  projectBinDir?: string;
  home?: string;
  now?: () => number;
}

interface CacheEntry {
  observation: TransportObservation;
  fetchedAt: number;
  refreshing: boolean;
}

function normalizePlatform(platform: NodeJS.Platform | undefined): DiscoverPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "windows";
}

export interface TransportObserver {
  observe(kind: RemoteAccessTransportKind, platform: DiscoverPlatform): TransportObservation;
  /** Só para testes: invalida o cache. */
  invalidate(): void;
}

export function createTransportObserver(deps: DiscoverDeps = {}): TransportObserver {
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? ((binary, args, timeoutMs) => new Promise((resolve, reject) => {
    execFile(binary, [...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  }));
  const platform = normalizePlatform(deps.platform ?? process.platform);
  const now = deps.now ?? Date.now;
  const cache = new Map<RemoteAccessTransportKind, CacheEntry>();

  const refresh = (kind: RemoteAccessTransportKind, binaryPath: string): void => {
    const entry = cache.get(kind)!;
    if (entry.refreshing) return;
    entry.refreshing = true;
    void (async () => {
      const observation: TransportObservation = { installed: true };
      try {
        const version = await run(binaryPath, ["--version"], PROBE_TIMEOUT_MS);
        observation.version = parseTransportVersion(version.stdout) ?? undefined;
        if (kind === "tailscale") {
          // status --json é leitura do daemon local; falha deixa authenticated indefinido.
          try {
            const status = await run(binaryPath, ["status", "--json"], PROBE_TIMEOUT_MS);
            const parsed = parseTailscaleStatus(status.stdout);
            if (parsed) observation.authenticated = parsed.authenticated;
          } catch { /* daemon ausente: unknown, não falso negativo */ }
        }
      } catch {
        // Binário existe mas probe falhou: instalado, versão desconhecida, indisponível.
        observation.version = undefined;
        (observation as TransportObservation & { probeFailed?: boolean }).probeFailed = true;
      }
      entry.observation = observation;
      entry.fetchedAt = now();
      entry.refreshing = false;
    })();
  };

  return {
    observe(kind, requestedPlatform): TransportObservation {
      if (requestedPlatform !== platform) {
        // Só observamos a plataforma do próprio processo — sem probes remotos.
        return { installed: false };
      }
      if (kind !== "cloudflared" && kind !== "tailscale") return { installed: false };
      const cached = cache.get(kind);
      if (cached && now() - cached.fetchedAt <= CACHE_TTL_MS) return { ...cached.observation };
      if (cached && cached.refreshing) return { ...cached.observation };
      const binary = resolveTransportBinaryCandidates(kind, platform, {
        pathEnv: deps.pathEnv ?? process.env.PATH ?? "",
        projectBinDir: deps.projectBinDir,
        home: deps.home,
      }).find((candidate) => exists(candidate));
      if (!binary) {
        cache.set(kind, { observation: { installed: false }, fetchedAt: now(), refreshing: false });
        return { installed: false };
      }
      cache.set(kind, { observation: { installed: true }, fetchedAt: now(), refreshing: false });
      refresh(kind, binary);
      return { installed: true };
    },
    invalidate(): void {
      cache.clear();
    },
  };
}
