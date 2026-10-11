export const MAX_PROVIDER_BUDGET = 1_000_000_000;

export interface GeminiUserBudget {
  rpm: number;
  tpm: number;
  rpd?: number;
  source: "account_user_input";
}

export function parsePositiveProviderBudget(value: string, field: string): number {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) throw new Error(`${field} deve ser inteiro positivo.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_PROVIDER_BUDGET) {
    throw new Error(`${field} deve ser inteiro positivo de no máximo ${MAX_PROVIDER_BUDGET}.`);
  }
  return parsed;
}

export async function collectGeminiUserBudget(question: (prompt: string) => Promise<string>): Promise<GeminiUserBudget> {
  const rpm = parsePositiveProviderBudget(await question("RPM exibido no AI Studio: "), "RPM");
  const tpm = parsePositiveProviderBudget(await question("TPM exibido no AI Studio: "), "TPM");
  const rpdRaw = (await question("RPD exibido (vazio se não informado): ")).trim();
  return { rpm, tpm, ...(rpdRaw ? { rpd: parsePositiveProviderBudget(rpdRaw, "RPD") } : {}), source: "account_user_input" };
}
