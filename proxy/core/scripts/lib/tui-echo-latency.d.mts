export interface EchoScreenTiming {
  receivedAt: number;
  parseStartedAt: number;
  parsedAt: number;
  bytes: number;
}

export interface EchoLatencySample {
  inputToOutputMs: number;
  harnessQueueMs: number;
  harnessParseMs: number;
  inputToParsedMs: number;
  observedMs: number;
  bytes: number;
}

export interface EchoTerminal {
  child: { write(value: string): void };
  screen(): string;
  until(check: () => boolean, message: string, timeoutMs?: number): Promise<void>;
  observeScreen?(callback: (timing: EchoScreenTiming) => void): () => void;
}

export interface EchoLatencyOptions {
  marker?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  beforeSample?: () => void;
  onSample?: (sample: EchoLatencySample) => void;
}

export function echoLatency(
  term: EchoTerminal,
  text: string,
  gapMs?: number,
  options?: EchoLatencyOptions,
): Promise<number[]>;
