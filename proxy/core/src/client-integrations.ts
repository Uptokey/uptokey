export const CLIENT_INFERENCE_ORIGIN = "http://127.0.0.1:21435";
export const CLIENT_INFERENCE_BASE_URL = `${CLIENT_INFERENCE_ORIGIN}/v1`;
export const CLIENT_INFERENCE_MODEL = "uptokey-auto";
export const CLIENT_TOKEN_PLACEHOLDER = "TOKEN_GERADO_ACIMA";

export const CLIENT_INTEGRATION_IDS = ["cline", "aider", "continue"] as const;
export type ClientIntegrationId = typeof CLIENT_INTEGRATION_IDS[number];

export type ClientIntegrationContract =
  | {
      client: "cline";
      kind: "manual-ui";
      provider: "OpenAI Compatible";
      baseUrl: string;
      apiKey: string;
      modelId: string;
      display: string;
    }
  | {
      client: "aider";
      kind: "environment-and-argv";
      environment: { OPENAI_API_BASE: string; OPENAI_API_KEY: string };
      argv: ["--model", string];
      display: string;
    }
  | {
      client: "continue";
      kind: "yaml";
      yaml: string;
      display: string;
    };

export function buildClientIntegrationContract(client: ClientIntegrationId, token = CLIENT_TOKEN_PLACEHOLDER): ClientIntegrationContract {
  if (!isClientCredential(token)) throw new Error("client_integration_token_invalid");
  if (client === "cline") {
    const display = [
      "1. Abra Cline > Settings (ícone de engrenagem).",
      '2. Em "API Provider", selecione "OpenAI Compatible".',
      `3. Em Base URL, informe: ${CLIENT_INFERENCE_BASE_URL}`,
      `4. Em API Key, cole: ${token}`,
      `5. Em Model ID, informe: ${CLIENT_INFERENCE_MODEL}`
    ].join("\n");
    return { client, kind: "manual-ui", provider: "OpenAI Compatible", baseUrl: CLIENT_INFERENCE_BASE_URL, apiKey: token, modelId: CLIENT_INFERENCE_MODEL, display };
  }
  if (client === "aider") {
    const environment = { OPENAI_API_BASE: CLIENT_INFERENCE_BASE_URL, OPENAI_API_KEY: token };
    const argv: ["--model", string] = ["--model", `openai/${CLIENT_INFERENCE_MODEL}`];
    const display = `$env:OPENAI_API_BASE="${environment.OPENAI_API_BASE}"\n$env:OPENAI_API_KEY="${environment.OPENAI_API_KEY}"\naider --model ${argv[1]}`;
    return { client, kind: "environment-and-argv", environment, argv, display };
  }
  const yaml = `name: Uptokey Local\nversion: 0.0.1\nschema: v1\n\nmodels:\n  - name: Uptokey Auto\n    provider: openai\n    model: ${CLIENT_INFERENCE_MODEL}\n    apiBase: ${CLIENT_INFERENCE_BASE_URL}\n    apiKey: ${token}`;
  return { client, kind: "yaml", yaml, display: yaml };
}

export function validateClientIntegrationContract(contract: ClientIntegrationContract): boolean {
  const common = contract.client === "cline"
    ? contract.kind === "manual-ui" && contract.provider === "OpenAI Compatible" && contract.baseUrl === CLIENT_INFERENCE_BASE_URL && contract.modelId === CLIENT_INFERENCE_MODEL && isClientCredential(contract.apiKey)
    : contract.client === "aider"
      ? contract.kind === "environment-and-argv" && contract.environment.OPENAI_API_BASE === CLIENT_INFERENCE_BASE_URL && isClientCredential(contract.environment.OPENAI_API_KEY) && contract.argv.length === 2 && contract.argv[0] === "--model" && contract.argv[1] === `openai/${CLIENT_INFERENCE_MODEL}`
      : contract.client === "continue" && contract.kind === "yaml" && exactContinueYaml(contract.yaml);
  return common && !/gsk_|AIza|sk_live_|utk_live_/i.test(contract.display);
}

export function clientCredentialFromContract(contract: ClientIntegrationContract): string {
  if (contract.client === "cline") return contract.apiKey;
  if (contract.client === "aider") return contract.environment.OPENAI_API_KEY;
  const match = /^    apiKey: ([^\r\n]+)$/m.exec(contract.yaml);
  if (!match?.[1] || !isClientCredential(match[1])) throw new Error("client_integration_contract_invalid");
  return match[1];
}

function exactContinueYaml(value: string): boolean {
  const match = /^name: Uptokey Local\nversion: 0\.0\.1\nschema: v1\n\nmodels:\n  - name: Uptokey Auto\n    provider: openai\n    model: uptokey-auto\n    apiBase: http:\/\/127\.0\.0\.1:21435\/v1\n    apiKey: ([^\r\n]+)$/.exec(value);
  return Boolean(match?.[1] && isClientCredential(match[1]));
}

function isClientCredential(value: string): boolean {
  return value === CLIENT_TOKEN_PLACEHOLDER || /^utk_local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{32}$/i.test(value);
}
