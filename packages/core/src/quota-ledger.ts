/**
 * Livro-razão e contabilidade local de quotas e orçamento de tokens
 */
export interface TokenUsageRecord {
  timestamp: number;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export interface QuotaLimit {
  maxTokensPerDay?: number;
  maxCostUsdPerMonth?: number;
  hardLimit: boolean;
}

export class QuotaLedger {
  private records: TokenUsageRecord[] = [];
  private limits: Map<string, QuotaLimit> = new Map();

  recordUsage(usage: TokenUsageRecord): void {
    this.records.push({ ...usage });
  }

  setLimit(provider: string, limit: QuotaLimit): void {
    this.limits.set(provider, limit);
  }

  getTotalTokens(provider?: string): number {
    return this.records
      .filter((r) => !provider || r.provider === provider)
      .reduce((acc, curr) => acc + curr.totalTokens, 0);
  }

  checkQuotaAllowed(provider: string, incomingTokensEstimate: number = 0): boolean {
    const limit = this.limits.get(provider);
    if (!limit || !limit.hardLimit || !limit.maxTokensPerDay) {
      return true;
    }

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const dailyTokens = this.records
      .filter((r) => r.provider === provider && r.timestamp >= oneDayAgo)
      .reduce((acc, curr) => acc + curr.totalTokens, 0);

    return dailyTokens + incomingTokensEstimate <= limit.maxTokensPerDay;
  }

  getRecords(): readonly TokenUsageRecord[] {
    return [...this.records];
  }
}
