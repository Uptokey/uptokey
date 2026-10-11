export const VLLM_LOCAL_RUNTIME_NOTICE_VERSION = "vllm-local-runtime-v1";

export const VLLM_LOCAL_RUNTIME_NOTICE = [
  "vLLM é um runtime local nível 2 experimental (OpenAI-compatible em loopback).",
  "Uptokey não baixa pesos automaticamente para vLLM — configure o endpoint e o id do modelo já servido.",
  "Cada modelo mantém a própria licença (Llama, Gemma, Mistral, Qwen, DeepSeek, etc.); confira o autor antes de usar."
].join(" ");
