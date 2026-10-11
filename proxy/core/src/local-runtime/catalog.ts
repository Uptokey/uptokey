export type LocalModelSuggestion = {
  /** Identificador de exibição (tag Ollama quando instalável por lá). */
  id: string;
  name: string;
  family: "llama" | "qwen" | "deepseek" | "mistral" | "gemma" | "phi" | "gpt-oss" | "granite" | "nemotron" | "smollm" | "whisper" | "llava" | "embeddings" | "code";
  sizeNote: "small" | "medium" | "large";
  runtime: "ollama" | "manual";
  /** Tag real do Ollama, quando existe; sem tag = sem instalação via ollama pull. */
  ollamaTag?: string;
  /** Comando executável de instalação (somente quando ollamaTag existe). */
  installCommand?: string;
  /** Link oficial de download/fonte pública (Hugging Face etc.). */
  hfUrl: string;
  /** Licença quando confirmada; null = conferir no repositório oficial. */
  license: string | null;
  tags: readonly string[];
  /** Download size from the linked registry snapshot, not a VRAM requirement. */
  sizeBytes?: number;
  /** Approximate download range where one alias selects multiple distributions. */
  sizeRangeBytes?: readonly [number, number];
  sourceUrl?: string;
  reviewedAt?: string;
};

/**
 * Curated registry suggestions. Display order is not a benchmark or a claim
 * of market popularity; consumers can rank the estimates for their device.
 * O proxy NUNCA baixa automaticamente; a UI oferece instalação por ação
 * explícita (ollama pull) ou o link oficial de download.
 */
