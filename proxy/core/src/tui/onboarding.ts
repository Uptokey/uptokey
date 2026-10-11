import { t } from "./i18n.ts";
/**
 * Uptokey TUI — First-run onboarding and capability discovery.
 *
 * State of the art: Modern CLI tools have rich first-run experiences
 * that guide the user through setup. This module handles:
 * - First-run detection
 * - Guided setup (core connection, identity, provider)
 * - Capability discovery (what's available vs what needs setup)
 * - Progressive disclosure of features
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".uptokey", "tui");
const STATE_FILE = join(CONFIG_DIR, "state.json");

export interface OnboardingState {
  firstRun: boolean;
  completedSteps: string[];
  lastVersion: string;
  preferredModel?: string;
  theme?: "dark" | "light" | "auto";
  editorMode?: "simple" | "helix";
  showTips: boolean;
}

const DEFAULT_STATE: OnboardingState = {
  firstRun: true,
  completedSteps: [],
  lastVersion: "0.0.0",
  showTips: true,
};

export async function loadOnboardingState(): Promise<OnboardingState> {
  try {
    const data = await readFile(STATE_FILE, "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveOnboardingState(state: OnboardingState): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function markStepComplete(step: string): Promise<void> {
  const state = await loadOnboardingState();
  if (!state.completedSteps.includes(step)) {
    state.completedSteps.push(step);
  }
  if (step === "welcome") state.firstRun = false;
  await saveOnboardingState(state);
}

export interface SetupCheck {
  id: string;
  label: string;
  status: "ok" | "missing" | "error";
  message: string;
  action?: string;
}

/**
 * Run setup checks to determine what's ready.
 */
export async function runSetupChecks(coreUrl: string): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  // 1. Core connection
  try {
    const res = await fetch(`${coreUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json() as { status: string; version?: string };
    checks.push({
      id: "core", label: t('doctor_core'),
      status: data.status === "ok" ? "ok" : "error",
      message: data.status === "ok" ? `v${data.version ?? "?"}` : "Core respondeu com erro",
    });
  } catch {
    checks.push({
      id: "core", label: t('doctor_core'),
      status: "missing",
      message: "Não conectado. Inicie o proxy em :21435.",
      action: "Verificar se o proxy está rodando",
    });
  }

  // 2. Identity (ECDSA key)
  try {
    const keyPath = join(homedir(), ".uptokey", "tui", "identity.json");
    await readFile(keyPath);
    checks.push({
      id: "identity", label: t('doctor_auth'),
      status: "ok",
      message: "Chave ECDSA P-256 presente",
    });
  } catch {
    checks.push({
      id: "identity", label: t('doctor_auth'),
      status: "missing",
      message: "Será criada automaticamente no primeiro uso",
    });
  }

  // 3. Models available
  try {
    const res = await fetch(`${coreUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json() as { data?: Array<{ id: string }> };
    const count = data.data?.length ?? 0;
    checks.push({
      id: "models", label: t('doctor_models'),
      status: count > 0 ? "ok" : "missing",
      message: count > 0 ? `${count} modelo${count > 1 ? "s" : ""} disponíve${count > 1 ? "is" : "l"}` : "Nenhum provedor configurado",
      action: count === 0 ? "Configure um provedor em /models" : undefined,
    });
  } catch {
    checks.push({
      id: "models", label: t('doctor_models'),
      status: "error",
      message: "Não foi possível verificar modelos",
    });
  }

  // 4. Git
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("git", ["--version"]);
    checks.push({
      id: "git", label: "Git",
      status: "ok",
      message: stdout.trim(),
    });
  } catch {
    checks.push({
      id: "git", label: "Git",
      status: "missing",
      message: "Git não encontrado. Checkpoints desabilitados.",
    });
  }

  return checks;
}

/**
 * Format setup checks for display.
 */
export function formatSetupChecks(checks: SetupCheck[]): string {
  return checks.map((c) => {
    const icon = c.status === "ok" ? "\x1b[32m✓\x1b[0m" : c.status === "missing" ? "\x1b[33m○\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const action = c.action ? `\n    → ${c.action}` : "";
    return `  ${icon} ${c.label}: ${c.message}${action}`;
  }).join("\n");
}

/**
 * Tips for progressive feature disclosure.
 */
export const TIPS: readonly string[] = [
  "Use / para abrir a paleta de comandos",
  "@ referencia arquivos no compositor",
  "Ctrl+S salva via ChangeSet/W5 no editor",
  "Digite durante streaming para redirecionar o agente (steer)",
  "/checkpoint mostra snapshots Git antes de alterações",
  "O contexto é compactado automaticamente em 85%",
  "/doctor verifica estado do sistema",
  "Esc fecha qualquer painel e volta ao chat",
  "Tab autocompleta comandos e arquivos",
  "Git checkpoints são criados antes de cada turno AI",
];

export function getRandomTip(): string {
  return TIPS[Math.floor(Math.random() * TIPS.length)]!;
}