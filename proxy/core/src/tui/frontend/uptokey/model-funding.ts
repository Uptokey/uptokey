/** Funding is declared by the verified hosted catalog, never inferred from a provider's name or price. */
export function isHostedFreeModel(model: { options?: Record<string, unknown> } | undefined): boolean {
  return model?.options?.uptokeyFunding === "hosted-free"
}