export const LOCAL_MODEL_SUGGESTIONS: readonly LocalModelSuggestion[] = [
  ...[
    ['qwen3:0.6b', 'Qwen 3 0.6B', 'qwen', 523_000_000, ['chat','tools','reasoning']],
    ['qwen3:1.7b', 'Qwen 3 1.7B', 'qwen', 1_400_000_000, ['chat','tools','reasoning']],
    ['qwen3:4b', 'Qwen 3 4B', 'qwen', 2_500_000_000, ['chat','tools','reasoning']],
    ['qwen3:8b', 'Qwen 3 8B', 'qwen', 5_200_000_000, ['chat','tools','reasoning']],
    ['qwen3:14b', 'Qwen 3 14B', 'qwen', 9_300_000_000, ['chat','tools','reasoning']],
    ['qwen3:30b', 'Qwen 3 30B', 'qwen', 19_000_000_000, ['chat','tools','reasoning']],
    ['qwen3:32b', 'Qwen 3 32B', 'qwen', 20_000_000_000, ['chat','tools','reasoning']],
    ['qwen3:235b', 'Qwen 3 235B', 'qwen', 142_000_000_000, ['chat','tools','reasoning']],
    ['qwen3-coder:30b', 'Qwen 3 Coder 30B', 'qwen', 19_000_000_000, ['code','tools']],
    ['qwen3-coder:480b', 'Qwen 3 Coder 480B', 'qwen', 290_000_000_000, ['code','tools']],
    ['gemma3:12b', 'Gemma 3 12B', 'gemma', 8_100_000_000, ['chat','vision']],
    ['gemma3:27b', 'Gemma 3 27B', 'gemma', 17_000_000_000, ['chat','vision']],
    ['gpt-oss:20b', 'GPT OSS 20B', 'gpt-oss', 14_000_000_000, ['chat','code','tools','reasoning']],
    ['gpt-oss:120b', 'GPT OSS 120B', 'gpt-oss', 65_000_000_000, ['chat','code','tools','reasoning']],
  ].map(([id, name, family, sizeBytes, tags]) => ({
    id: id as string, name: name as string, family: family as LocalModelSuggestion['family'],
    sizeNote: (Number(sizeBytes)<2_000_000_000?'small':Number(sizeBytes)<8_000_000_000?'medium':'large') as LocalModelSuggestion['sizeNote'],
    runtime: 'ollama' as const, ollamaTag: id as string, installCommand: `ollama pull ${id}`,
    hfUrl: `https://ollama.com/library/${String(id).split(':')[0]}`,
    sourceUrl: `https://ollama.com/library/${String(id).split(':')[0]}/tags`,
    reviewedAt: '2026-10-03', sizeBytes: sizeBytes as number, license: null, tags: tags as string[],
  })),
  // Rounded sizes of these exact registry tags; not unquantized publisher weights.
  { id: "llama3.2:3b", name: "Llama 3.2 3B", family: "llama", sizeNote: "small", runtime: "ollama", ollamaTag: "llama3.2:3b", installCommand: "ollama pull llama3.2:3b", hfUrl: "https://huggingface.co/meta-llama/Llama-3.2-3B", sourceUrl: "https://ollama.com/library/llama3.2:3b", reviewedAt: "2026-10-05", sizeBytes: 2_000_000_000, license: null, tags: ["chat", "geral", "bilingue"] },
  { id: "llama3.2:1b", name: "Llama 3.2 1B", family: "llama", sizeNote: "small", runtime: "ollama", ollamaTag: "llama3.2:1b", installCommand: "ollama pull llama3.2:1b", hfUrl: "https://huggingface.co/meta-llama/Llama-3.2-1B", sourceUrl: "https://ollama.com/library/llama3.2:1b", reviewedAt: "2026-10-05", sizeBytes: 1_300_000_000, license: null, tags: ["chat", "leve", "edge"] },
  { id: "llama3.3:70b", name: "Llama 3.3 70B", family: "llama", sizeNote: "large", runtime: "ollama", ollamaTag: "llama3.3:70b", installCommand: "ollama pull llama3.3:70b", hfUrl: "https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct", sourceUrl: "https://ollama.com/library/llama3.3:70b", reviewedAt: "2026-10-05", sizeBytes: 43_000_000_000, license: null, tags: ["chat", "raciocínio", "grande"] },
  { id: "qwen2.5-coder:7b", name: "Qwen 2.5 Coder 7B", family: "qwen", sizeNote: "medium", runtime: "ollama", ollamaTag: "qwen2.5-coder:7b", installCommand: "ollama pull qwen2.5-coder:7b", hfUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct", sourceUrl: "https://ollama.com/library/qwen2.5-coder:7b", reviewedAt: "2026-10-05", sizeBytes: 4_700_000_000, license: "Apache-2.0", tags: ["código", "programação"] },
  { id: "qwen2.5:1.5b", name: "Qwen 2.5 1.5B", family: "qwen", sizeNote: "small", runtime: "ollama", ollamaTag: "qwen2.5:1.5b", installCommand: "ollama pull qwen2.5:1.5b", hfUrl: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct", sourceUrl: "https://ollama.com/library/qwen2.5:1.5b", reviewedAt: "2026-10-05", sizeBytes: 986_000_000, license: "Apache-2.0", tags: ["chat", "leve"] },
  { id: "deepseek-r1:8b", name: "DeepSeek R1 8B", family: "deepseek", sizeNote: "medium", runtime: "ollama", ollamaTag: "deepseek-r1:8b", installCommand: "ollama pull deepseek-r1:8b", hfUrl: "https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Llama-8B", sourceUrl: "https://ollama.com/library/deepseek-r1:8b", reviewedAt: "2026-10-05", sizeBytes: 5_200_000_000, license: "MIT", tags: ["raciocínio", "chain-of-thought"] },
  { id: "deepseek-r1:1.5b", name: "DeepSeek R1 1.5B", family: "deepseek", sizeNote: "small", runtime: "ollama", ollamaTag: "deepseek-r1:1.5b", installCommand: "ollama pull deepseek-r1:1.5b", hfUrl: "https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B", sourceUrl: "https://ollama.com/library/deepseek-r1:1.5b", reviewedAt: "2026-10-05", sizeBytes: 1_100_000_000, license: "MIT", tags: ["raciocínio", "leve"] },
  { id: "mistral:7b", name: "Mistral 7B", family: "mistral", sizeNote: "medium", runtime: "ollama", ollamaTag: "mistral:7b", installCommand: "ollama pull mistral:7b", hfUrl: "https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3", sourceUrl: "https://ollama.com/library/mistral:7b", reviewedAt: "2026-10-05", sizeBytes: 4_400_000_000, license: "Apache-2.0", tags: ["chat", "geral"] },
  { id: "codestral:22b", name: "Codestral 22B", family: "mistral", sizeNote: "large", runtime: "ollama", ollamaTag: "codestral:22b", installCommand: "ollama pull codestral:22b", hfUrl: "https://huggingface.co/mistralai/Codestral-22B-v0.1", sourceUrl: "https://ollama.com/library/codestral:22b", reviewedAt: "2026-10-05", sizeBytes: 13_000_000_000, license: null, tags: ["código", "fill-in-the-middle"] },
  { id: "gemma3:4b", name: "Gemma 3 4B", family: "gemma", sizeNote: "medium", runtime: "ollama", ollamaTag: "gemma3:4b", installCommand: "ollama pull gemma3:4b", hfUrl: "https://huggingface.co/google/gemma-3-4b-it", sourceUrl: "https://ollama.com/library/gemma3:4b", reviewedAt: "2026-10-05", sizeBytes: 3_300_000_000, license: null, tags: ["chat", "multimodal"] },
  { id: "gemma3:1b", name: "Gemma 3 1B", family: "gemma", sizeNote: "small", runtime: "ollama", ollamaTag: "gemma3:1b", installCommand: "ollama pull gemma3:1b", hfUrl: "https://huggingface.co/google/gemma-3-1b-it", sourceUrl: "https://ollama.com/library/gemma3:1b", reviewedAt: "2026-10-05", sizeBytes: 815_000_000, license: null, tags: ["chat", "leve"] },
  { id: "phi4-mini", name: "Phi-4 Mini", family: "phi", sizeNote: "medium", runtime: "ollama", ollamaTag: "phi4-mini", installCommand: "ollama pull phi4-mini", hfUrl: "https://huggingface.co/microsoft/Phi-4-mini-instruct", sourceUrl: "https://ollama.com/library/phi4-mini:latest", reviewedAt: "2026-10-05", sizeBytes: 2_500_000_000, license: "MIT", tags: ["chat", "raciocínio"] },
  { id: "whisper", name: "Whisper", family: "whisper", sizeNote: "medium", runtime: "ollama", hfUrl: "https://huggingface.co/openai/whisper-large-v3", sourceUrl: "https://huggingface.co/openai/whisper-large-v3/blob/main/model.safetensors", reviewedAt: "2026-10-05", sizeBytes: 3_090_000_000, license: "Apache-2.0", tags: ["áudio", "transcrição", "voz"] },
  { id: "llava:7b", name: "LLaVA 7B", family: "llava", sizeNote: "medium", runtime: "ollama", ollamaTag: "llava:7b", installCommand: "ollama pull llava:7b", hfUrl: "https://huggingface.co/liuhaotian/llava-v1.6-vicuna-7b", sourceUrl: "https://ollama.com/library/llava:7b", reviewedAt: "2026-10-05", sizeBytes: 4_700_000_000, license: null, tags: ["imagem", "visão", "multimodal"] },
  { id: "nomic-embed-text", name: "Nomic Embed", family: "embeddings", sizeNote: "small", runtime: "ollama", ollamaTag: "nomic-embed-text", installCommand: "ollama pull nomic-embed-text", hfUrl: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5", sourceUrl: "https://ollama.com/library/nomic-embed-text:latest", reviewedAt: "2026-10-05", sizeBytes: 274_000_000, license: "Apache-2.0", tags: ["embeddings", "busca", "rag"] },
  { id: "starcoder2:3b", name: "StarCoder2 3B", family: "code", sizeNote: "small", runtime: "ollama", ollamaTag: "starcoder2:3b", installCommand: "ollama pull starcoder2:3b", hfUrl: "https://huggingface.co/bigcode/starcoder2-3b", sourceUrl: "https://ollama.com/library/starcoder2:3b", reviewedAt: "2026-10-05", sizeBytes: 1_700_000_000, license: null, tags: ["código", "autocompletar"] },
  { id: "sqlcoder:7b", name: "SQLCoder 7B", family: "code", sizeNote: "medium", runtime: "ollama", ollamaTag: "sqlcoder:7b", installCommand: "ollama pull sqlcoder:7b", hfUrl: "https://huggingface.co/defog/sqlcoder-7b-2", sourceUrl: "https://ollama.com/library/sqlcoder:7b", reviewedAt: "2026-10-05", sizeBytes: 4_100_000_000, license: null, tags: ["sql", "banco de dados"] },
  ...[
    ['qwen3.5:0.8b', 'Qwen 3.5 0.8B', 'qwen', 1_000_000_000, 'Apache-2.0', ['chat','vision','tools','reasoning']],
    ['qwen3.5:2b', 'Qwen 3.5 2B', 'qwen', 2_700_000_000, 'Apache-2.0', ['chat','vision','tools','reasoning']],
    ['qwen3.5:4b', 'Qwen 3.5 4B', 'qwen', 3_400_000_000, 'Apache-2.0', ['chat','vision','tools','reasoning']],
    ['qwen3.5:9b', 'Qwen 3.5 9B', 'qwen', 6_600_000_000, 'Apache-2.0', ['chat','vision','tools','reasoning']],
    ['qwen3.5:27b', 'Qwen 3.5 27B', 'qwen', 17_000_000_000, 'Apache-2.0', ['chat','vision','tools','reasoning']],
    ['qwen3.5:35b', 'Qwen 3.5 35B', 'qwen', 24_000_000_000, 'Apache-2.0', ['chat','vision','tools','reasoning']],
    ['qwen3.5:122b', 'Qwen 3.5 122B', 'qwen', 81_000_000_000, 'Apache-2.0', ['chat','vision','tools','reasoning']],
    ['granite4:3b', 'Granite 4 3B', 'granite', 2_100_000_000, 'Apache-2.0', ['chat','code','tools']],
    ['nemotron-3-nano:4b', 'Nemotron 3 Nano 4B', 'nemotron', 2_800_000_000, 'NVIDIA Open Model License', ['chat','tools','reasoning']],
    ['nemotron-3-nano:30b', 'Nemotron 3 Nano 30B', 'nemotron', 24_000_000_000, 'NVIDIA Open Model License', ['chat','tools','reasoning']],
  ].map(([id, name, family, sizeBytes, license, tags]) => ({
    id: id as string, name: name as string, family: family as LocalModelSuggestion['family'],
    sizeNote: (Number(sizeBytes)<2_000_000_000?'small':Number(sizeBytes)<8_000_000_000?'medium':'large') as LocalModelSuggestion['sizeNote'],
    runtime: 'ollama' as const, ollamaTag: id as string, installCommand: `ollama pull ${id}`,
    hfUrl: `https://ollama.com/library/${String(id).split(':')[0]}`,
    sourceUrl: `https://ollama.com/library/${String(id).split(':')[0]}/tags`,
    reviewedAt: '2026-10-04', sizeBytes: sizeBytes as number, license: license as string, tags: tags as string[],
  })),
  // MLX and llama.cpp distributions share these aliases. Retain the whole
  // published download interval instead of inferring weights from active params.
  ...([
    ['gemma4:e2b', 'Gemma 4 E2B', 'medium', [4_600_000_000, 7_500_000_000]],
    ['gemma4:e4b', 'Gemma 4 E4B', 'medium', [6_600_000_000, 9_500_000_000]],
    ['gemma4:12b', 'Gemma 4 12B', 'large', [7_700_000_000, 8_000_000_000]],
    ['gemma4:26b', 'Gemma 4 26B', 'large', [16_000_000_000, 19_000_000_000]],
    ['gemma4:31b', 'Gemma 4 31B', 'large', [19_000_000_000, 20_000_000_000]],
  ] as const).map(([id, name, sizeNote, sizeRangeBytes]) => ({
    id: id!, name: name!, family: 'gemma' as const,
    sizeNote: sizeNote as LocalModelSuggestion['sizeNote'], runtime: 'ollama' as const,
    ollamaTag: id!, installCommand: `ollama pull ${id}`,
    hfUrl: `https://ollama.com/library/${id}`,
    sourceUrl: `https://ollama.com/library/${id}`, reviewedAt: '2026-10-05',
    sizeRangeBytes: sizeRangeBytes as readonly [number, number],
    license: 'Apache-2.0', tags: ['chat','code','vision','tools','reasoning'],
  })),
  { id: 'SmolLM3-3B', name: 'SmolLM3 3B', family: 'smollm', sizeNote: 'medium', runtime: 'manual',
    hfUrl: 'https://huggingface.co/HuggingFaceTB/SmolLM3-3B', sourceUrl: 'https://huggingface.co/HuggingFaceTB/SmolLM3-3B',
    license: 'Apache-2.0', tags: ['chat','code','reasoning','tools'], reviewedAt: '2026-10-05', sizeBytes: 6_150_000_000 },
];
