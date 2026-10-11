import type { ProxyConfig } from "./types.ts";
import { GEMINI_FREE_PRIVACY_NOTICE } from "./privacy.ts";
import { isUserDefinedProvider, MAX_PROVIDERS, NAMED_EXPERIMENTAL_DEFAULTS, NAMED_EXPERIMENTAL_PROVIDERS } from "./provider-registry.ts";
import { NAMED_PROVIDER_RISK_NOTICES } from "./provider-risk.ts";
import { OLLAMA_MODEL_LICENSE_NOTICE } from "./ollama-risk.ts";
import { VLLM_LOCAL_RUNTIME_NOTICE } from "./vllm-risk.ts";
import { buildClientIntegrationContract, CLIENT_TOKEN_PLACEHOLDER } from "./client-integrations.ts";
import {localSetupModel,localSetupProvider,localSetupConnection} from "./local-setup-handoff.ts";
import { redactEndpointCredentials } from "./endpoint-policy.ts";
import { workspaceBrowserIdentity } from '@uptokey/sync-contract/browser-identity';
import { CLIENT_KEY_SCOPES } from '@uptokey/sync-contract/client-keys';

export function localUiHtml(config: ProxyConfig, nonce: string, setupSearch = new URLSearchParams()): string {
  const requestedLang = (setupSearch.get("lang") ?? "").toLowerCase();
  const uiLang = requestedLang.startsWith("ar") ? "ar" : requestedLang.startsWith("pt") ? "pt-BR" : requestedLang.startsWith("es") ? "es" : requestedLang.startsWith("fr") ? "fr" : requestedLang.startsWith("de") ? "de" : requestedLang.startsWith("it") ? "it" : requestedLang.startsWith("ja") ? "ja" : requestedLang.startsWith("ko") ? "ko" : requestedLang.startsWith("zh") ? "zh-CN" : "en";
  const uiDir = uiLang === "ar" ? "rtl" : "ltr";
  const groq = config.providers.groq;
  const gemini = config.providers.gemini;
  // SPEC-061: o endpoint é a única string de configuração que pode conter credencial embutida.
  // A escrita já recusa `?api_key=`/`#token=`, mas a renderização também redige — uma config
  // gravada antes desse guard não pode transformar o mini-UI em canal de vazamento da chave.
  const ollamaEndpoint = redactEndpointCredentials(config.providers.ollama?.endpointUrl ?? "http://127.0.0.1:11434/v1/chat/completions");
  const ollamaModel = localSetupModel(setupSearch) ?? config.providers.ollama?.defaultModel ?? "llama3.2";
  const vllmEndpoint = redactEndpointCredentials(config.providers.vllm?.endpointUrl ?? "http://127.0.0.1:8000/v1/chat/completions");
  const vllmModel = config.providers.vllm?.defaultModel ?? "default";
  const customEndpoint = config.providers.custom?.endpointUrl === "https://example.invalid/v1/chat/completions" ? "" : redactEndpointCredentials(config.providers.custom?.endpointUrl ?? "");
  const customModel = config.providers.custom?.defaultModel === "custom-model" ? "" : config.providers.custom?.defaultModel ?? "";
  const selectedProvider = localSetupProvider(setupSearch);
  const selectedNamed = selectedProvider && Object.prototype.hasOwnProperty.call(NAMED_EXPERIMENTAL_DEFAULTS, selectedProvider)
    ? NAMED_EXPERIMENTAL_DEFAULTS[selectedProvider as keyof typeof NAMED_EXPERIMENTAL_DEFAULTS]
    : undefined;
  const selectedEndpoint = selectedProvider
    ? redactEndpointCredentials(config.providers[selectedProvider]?.endpointUrl ?? selectedNamed?.endpointUrl ?? "")
    : ollamaEndpoint;
  const selectedModel = selectedProvider
    ? (config.providers[selectedProvider]?.defaultModel ?? selectedNamed?.defaultModel ?? "")
    : ollamaModel;
  const selectedNotice = selectedProvider
    ? (NAMED_PROVIDER_RISK_NOTICES[selectedProvider as keyof typeof NAMED_PROVIDER_RISK_NOTICES]?.summary ?? "Endpoint OpenAI-compatible configurado pelo usuário; a chave fica no cofre local.")
    : OLLAMA_MODEL_LICENSE_NOTICE;
  const route = config.fallbackOrder.filter(name => config.providers[name]?.enabled && config.providers[name]?.configured).join(" → ") || "Nenhuma conexão ativa";
  const safeNonce = escapeHtml(nonce);
  const clineSteps = buildClientIntegrationContract("cline", CLIENT_TOKEN_PLACEHOLDER).display;
  const aiderTemplate = buildClientIntegrationContract("aider", CLIENT_TOKEN_PLACEHOLDER).display;
  const continueTemplate = buildClientIntegrationContract("continue", CLIENT_TOKEN_PLACEHOLDER).display;

  // Collect user-defined providers (custom-*)
  const userDefinedProviders = Object.keys(config.providers)
    .filter(isUserDefinedProvider)
    .map((name) => {
      const entry = (config.providers as Record<string, typeof config.providers.groq>)[name]!;
      return { name, endpoint: redactEndpointCredentials(entry.endpointUrl ?? ""), model: entry.defaultModel, enabled: entry.enabled, configured: entry.configured };
    });
  const editingConnection=userDefinedProviders.find(provider=>provider.name===localSetupConnection(setupSearch));

  return `<!doctype html>
<html lang="${uiLang}" dir="${uiDir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Uptokey — Conexões deste computador</title>
  <style nonce="${safeNonce}">
    :root {
      color-scheme: light dark;
      --bg: #0b0f14;
      --panel: #121821;
      --panel-hover: #18202c;
      --line: #263241;
      --line-subtle: #1c2633;
      --ink: #e7ebef;
      --muted: #9aa6b4;
      --faint: #637083;
      --ok: #47d18c;
      --ok-wash: rgba(71, 209, 140, 0.12);
      --warn: #e3b341;
      --warn-wash: rgba(227, 179, 65, 0.12);
      --bad: #ff6b61;
      --accent: #a5a9ff;
      --accent-hover: #c0c3ff;
      --accent-wash: rgba(63, 194, 204, 0.12);
      --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--ink); font-family: var(--font); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
    main { max-width: 1060px; margin: 0 auto; padding: 36px 20px 64px; }

    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .logo-badge { width: 36px; height: 36px; border-radius: 8px; background: var(--accent-wash); border: 1px solid var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 800; color: var(--accent); font-size: 18px; }
    h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
    .header-badges { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

    .pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 5px 11px; color: var(--muted); font-size: 12px; font-family: var(--mono); background: var(--panel); }
    .pill code { color: var(--ink); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); display: inline-block; }
    .dot.muted { background: var(--muted); }
    .pill.on { border-color: var(--ok); color: var(--ok); background: var(--ok-wash); }
    .pill.on .dot { background: var(--ok); }
    .pill.configured { border-color: var(--warn); color: var(--warn); background: var(--warn-wash); }
    .pill.configured .dot { background: var(--warn); }

    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 18px; margin-bottom: 24px; }
    .grid-1 { display: grid; grid-template-columns: 1fr; gap: 18px; margin-bottom: 24px; }

    section.card { border: 1px solid var(--line); background: var(--panel); border-radius: 10px; padding: 20px; position: relative; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    h2 { font-size: 16px; font-weight: 650; display: flex; align-items: center; gap: 8px; }

    label { display: block; color: var(--muted); font-size: 12px; font-weight: 500; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    input[type="password"], input[type="text"], select { width: 100%; border: 1px solid var(--line); background: #0d131b; color: var(--ink); border-radius: 6px; padding: 10px 12px; font-size: 13px; font-family: var(--mono); transition: border-color 0.15s; }
    input[type="password"]:focus, input[type="text"]:focus { outline: none; border-color: var(--accent); }

    .btn-row { display: flex; gap: 10px; margin-top: 14px; }
    button { border: 0; background: var(--accent); color: #041214; border-radius: 6px; padding: 9px 14px; font-size: 13px; font-weight: 650; cursor: pointer; transition: background-color 0.15s, opacity 0.15s; }
    button:hover { background: var(--accent-hover); }
    button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
    button.secondary:hover { background: var(--panel-hover); border-color: var(--muted); }
    button:disabled { opacity: 0.55; cursor: wait; }

    .notice { color: var(--muted); font-size: 12.5px; line-height: 1.45; margin: 10px 0; padding: 10px 12px; background: rgba(0,0,0,0.2); border-left: 3px solid var(--line); border-radius: 0 6px 6px 0; }
    .notice.warn { border-left-color: var(--warn); background: var(--warn-wash); color: #e7cf93; }
    .msg { min-height: 20px; font-size: 12px; color: var(--muted); margin-top: 10px; font-family: var(--mono); word-break: break-all; }
    .msg.ok { color: var(--ok); }
    .msg.err { color: var(--bad); }

    .consent-box { display: flex; align-items: flex-start; gap: 9px; margin-top: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: #0d131b; font-size: 12.5px; }
    .consent-box input { margin-top: 3px; cursor: pointer; }
    .consent-box span { color: var(--ink); }

    /* Tabs de Integração IDE */
    .tabs-nav { display: flex; gap: 6px; border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 14px; overflow-x: auto; }
    .tab-btn { background: transparent; border: 1px solid transparent; color: var(--muted); padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .tab-btn:hover { color: var(--ink); background: var(--panel-hover); }
    .tab-btn.active { color: var(--accent); background: var(--accent-wash); border-color: rgba(63, 194, 204, 0.3); }

    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    .code-container { position: relative; margin-top: 10px; }
    pre { margin: 0; background: #080c11; border: 1px solid var(--line); border-radius: 6px; padding: 14px; color: #ced7e0; font-family: var(--mono); font-size: 12.5px; overflow-x: auto; line-height: 1.5; }
    .copy-btn { position: absolute; top: 10px; right: 10px; padding: 5px 10px; font-size: 11px; background: var(--panel); border: 1px solid var(--line); color: var(--ink); border-radius: 4px; }
    .copy-btn:hover { background: var(--line); }
    .copy-btn.copied { border-color: var(--ok); color: var(--ok); }

    /* Observabilidade / Health */
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 12px; }
    .metric-box { background: #0d131b; border: 1px solid var(--line); border-radius: 6px; padding: 12px; }
    .metric-title { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .metric-value { font-size: 16px; font-weight: 700; font-family: var(--mono); margin-top: 4px; color: var(--ink); }
    .metric-value.small-muted { font-size: 13px; color: var(--muted); }
    .metric-value.ok { color: var(--ok); }
    .compact-button { margin-top: 0; padding: 4px 10px; font-size: 12px; }
    .revoke-label { margin-top: 20px; }

    .footer-note { text-align: center; color: var(--faint); font-size: 12px; margin-top: 36px; }
    .footer-note code { font-family: var(--mono); color: var(--muted); }
    .status-feed { margin-top: 14px; }
    .help-list { margin: 10px 0 0; padding-left: 18px; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .help-list strong { color: var(--text); }
    a { color: var(--accent); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
    .connection-intro { margin-bottom: 24px; }
    .connection-intro h2 { font-size: clamp(24px, 5vw, 36px); margin-bottom: 8px; }
    .connection-intro p { color: var(--muted); max-width: 70ch; }
    .connection-intro nav { margin-top: 16px; }
    .connection-presets { margin-bottom: 24px; }
    .connection-presets summary { cursor: pointer; padding: 16px 0; font-weight: 650; }
    @media (max-width: 600px) {
      main { padding: 24px 14px 40px; }
      .grid-2 { grid-template-columns: minmax(0, 1fr); }
      .card-header, .btn-row { flex-wrap: wrap; gap: 10px; }
      section.card { padding: 16px; min-width: 0; }
      .pill { max-width: 100%; overflow-wrap: anywhere; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">
        <div class="logo-badge">U</div>
        <div>
          <h1>Uptokey</h1>
          <p class="sub">Conexões deste computador · painel auxiliar do proxy</p>
          <p class="sub">Proxy loopback em <code>127.0.0.1:21435</code> • Chaves ficam no cofre nativo e não vão para a Cloud Uptokey</p>
        </div>
      </div>
      <div class="header-badges">
        <span class="pill">rota: <code>${escapeHtml(route)}</code></span>
        <span class="pill on"><i class="dot"></i> 127.0.0.1:21435</span>
      </div>
    </header>

    <section class="connection-intro"><h2>Seus modelos. Suas conexões.</h2><p>Conecte uma API ou um modelo já instalado. Este painel configura o proxy local; não substitui o dashboard do produto.</p><nav aria-label="Configurar conexões"><a href="#api-connections">Adicionar uma API</a> · <a href="#optional-provider-form">Usar um modelo local</a></nav></section>
    <details class="connection-presets"><summary>Core / public APIs — Groq ou Google Gemini</summary>
    <div class="grid-2">
      ${providerCard("groq", "Groq", groq.configured, groq.enabled, "Cole sua chave Groq")}
      ${providerCard("gemini", "Google Gemini", gemini.configured, gemini.enabled, "Cole sua chave Gemini", true)}
    </div>

    </details>
    <!-- CONEXOES: Local | Cloud BYOK | (Core já acima) -->
    <div class="grid-1">
      <section class="card">
        <div class="card-header">
          <h2>Modelos locais e outras APIs</h2>
          <span class="pill"><i class="dot muted"></i> Configuração manual</span>
        </div>
        <p class="notice">
          Separe runtimes locais (Ollama/vLLM) de APIs cloud BYOK e das APIs públicas/core (Groq/Gemini acima). Gemma/Qwen/Llama são pesos sob um runtime — não providers novos. Aliases <code>@local</code>, <code>@gemma</code>, <code>@qwen</code> resolvem para um modelo local. Cloud <code>deepseek</code>/<code>mistral</code> são providers distintos. O proxy envia solicitações ao destino configurado, sem passar pela nuvem Uptokey.
        </p>
        <form id="optional-provider-form">
          <label for="optional-provider-name">Escolha a conexão</label>
          <select id="optional-provider-name">
            <optgroup label="Local runtimes (nível 2)">
              <option value="ollama" data-endpoint="${escapeHtml(ollamaEndpoint)}" data-model="${escapeHtml(ollamaModel)}" data-notice="${escapeHtml(OLLAMA_MODEL_LICENSE_NOTICE)}">Ollama local — nível 2 experimental</option>
              <option value="vllm" data-endpoint="${escapeHtml(vllmEndpoint)}" data-model="${escapeHtml(vllmModel)}" data-notice="${escapeHtml(VLLM_LOCAL_RUNTIME_NOTICE)}">vLLM local — nível 2 experimental</option>
            </optgroup>
            <optgroup label="Cloud BYOK (nível 3)">
            ${NAMED_EXPERIMENTAL_PROVIDERS.map((name) => {
            const preset = NAMED_EXPERIMENTAL_DEFAULTS[name];
            const current = config.providers[name];
            const endpoint = redactEndpointCredentials(current?.endpointUrl ?? preset.endpointUrl);
            const model = current?.defaultModel ?? preset.defaultModel;
            const label = `${name} — nível 3 user-managed/OpenAI-compatible`;
            const notice = NAMED_PROVIDER_RISK_NOTICES[name];
            return `<option value="${name}"${selectedProvider === name ? " selected" : ""} data-endpoint="${escapeHtml(endpoint)}" data-model="${escapeHtml(model)}" data-notice="${escapeHtml(notice.summary)}" data-notice-source="${escapeHtml(notice.sourceUrl)}" data-notice-reviewed="${escapeHtml(notice.reviewedAt)}">${escapeHtml(label)}</option>`;
          }).join("")}
            <option value="custom" data-endpoint="${escapeHtml(customEndpoint)}" data-model="${escapeHtml(customModel)}" data-notice="Endpoint custom é responsabilidade do usuário; remoto exige HTTPS e recebe prompt/resposta diretamente deste device.">Custom — nível 3 user-managed/OpenAI-compatible</option>
            </optgroup>
          </select>
          <label for="optional-provider-endpoint">Endpoint completo de Chat Completions</label>
          <input id="optional-provider-endpoint" type="text" maxlength="2048" value="${escapeHtml(selectedEndpoint)}" autocomplete="off" spellcheck="false">
          <label for="optional-provider-model">Modelo exposto pelo endpoint</label>
          <input id="optional-provider-model" type="text" maxlength="200" value="${escapeHtml(selectedModel)}" autocomplete="off" spellcheck="false">
          <label for="optional-provider-key">Chave opcional</label>
          <input id="optional-provider-key" type="password" maxlength="512" value="" autocomplete="new-password">
          <p class="notice">Ollama, vLLM e endpoint custom em loopback podem ficar sem chave. Presets nomeados usam somente o endpoint oficial fixado; endpoint custom remoto exige HTTPS e chave. A chave vai somente para o cofre nativo. Instalação de pesos continua só via Ollama (<code>uptokey models install</code>).</p>
          <p id="optional-provider-risk" class="notice">${escapeHtml(selectedNotice)}</p>
          <p class="notice">Fonte oficial consultada em <time id="optional-provider-risk-reviewed"></time>: <a id="optional-provider-risk-source" target="_blank" rel="noopener noreferrer">Abrir termos e política do provedor</a></p>
          <label class="consent-box" for="optional-provider-ack">
            <input id="optional-provider-ack" type="checkbox">
            <span>Li o aviso específico acima e aceito ativar este canal neste device.</span>
          </label>
          <div class="btn-row">
            <button type="submit" id="optional-provider-save-btn">Salvar e ativar</button>
          </div>
          <div id="optional-provider-msg" class="msg">Nenhum canal opcional alterado nesta sessão.</div>
        </form>
        <div class="card-header" style="margin-top:18px"><h2>Modelos locais descobertos</h2><button type="button" id="refresh-local-models-btn" class="secondary compact-button">Atualizar lista</button></div>
        <p class="notice">Tamanhos e capacidade são <strong>estimativa</strong> (Ollama reporta size; vLLM via OpenAI models list costuma não informar — rótulo <em>estimativa indisponível</em>).</p>
        <div id="local-models-feed" class="msg status-feed">Carregue a lista com o botão acima (requer token/sessão local).</div>
        <div class="metric-grid">
          <div class="metric-box"><div class="metric-title">Ollama Local</div><div class="metric-value small-muted">http://127.0.0.1:11434</div></div>
          <div class="metric-box"><div class="metric-title">vLLM Local</div><div class="metric-value small-muted">http://127.0.0.1:8000</div></div>
          <div class="metric-box"><div class="metric-title">Custódia pela Uptokey Cloud</div><div class="metric-value ok">Nenhuma</div></div>
        </div>
      </section>
    </div>

    <!-- PROVIDERS DINÂMICOS DEFINIDOS PELO USUÁRIO -->
    <div class="grid-1">
      <section class="card">
        <div class="card-header">
          <h2 id="api-connections">Minhas conexões de API</h2>
          <span class="pill"><i class="dot muted"></i> custom-* · qualquer endpoint OpenAI-compatible</span>
        </div>
        <p class="notice">Cadastre conexões até o limite de ${MAX_PROVIDERS} provedores, incluindo os presets. Cada um recebe um slot <code>custom-&lt;nome&gt;</code> com endpoint, modelo e chave próprios. HTTPS é obrigatório para endpoints remotos; loopback pode ficar sem chave.</p>

        ${userDefinedProviders.length > 0 ? `
        <div class="metric-grid" style="margin-bottom: 14px">
          ${userDefinedProviders.map((p) => `
            <div class="metric-box">
              <div class="metric-title">${escapeHtml(p.name)}</div>
              <div class="metric-value small-muted">${escapeHtml(p.endpoint || 'não configurado')}</div>
              <div style="margin-top:6px;font-size:12px;color:${p.enabled && p.configured ? 'var(--ok)' : 'var(--muted)'}">${p.enabled && p.configured ? '● ativo' : '○ inativo'}</div>
              <a href="/ui?setup=connection&amp;provider=${encodeURIComponent(p.name)}#user-defined-provider-form">Editar configuração</a>
            </div>
          `).join('')}
        </div>` : ''}

        <form id="user-defined-provider-form">
          <label for="udp-preset">Preset — escolha um provider popular ou preencha manualmente:</label>
          <select id="udp-preset" ${editingConnection?'disabled':' '} style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--fg);font-size:13px;margin-bottom:10px">
            <option value="">— Preencher manualmente —</option>
            <option value="openai|https://api.openai.com/v1/chat/completions|">OpenAI</option>
            <option value="openrouter|https://openrouter.ai/api/v1/chat/completions|">OpenRouter</option>
            <option value="ovhcloud|https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions|">OVHcloud AI Endpoints</option>
            <option value="xai|https://api.x.ai/v1/chat/completions|">xAI (Grok)</option>
            <option value="alibaba|https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions|">Alibaba Cloud (Qwen)</option>
            <option value="nvidia|https://integrate.api.nvidia.com/v1/chat/completions|">Nvidia NIM</option>
            <option value="moonshot|https://api.moonshot.ai/v1/chat/completions|">Moonshot / Kimi</option>
            <option value="fireworks|https://api.fireworks.ai/inference/v1/chat/completions|">Fireworks AI</option>
            <option value="perplexity|https://api.perplexity.ai/chat/completions|">Perplexity</option>
            <option value="sambanova|https://api.sambanova.ai/v1/chat/completions|">SambaNova</option>
            <option value="lmstudio|http://127.0.0.1:1234/v1/chat/completions|">LM Studio (local)</option>
            <option value="jan|http://127.0.0.1:1337/v1/chat/completions|">Jan (local)</option>
          </select>
          <label for="udp-name">Nome do provider (slug: letras, números e hífen)</label>
          <input id="udp-name" type="text" maxlength="50" value="${escapeHtml(editingConnection?.name.slice(7)??'')}" ${editingConnection?'readonly':''} placeholder="ex: openai, xai, alibaba, fireworks" autocomplete="off" spellcheck="false">
          <label for="udp-endpoint">Endpoint OpenAI-compatible (URL completa de Chat Completions)</label>
          <input id="udp-endpoint" type="text" maxlength="2048" value="${escapeHtml(editingConnection?.endpoint??'')}" placeholder="https://api.exemplo.com/v1/chat/completions" autocomplete="off" spellcheck="false">
          <p class="notice">Os presets preenchem somente o endereço. Informe um modelo disponível na sua conta ou servidor. Este formulário usa Chat Completions compatível com OpenAI; protocolos próprios exigem outro adaptador.</p>
          <label for="udp-model">Modelo padrão</label>
          <input id="udp-model" type="text" maxlength="200" value="${escapeHtml(editingConnection?.model??'')}" placeholder="Identificador disponível na sua conta ou servidor local" autocomplete="off" spellcheck="false">
          <label for="udp-key">Chave de API (opcional para loopback)</label>
          <input id="udp-key" type="password" maxlength="512" value="" autocomplete="new-password">
          <label class="consent-box" for="udp-ack">
            <input id="udp-ack" type="checkbox">
            <span>Entendo que este provider é de minha responsabilidade. A chave vai somente para o cofre nativo local.</span>
          </label>
          <div class="btn-row">
            <button type="submit" id="udp-save-btn">${editingConnection?'Salvar e ativar conexão':'Criar e Ativar Provider'}</button>
          </div>
          <div id="udp-msg" class="msg">${editingConnection?'Edite o endpoint ou modelo e informe a chave novamente para serviços remotos. Nada é alterado até salvar.':'Selecione um preset ou preencha manualmente.'}</div>
        </form>
      </section>
    </div>

    <!-- INTEGRAÇÃO 1-CLICK COM FERRAMENTAS DE DESENVOLVIMENTO (P2) -->
    <div class="grid-1">
      <section class="card">
        <div class="card-header"><h2>Conectar às suas Ferramentas de Dev</h2><span class="pill"><i class="dot muted"></i> OpenAI-Compatible</span></div>
        <p class="notice">Gere uma credencial individual de inferência para a ferramenta. Ela não é sua chave de API, aparece uma vez e pode ser revogada sem tocar nas BYOK. Os passos abaixo nunca pedem a chave do provider no IDE.</p>
        <form id="integration-client-form">
          <label for="integration-client-name">Nome desta integração</label>
          <input id="integration-client-name" type="text" maxlength="80" value="Ferramenta de desenvolvimento" autocomplete="off" spellcheck="false">
          <div class="btn-row"><button id="provision-client-btn" type="submit">Gerar token individual</button><button id="copy-client-token-btn" class="secondary" type="button" disabled>Copiar token</button></div>
          <label for="integration-client-token">Token (mostrado somente nesta página)</label>
          <input id="integration-client-token" type="password" readonly value="" autocomplete="off">
          <div id="integration-client-msg" class="msg">Nenhum token emitido nesta sessão.</div>
        </form>
        <div class="tabs-nav" role="tablist" aria-label="Ferramentas de desenvolvimento">
          <button type="button" class="tab-btn active" data-tab="cline">Cline (VS Code)</button>
          <button type="button" class="tab-btn" data-tab="aider">Aider</button>
          <button type="button" class="tab-btn" data-tab="continue">Continue.dev</button>
          <button type="button" class="tab-btn" data-tab="antigravity">Antigravity IDE</button>
          <button type="button" class="tab-btn" data-tab="openai-generic">OpenAI-compatible</button>
          <button type="button" class="tab-btn" data-tab="cursor">Cursor</button>
          <button type="button" class="tab-btn" data-tab="claude">Claude Code</button>
        </div>
        <div id="tab-cline" class="tab-pane active">
          <p class="notice">Configure pelo painel do Cline. Os passos abaixo não são um arquivo JSON nem um formato de importação.</p>
          <div class="code-container"><pre>${escapeHtml(clineSteps)}</pre><button type="button" class="copy-btn" data-requires-token disabled data-copy-template="${escapeHtml(clineSteps)}">Copiar passos</button></div>
        </div>
        <div id="tab-openai-generic" class="tab-pane">
          <p class="notice">Use estas configurações em ferramentas OpenAI-compatible que enviem as requisições diretamente deste computador. Compatibilidade de protocolo, sozinha, não garante acesso ao proxy local.</p>
          <div class="code-container"><pre>Base URL: http://127.0.0.1:21435/v1
API Key: (seu token individual gerado acima)
Modelo: uptokey-auto</pre><button type="button" class="copy-btn" data-requires-token disabled data-copy-template="Base URL: http://127.0.0.1:21435/v1\nAPI Key: __TOKEN__\nModelo: uptokey-auto">Copiar config</button></div>
        </div>
        <div id="tab-cursor" class="tab-pane">
          <p class="notice"><strong>Não há integração direta local-first.</strong> No fluxo BYOK documentado, requisições BYOK passam pelos servidores Cursor; um endpoint em 127.0.0.1 não é alcançável de lá.</p>
          <div class="code-container"><pre>Status: incompatível com loopback/local-first no Cursor. Não exponha o proxy na internet nem forneça suas chaves para contornar esta limitação.</pre><button type="button" class="copy-btn" data-copy="Status: incompatível com loopback/local-first no Cursor. Não exponha o proxy na internet nem forneça suas chaves para contornar esta limitação.">Copiar aviso</button></div>
        </div>
        <div id="tab-claude" class="tab-pane">
          <p class="notice"><strong>Não há integração direta validada.</strong> O endpoint de inferência atual do Uptokey é OpenAI-compatible; a integração exige validar o protocolo aceito pelo gateway do Claude Code. O MCP do conselho não substitui um adapter de inferência.</p>
          <div class="code-container"><pre>Status: exige adapter de protocolo e teste de integração antes de recomendar uma configuração.</pre><button type="button" class="copy-btn" data-copy="Status: exige adapter de protocolo e teste de integração antes de recomendar uma configuração.">Copiar aviso</button></div>
        </div>
        <div id="tab-aider" class="tab-pane">
          <p class="notice">Abra um PowerShell dedicado ao Aider e execute o bloco depois de gerar o token individual.</p>
          <div class="code-container"><pre>${escapeHtml(aiderTemplate)}</pre><button type="button" class="copy-btn" data-requires-token disabled data-copy-template="${escapeHtml(aiderTemplate)}">Copiar PowerShell</button></div>
        </div>
        <div id="tab-continue" class="tab-pane">
          <p class="notice">Adicione este modelo OpenAI-compatible em um perfil limpo do Continue.</p>
          <div class="code-container"><pre>${escapeHtml(continueTemplate)}</pre><button type="button" class="copy-btn" data-requires-token disabled data-copy-template="${escapeHtml(continueTemplate)}">Copiar YAML</button></div>
        </div>
        <div id="tab-antigravity" class="tab-pane">
          <p class="notice"><strong>Integração distinta.</strong> O Antigravity usa o MCP do conselho local, não esta credencial de inferência.</p>
          <div class="code-container"><pre>node scripts/configure-antigravity-mcp.mjs install
node scripts/configure-antigravity-mcp.mjs check
node scripts/configure-antigravity-mcp.mjs probe</pre><button type="button" class="copy-btn" data-copy="node scripts/configure-antigravity-mcp.mjs install&#10;node scripts/configure-antigravity-mcp.mjs check&#10;node scripts/configure-antigravity-mcp.mjs probe">Copiar comandos</button></div>
        </div>
      </section>
    </div>

    <!-- E2-03: CHAVES DE CLIENTES ESCOPADAS -->
    <div class="grid-1">
      <section class="card">
        <div class="card-header"><h2>Chaves de clientes</h2><span class="pill"><i class="dot muted"></i> Escopo local</span></div>
        <p class="notice">Emita credenciais de inferência escopadas por projeto/modelo/provedor, com expiração, limites e rotação. O valor aparece <strong>uma única vez</strong>; listas mostram só metadados. Escopos: inference:chat, inference:responses, inference:messages, models:read, usage:read. Nunca há escopo admin para chave de inferência.</p>
        <form id="client-key-form">
          <label for="client-key-label">Rótulo (1–80)</label>
          <input id="client-key-label" type="text" maxlength="80" value="IDE deste computador" autocomplete="off" spellcheck="false">
          <label>Escopos</label>
          <div id="client-key-scopes">
            <label class="consent-box" style="margin-top:6px"><input type="checkbox" value="inference:chat" checked><span>inference:chat — POST /v1/chat/completions, /v1/completions</span></label>
            <label class="consent-box" style="margin-top:6px"><input type="checkbox" value="inference:responses" checked><span>inference:responses — POST /v1/responses</span></label>
            <label class="consent-box" style="margin-top:6px"><input type="checkbox" value="inference:messages" checked><span>inference:messages — POST /v1/messages, /v1/messages/count_tokens</span></label>
            <label class="consent-box" style="margin-top:6px"><input type="checkbox" value="models:read" checked><span>models:read — GET /v1/models</span></label>
            <label class="consent-box" style="margin-top:6px"><input type="checkbox" value="usage:read" checked><span>usage:read — GET /v1/usage</span></label>
          </div>
          <label for="client-key-models">Modelos permitidos (vírgula; vazio = todos)</label>
          <input id="client-key-models" type="text" maxlength="1200" value="" placeholder="uptokey-auto" autocomplete="off" spellcheck="false">
          <label for="client-key-expires">Expira em (opcional)</label>
          <input id="client-key-expires" type="text" maxlength="32" value="" placeholder="2027-01-01T00:00:00.000Z" autocomplete="off" spellcheck="false">
          <label for="client-key-rpm">Limite req/min (opcional, 1–10000)</label>
          <input id="client-key-rpm" type="text" maxlength="6" value="" placeholder="60" autocomplete="off" spellcheck="false">
          <div class="btn-row"><button id="client-key-create-btn" type="submit">Criar chave escopada</button><button id="copy-scoped-token-btn" class="secondary" type="button" disabled>Copiar valor único</button></div>
          <label for="client-key-token">Valor (mostrado uma única vez)</label>
          <input id="client-key-token" type="password" readonly value="" autocomplete="off">
          <div id="client-key-msg" class="msg">Nenhuma chave escopada emitida nesta sessão.</div>
        </form>
        <div class="card-header" style="margin-top:18px"><h2>Chaves emitidas</h2><button type="button" id="refresh-client-keys-btn" class="secondary compact-button">Atualizar lista</button></div>
        <div id="client-keys-feed" class="msg status-feed">Carregue a lista. Valores nunca reaparecem após reload.</div>
      </section>
    </div>

    <!-- E2-03: GESTÃO OPENROUTER (integração comercial remota) -->
    <div class="grid-1">
      <section class="card">
        <div class="card-header"><h2>Gestão OpenRouter</h2><span class="pill"><i class="dot muted"></i> Conta remota</span></div>
        <p class="notice">Administra chaves da <strong>sua conta OpenRouter</strong> pela API oficial (<code>openrouter.ai/api/v1/keys</code>). Exige cadastrar a chave de gestão oficial no cofre local; ela <strong>nunca</strong> é usada para inferência e nunca sai do cofre. Exclusão é ação explícita. Sem chave cadastrada, as ações retornam <code>management_key_required</code>.</p>
        <form id="or-mgmt-config-form">
          <label for="or-mgmt-key">Chave de gestão oficial (fica no cofre)</label>
          <input id="or-mgmt-key" type="password" maxlength="4096" value="" autocomplete="new-password">
          <div class="btn-row"><button type="submit">Salvar chave de gestão</button><button id="or-mgmt-clear-btn" class="secondary" type="button">Remover do cofre</button></div>
          <div id="or-mgmt-config-msg" class="msg">Nenhuma alteração nesta sessão.</div>
        </form>
        <form id="or-mgmt-create-form" style="margin-top:14px">
          <label for="or-mgmt-name">Nome da chave remota</label>
          <input id="or-mgmt-name" type="text" maxlength="80" value="uptokey-ide" autocomplete="off" spellcheck="false">
          <label for="or-mgmt-limit">Limite de crédito (opcional)</label>
          <input id="or-mgmt-limit" type="text" maxlength="20" value="" placeholder="10" autocomplete="off" spellcheck="false">
          <div class="btn-row"><button type="submit">Criar chave remota</button><button id="copy-or-key-btn" class="secondary" type="button" disabled>Copiar valor único</button></div>
          <label for="or-mgmt-value">Valor remoto (mostrado uma única vez)</label>
          <input id="or-mgmt-value" type="password" readonly value="" autocomplete="off">
          <div id="or-mgmt-msg" class="msg">Nenhuma chave remota criada nesta sessão.</div>
        </form>
        <div class="card-header" style="margin-top:18px"><h2>Chaves remotas</h2><button type="button" id="refresh-or-keys-btn" class="secondary compact-button">Atualizar lista</button></div>
        <div id="or-keys-feed" class="msg status-feed">Carregue a lista. Hash é identificador opaco, nunca a chave.</div>
      </section>
    </div>

    <!-- SAÚDE DO FAILOVER & STATUS EM TEMPO REAL -->
    <div class="grid-1">
      <section class="card">
        <div class="card-header"><h2>Saúde do Failover & Status do Proxy</h2><button type="button" id="refresh-status-btn" class="secondary compact-button">Atualizar Status</button></div>
        <div class="metric-grid">
          <div class="metric-box"><div class="metric-title">Versão</div><div id="stat-version" class="metric-value">—</div></div>
          <div class="metric-box"><div class="metric-title">Próximo elegível</div><div id="stat-next" class="metric-value">—</div></div>
          <div class="metric-box"><div class="metric-title">Ordem configurada</div><div id="stat-route" class="metric-value small-muted">—</div></div>
          <div class="metric-box"><div class="metric-title">Último Overhead</div><div id="stat-overhead" class="metric-value">—</div></div>
          <div class="metric-box"><div class="metric-title">Budget / excessos</div><div id="stat-budget" class="metric-value">—</div></div>
          <div class="metric-box"><div class="metric-title">Cache exato</div><div id="stat-cache" class="metric-value">—</div></div>
          <div class="metric-box"><div class="metric-title">Preservação de contexto</div><div id="stat-context" class="metric-value">—</div></div>
        </div>
        <div id="status-feed" class="msg status-feed">Consultando disponibilidade local.</div>
        <div class="btn-row"><button type="button" id="copy-status-snapshot-btn" class="secondary">Copiar snapshot de status</button></div>
        <div id="status-snapshot-msg" class="msg">Snapshot local contém somente versão, rota, failover, cache e contexto sanitizados.</div>
      </section>
    </div>

    <div class="grid-1">
      <section class="card">
        <div class="card-header"><h2>Feedback beta sanitizado</h2><span class="pill"><i class="dot muted"></i> Sem segredo</span></div>
        <p class="notice">Copie um rascunho de feedback local para preencher após o teste. Ele usa somente o status sanitizado da UI e não inclui chave de provider, token individual, conteúdo de inferência, e-mail ou caminho local.</p>
        <div class="btn-row"><button type="button" id="copy-beta-feedback-btn" class="secondary">Copiar rascunho de feedback</button></div>
        <div id="beta-feedback-msg" class="msg">Rode o caminho feliz, revogue o token da ferramenta e preencha o relato antes de compartilhar.</div>
      </section>
    </div>

    <div class="grid-1">
      <section class="card">
        <div class="card-header"><h2>Primeira execução & troubleshooting</h2><span class="pill"><i class="dot muted"></i> Local-first</span></div>
        <p class="notice">Se algo falhar no primeiro uso, resolva nesta ordem. A UI traduz os erros locais para ações, sem pedir chave de provider fora do cofre nativo.</p>
        <ul class="help-list">
          <li><strong>Proxy offline:</strong> inicie o executável Uptokey ou rode <code>uptokey proxy start --no-tailnet</code>, depois use Atualizar Status.</li>
          <li><strong>Provider ausente:</strong> configure uma API ou modelo local acima e confira sua ativação na rota.</li>
          <li><strong>Credencial inválida:</strong> gere uma chave nova no painel do provider e salve novamente; a UI não valida quota remota sem consumir uma chamada real.</li>
          <li><strong>Quota ou limite:</strong> aguarde a janela do provider, troque a ordem de fallback ou use outro provider já configurado.</li>
          <li><strong>Ferramenta dev não conecta:</strong> gere um token individual nesta página e confirme que a ferramenta usa <code>http://127.0.0.1:21435/v1</code> com modelo <code>uptokey-auto</code>.</li>
        </ul>
      </section>
    </div>

    <p class="footer-note">Uptokey Local v0.1.0 • <code>SPEC-000</code> Conforme • Chaves não são custodiadas pela Cloud Uptokey.</p>
  </main>

  <script nonce="${safeNonce}">
    // Same identity owner/schema as the PWA. The bearer exists only in this page.
    const browserIdentity = (${workspaceBrowserIdentity.toString()});
    let localSession;
    let localConnecting;
    async function sessionRequest(path, body) {
      const response = await fetch(path, {method:'POST', credentials:'omit', redirect:'error',
        headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(15000)});
      const result = await response.json();
      if (!response.ok) throw new Error('workspace_connect_failed');
      return result;
    }
    function connectLocalSession() {
      if (localSession) return Promise.resolve(localSession);
      if (localConnecting) return localConnecting;
      localConnecting = (async () => {
        const identity = await browserIdentity();
        const challenge = await sessionRequest('/local/workspace/session/challenge', {publicJwk:identity.publicJwk});
        if (typeof challenge.challengeId !== 'string' || typeof challenge.nonce !== 'string' ||
            challenge.nonce.length > 512 || !challenge.nonce.startsWith('uptokey-workspace-browser-v1:' + challenge.challengeId + ':')) {
          throw new Error('workspace_challenge_invalid');
        }
        const signed = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, identity.privateKey, new TextEncoder().encode(challenge.nonce));
        const signature = btoa(String.fromCharCode(...new Uint8Array(signed))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
        const result = await sessionRequest('/local/workspace/session/complete', {challengeId:challenge.challengeId,signature});
        if (typeof result.token !== 'string' || typeof result.clientId !== 'string') throw new Error('workspace_session_invalid');
        localSession = result;
        return result;
      })().finally(() => { localConnecting = undefined; });
      return localConnecting;
    }
    async function authorizedFetch(path, init = {}) {
      const target = new URL(path, location.href);
      if (target.origin !== location.origin || !['/local/','/v1/'].some(prefix => target.pathname.startsWith(prefix))) {
        throw new Error('workspace_destination_invalid');
      }
      const session = await connectLocalSession();
      const headers = new Headers(init.headers);
      headers.set('authorization', 'Bearer ' + session.token);
      const response = await fetch(target.pathname + target.search, {...init, headers, credentials:'omit', redirect:'error', signal:init.signal || AbortSignal.timeout(15000)});
      // Never retry a mutation or replace the signing identity after a denial.
      if (response.status === 401) localSession = undefined;
      return response;
    }
    function explainLocalError(type) {
      const code = typeof type === 'string' && type ? type : 'desconhecido';
      const messages = {
        unauthorized: 'Esta sessão não permite gerenciar conexões. Use uma sessão autorizada nas configurações do Uptokey.',
        workspace_connect_failed: 'Não foi possível autenticar este navegador. Confira se o proxy está ativo e tente a ação novamente.',
        workspace_identity_invalid: 'A identidade deste navegador é inválida. Abra as configurações do Uptokey para recuperar o acesso.',
        gemini_privacy_consent_required: 'Marque o aceite do Gemini Free antes de salvar. Sem esse aceite local, o provider fica inelegível.',
        provider_key_invalid: 'A chave ou endpoint não passou no contrato local. Confira se o provider exige chave e salve novamente.',
        provider_risk_consent_required: 'Marque o aceite do aviso deste canal experimental/user-managed antes de ativar.',
        invalid_request: 'Revise os campos. O formulário aceita apenas o schema fechado da superfície local.',
        local_pairing_rate_limited: 'Muitas tentativas locais em pouco tempo. Aguarde a janela indicada e tente de novo sem gerar vários tokens.',
        pairing_capacity_exceeded: 'Já existe um pareamento em andamento. Aguarde o fluxo atual expirar ou consuma o token aprovado.',
        client_provision_failed: 'Não foi possível criar o token da ferramenta. Atualize o status e tente novamente.',
        revoke_failed: 'Não foi possível revogar agora. Confira se digitou REVOGAR e tente Atualizar Status antes de repetir.',
        save_failed: 'Não foi possível gravar no cofre nativo. Confira permissões do sistema e tente novamente.',
        proxy_offline: 'O proxy local não respondeu. Inicie o Uptokey e confirme 127.0.0.1:21435 antes de repetir.',
        config_epoch_pending: 'A configuração autenticada deste device ainda não convergiu. Aguarde o próximo contato do proxy com o control plane.',
        gemini_privacy_pending: 'Gemini está configurado, mas aguarda aceite local de privacidade para entrar na rota.'
      };
      return messages[code] || ('Erro técnico local (' + code + '). Veja o README de troubleshooting e tente Atualizar Status.');
    }

    // Aceite do Gemini
    function acceptGeminiPrivacyValue(provider) {
      if (provider !== 'gemini') return false;
      const control = document.querySelector('[data-aceito="gemini"]');
      return Boolean(control && control.checked);
    }

    // Salvar Chave do Provedor
    async function saveProvider(event, provider) {
      event.preventDefault();
      const input = document.querySelector('[data-key="' + provider + '"]');
      const key = input ? input.value : '';
      const button = document.querySelector('[data-save="' + provider + '"]');
      const msg = document.querySelector('[data-msg="' + provider + '"]');

      if (!key) {
        msg.className = 'msg err';
        msg.textContent = 'Por favor, insira a chave da API.';
        return;
      }

      button.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'Gravando com segurança no cofre nativo...';

      try {
        const res = await authorizedFetch('/local/provider/save', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, key, acceptGeminiPrivacy: acceptGeminiPrivacyValue(provider) })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errType = body && body.error && body.error.type ? body.error.type : 'save_failed';
          if (errType === 'gemini_privacy_consent_required') {
            throw new Error('gemini_privacy_consent_required');
          }
          throw new Error(errType);
        }
        msg.className = 'msg ok';
        msg.textContent = provider + ' salvo com sucesso no cofre nativo!';
        const pill = document.querySelector('[data-state="' + provider + '"]');
        if (pill) {
          pill.className = 'pill on';
          pill.innerHTML = '<i class="dot"></i>ativo';
        }
        input.value = '';
        updateLiveStatus();
      } catch (error) {
        msg.className = 'msg err';
        msg.textContent = 'Erro ao salvar: ' + explainLocalError(error && error.message ? error.message : 'save_failed');
      } finally {
        button.disabled = false;
      }
    }

    // Revogar Chave do Provedor
    async function revokeProvider(provider) {
      const button = document.querySelector('[data-revoke="' + provider + '"]');
      const msg = document.querySelector('[data-msg="' + provider + '"]');
      const confirmInput = document.querySelector('[data-revoke-confirm="' + provider + '"]');
      const confirmation = confirmInput && typeof confirmInput.value === 'string' ? confirmInput.value.trim() : '';

      if (confirmation !== 'REVOGAR') {
        msg.className = 'msg err';
        msg.textContent = 'Digite exatamente REVOGAR para confirmar a exclusão.';
        return;
      }

      button.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'Removendo do cofre local...';

      try {
        const res = await authorizedFetch('/local/provider/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, confirmation: 'REVOGAR' })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body && body.error && body.error.type ? body.error.type : 'revoke_failed');

        msg.className = 'msg ok';
        msg.textContent = provider + ' revogado com sucesso. A chave foi excluída do cofre.';
        const pill = document.querySelector('[data-state="' + provider + '"]');
        if (pill) {
          pill.className = 'pill';
          pill.innerHTML = '<i class="dot"></i>não configurado';
        }
        confirmInput.value = '';
        updateLiveStatus();
      } catch (error) {
        msg.className = 'msg err';
        msg.textContent = 'Erro ao revogar: ' + explainLocalError(error && error.message ? error.message : 'revoke_failed');
      } finally {
        button.disabled = false;
      }
    }

    function loadOptionalProviderProfile() {
      const select = document.getElementById('optional-provider-name');
      const endpointInput = document.getElementById('optional-provider-endpoint');
      const modelInput = document.getElementById('optional-provider-model');
      const option = select && select.selectedOptions ? select.selectedOptions[0] : null;
      const risk = document.getElementById('optional-provider-risk');
      const riskSource = document.getElementById('optional-provider-risk-source');
      const riskReviewed = document.getElementById('optional-provider-risk-reviewed');
      const acknowledgement = document.getElementById('optional-provider-ack');
      if (endpointInput && option) endpointInput.value = option.getAttribute('data-endpoint') || '';
      if (modelInput && option) modelInput.value = option.getAttribute('data-model') || '';
      if (risk && option) risk.textContent = option.getAttribute('data-notice') || '';
      if (riskSource && option) {
        const source = option.getAttribute('data-notice-source') || '';
        if (source.startsWith('https://')) riskSource.setAttribute('href', source);
        else riskSource.removeAttribute('href');
      }
      if (riskReviewed && option) riskReviewed.textContent = option.getAttribute('data-notice-reviewed') || '';
      if (acknowledgement) acknowledgement.checked = false;
      const keyInput = document.getElementById('optional-provider-key');
      if (keyInput) keyInput.value = '';
    }

    async function configureOptionalProviderFromUi(event) {
      event.preventDefault();
      const select = document.getElementById('optional-provider-name');
      const endpointInput = document.getElementById('optional-provider-endpoint');
      const modelInput = document.getElementById('optional-provider-model');
      const keyInput = document.getElementById('optional-provider-key');
      const acknowledgement = document.getElementById('optional-provider-ack');
      const button = document.getElementById('optional-provider-save-btn');
      const msg = document.getElementById('optional-provider-msg');
      const provider = select && typeof select.value === 'string' ? select.value : '';
      const endpointUrl = endpointInput && typeof endpointInput.value === 'string' ? endpointInput.value.trim() : '';
      const model = modelInput && typeof modelInput.value === 'string' ? modelInput.value.trim() : '';
      const key = keyInput && typeof keyInput.value === 'string' ? keyInput.value : '';
      if (!acknowledgement || !acknowledgement.checked) { msg.className = 'msg err'; msg.textContent = 'Confirme que entende o nível de suporte e os riscos antes de ativar.'; return; }
      if (!endpointUrl || !model) { msg.className = 'msg err'; msg.textContent = 'Informe endpoint completo e modelo.'; return; }
      button.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'Validando endpoint, limpando cache e atualizando o cofre...';
      try {
        const res = await authorizedFetch('/local/provider/configure-optional', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, endpointUrl, model, key, acceptProviderRisk: Boolean(acknowledgement.checked) })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body && body.error && body.error.type ? body.error.type : 'provider_save_failed');
        keyInput.value = '';
        acknowledgement.checked = false;
        const option = select.selectedOptions ? select.selectedOptions[0] : null;
        if (option) { option.setAttribute('data-endpoint', endpointUrl); option.setAttribute('data-model', model); }
        msg.className = 'msg ok';
        msg.textContent = provider + ' ativado. A rota só muda quando você o incluir explicitamente.';
        updateLiveStatus();
      } catch (error) {
        keyInput.value = '';
        msg.className = 'msg err';
        msg.textContent = 'Configuração recusada: ' + explainLocalError(error && error.message ? error.message : 'provider_save_failed');
      } finally { button.disabled = false; }
    }

    async function provisionIntegrationClient(event) {
      event.preventDefault();
      const nameInput = document.getElementById('integration-client-name');
      const tokenInput = document.getElementById('integration-client-token');
      const provisionButton = document.getElementById('provision-client-btn');
      const copyButton = document.getElementById('copy-client-token-btn');
      const msg = document.getElementById('integration-client-msg');
      const clientName = nameInput && typeof nameInput.value === 'string' ? nameInput.value.trim() : '';
      if (!clientName) { if (msg) { msg.className = 'msg err'; msg.textContent = 'Informe um nome para identificar a integração.'; } return; }
      provisionButton.disabled = true;
      copyButton.disabled = true;
      if (msg) { msg.className = 'msg'; msg.textContent = 'Criando uma credencial local limitada a inferência...'; }
      try {
        const res = await authorizedFetch('/local/client-keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: clientName, scopes: ${JSON.stringify(CLIENT_KEY_SCOPES)}, operationId: crypto.randomUUID() })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || typeof body.token !== 'string' || typeof body.id !== 'string') throw new Error(body && body.error && body.error.type ? body.error.type : 'client_provision_failed');
        tokenInput.value = body.token;
        copyButton.disabled = false;
        document.querySelectorAll('[data-requires-token]').forEach((item) => { item.disabled = false; });
        if (msg) { msg.className = 'msg ok'; msg.textContent = 'Token emitido. Revogação: uptokey client revoke ' + body.id; }
      } catch (error) {
        tokenInput.value = '';
        document.querySelectorAll('[data-requires-token]').forEach((item) => { item.disabled = true; });
        if (msg) { msg.className = 'msg err'; msg.textContent = 'Erro ao criar cliente: ' + explainLocalError(error && error.message ? error.message : 'client_provision_failed'); }
      } finally { provisionButton.disabled = false; }
    }

    async function copyIntegrationToken() {
      const tokenInput = document.getElementById('integration-client-token');
      const copyButton = document.getElementById('copy-client-token-btn');
      if (!tokenInput || !tokenInput.value) return;
      try { await navigator.clipboard.writeText(tokenInput.value); copyButton.textContent = 'Token copiado'; }
      catch { copyButton.textContent = 'Erro ao copiar'; }
      setTimeout(() => { copyButton.textContent = 'Copiar token'; }, 2000);
    }

    // Gerenciamento de Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-tab');
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const pane = document.getElementById('tab-' + target);
        if (pane) pane.classList.add('active');
      });
    });

    // Copiar Snippets
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        let text = btn.getAttribute('data-copy');
        const template = btn.getAttribute('data-copy-template');
        if (template) {
          const tokenInput = document.getElementById('integration-client-token');
          const token = tokenInput && typeof tokenInput.value === 'string' ? tokenInput.value : '';
          if (!token) {
            const msg = document.getElementById('integration-client-msg');
            if (msg) { msg.className = 'msg err'; msg.textContent = 'Gere o token individual antes de copiar a configuração.'; }
            return;
          }
          text = template.replaceAll('TOKEN_GERADO_ACIMA', token);
        }
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          const original = btn.textContent;
          btn.textContent = 'Copiado! ✓';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove('copied');
          }, 2000);
        } catch (_) {
          btn.textContent = 'Erro ao copiar';
        }
      });
    });

    let lastLocalStatus = null;

    function betaFeedbackProviderFromStatus(data) {
      const provider = data && typeof data.nextProvider === 'string' ? data.nextProvider : '';
      if (provider === 'groq' || provider === 'gemini' || provider === 'ollama' || provider === 'vllm' || provider === 'custom') return provider;
      return provider ? 'level3-user-managed' : 'none';
    }

    function betaFeedbackOs() {
      const platform = String((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
      if (platform.includes('win')) return 'windows';
      if (platform.includes('mac')) return 'macos';
      if (platform.includes('linux')) return 'linux';
      return 'other';
    }

    function betaFeedbackVersion(data) {
      const version = data && typeof data.version === 'string' ? data.version : '';
      if (/^v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return version;
      return 'unknown';
    }

    const localStatusAllowedProviders = new Set(['groq', 'gemini', 'ollama', 'vllm', 'custom', 'deepseek', 'mistral', 'cerebras', 'together', 'anthropic', 'openrouter']);

    function localStatusProviderName(value) {
      const provider = typeof value === 'string' ? value.toLowerCase() : '';
      return localStatusAllowedProviders.has(provider) ? provider : null;
    }

    function safeNonNegativeInteger(value) {
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }

    function safeNullableNonNegativeInteger(value) {
      return value === null ? null : safeNonNegativeInteger(value);
    }

    function safePercent(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
    }

    function localStatusSnapshot(data) {
      const provider = betaFeedbackProviderFromStatus(data);
      return {
        schema: 'uptokey-local-status-snapshot-v1',
        captured_at_utc: new Date().toISOString(),
        uptokey_version: betaFeedbackVersion(data),
        status: data && data.status === 'ok' ? 'ok' : 'unknown',
        next_provider: provider,
        routing: Array.isArray(data && data.routing) ? data.routing.map(localStatusProviderName).filter(Boolean).slice(0, 8) : [],
        failover: data && data.failover ? {
          budget_ms: safeNonNegativeInteger(data.failover.budgetMs),
          last_overhead_ms: safeNullableNonNegativeInteger(data.failover.lastOverheadMs),
          max_overhead_ms: safeNonNegativeInteger(data.failover.maxOverheadMs),
          budget_exceeded_count: safeNonNegativeInteger(data.failover.budgetExceededCount)
        } : null,
        cache: data && data.cache ? {
          exact_hits: safeNonNegativeInteger(data.cache.exactHits),
          exact_misses: safeNonNegativeInteger(data.cache.exactMisses),
          exact_writes: safeNonNegativeInteger(data.cache.exactWrites),
          estimated_network_calls_avoided: safeNonNegativeInteger(data.cache.estimatedNetworkCallsAvoided)
        } : null,
        context: data && data.context ? {
          cpi_percent: safePercent(data.context.cpiPercent),
          active_sessions: safeNonNegativeInteger(data.context.activeSessions),
          total_switches: safeNonNegativeInteger(data.context.totalSwitches)
        } : null
      };
    }

    function betaFeedbackDraft(data) {
      return {
        schema: 'uptokey-beta-feedback-v1',
        captured_at_utc: new Date().toISOString(),
        reporter_alias: 'tester-01',
        uptokey_version: betaFeedbackVersion(data),
        platform: { os: betaFeedbackOs(), arch: 'unknown', install_channel: 'local-ui' },
        tool: { name: 'other', version: 'unknown', integration_mode: 'mini-ui' },
        run: {
          health_ok: Boolean(data && data.status === 'ok'),
          ui_ok: true,
          provider_configured: betaFeedbackProviderFromStatus(data),
          local_call_result: 'not-attempted',
          integration_token_revoked: false,
          cache_metrics_visible: Boolean(data && data.cache),
          context_metrics_visible: Boolean(data && data.context)
        },
        issue: {
          severity: 'note',
          category: 'onboarding',
          step: 'fill-after-run',
          expected: 'Describe the expected local action after the run',
          observed: 'Describe only sanitized behavior, never secrets',
          notes: 'Remove private identity, local paths and raw inference bodies.'
        },
        redactions: ['provider_key_removed', 'client_token_removed', 'private_identity_removed', 'local_path_removed']
      };
    }

    async function copyBetaFeedbackDraft() {
      const msg = document.getElementById('beta-feedback-msg');
      try {
        const draft = betaFeedbackDraft(lastLocalStatus || { status: 'unknown' });
        await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
        if (msg) { msg.className = 'msg ok'; msg.textContent = 'Rascunho copiado. Preencha e valide com scripts\\\\validate-beta-feedback.mjs antes de compartilhar.'; }
      } catch (_) {
        if (msg) { msg.className = 'msg err'; msg.textContent = 'Não foi possível copiar. Use BETA-FEEDBACK-TEMPLATE.md como fallback.'; }
      }
    }

    async function copyStatusSnapshot() {
      const msg = document.getElementById('status-snapshot-msg');
      try {
        const snapshot = localStatusSnapshot(lastLocalStatus || { status: 'unknown' });
        await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
        if (msg) { msg.className = 'msg ok'; msg.textContent = 'Snapshot copiado sem chave, token, identidade privada, caminho local ou conteúdo de inferência.'; }
      } catch (_) {
        if (msg) { msg.className = 'msg err'; msg.textContent = 'Não foi possível copiar o snapshot. Use Atualizar Status e tente novamente.'; }
      }
    }

    // Atualização de Status
    async function updateLiveStatus() {
      const feed = document.getElementById('status-feed');
      try {
        const res = await fetch('/local/ui/status');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data && data.error && data.error.type ? data.error.type : 'proxy_offline');
        lastLocalStatus = data;
        const statVersion = document.getElementById('stat-version');
        const statNext = document.getElementById('stat-next');
        const statRoute = document.getElementById('stat-route');
        const statOverhead = document.getElementById('stat-overhead');
        const statBudget = document.getElementById('stat-budget');
        const statCache = document.getElementById('stat-cache');
        const statContext = document.getElementById('stat-context');
        if (statVersion) statVersion.textContent = betaFeedbackVersion(data);
        if (statNext) statNext.textContent = data.nextProvider || 'nenhum';
        if (statRoute) statRoute.textContent = Array.isArray(data.routing) && data.routing.length ? data.routing.join(' -> ') : 'bloqueada';
        if (statOverhead) statOverhead.textContent = data.failover && data.failover.lastOverheadMs !== null ? data.failover.lastOverheadMs + ' ms' : 'sem amostra';
        if (statBudget) statBudget.textContent = data.failover ? data.failover.budgetMs + ' ms / ' + data.failover.budgetExceededCount : 'indisponível';
        if (statCache) statCache.textContent = data.cache ? data.cache.exactHits + ' hits / ' + data.cache.exactMisses + ' misses / ' + data.cache.exactWrites + ' writes / ' + data.cache.estimatedNetworkCallsAvoided + ' evitadas' : 'sem amostra';
        if (statContext) statContext.textContent = data.context && (data.context.activeSessions > 0 || data.context.totalSwitches > 0) ? data.context.cpiPercent + '% / ' + data.context.activeSessions + ' sessões / ' + data.context.totalSwitches + ' trocas' : 'sem amostra';
        if (feed) { feed.className = 'msg status-feed'; feed.textContent = data.configEpochPending ? explainLocalError('config_epoch_pending') : data.geminiPrivacyNoticePending ? explainLocalError('gemini_privacy_pending') : 'Status local atualizado sem ler ou expor chaves.'; }
      } catch (error) {
        if (feed) { feed.className = 'msg err status-feed'; feed.textContent = explainLocalError(error && error.message ? error.message : 'proxy_offline'); }
      }
    }

    async function refreshLocalModelsInventory() {
      const feed = document.getElementById('local-models-feed');
      if (!feed) return;
      feed.className = 'msg status-feed';
      feed.textContent = 'Consultando runtimes locais...';
      try {
        const res = await authorizedFetch('/v1/local-models');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data && data.error && data.error.type ? data.error.type : 'local_models_unavailable');
        const lines = [];
        const ollama = data.runtimes && data.runtimes.ollama ? data.runtimes.ollama : { status: data.status, models: data.models || [] };
        const vllm = data.runtimes && data.runtimes.vllm ? data.runtimes.vllm : { status: 'unreachable', models: [] };
        lines.push('Ollama: ' + (ollama.status || 'unknown'));
        for (const m of (ollama.models || []).slice(0, 32)) {
          const size = typeof m.sizeBytes === 'number' ? (' · ' + Math.round(m.sizeBytes / 1048576) + ' MiB (estimativa)') : ' · tamanho (estimativa indisponível)';
          lines.push('  • ' + (m.name || m.id || '?') + size);
        }
        lines.push('vLLM: ' + (vllm.status || 'unknown') + (vllm.installSupported === false ? ' · install não suportado' : ''));
        for (const m of (vllm.models || []).slice(0, 32)) {
          lines.push('  • ' + (m.id || m.name || '?') + ' · estimativa indisponível');
        }
        feed.textContent = lines.join('\\n');
      } catch (error) {
        feed.className = 'msg err status-feed';
        feed.textContent = 'Lista indisponível: ' + explainLocalError(error && error.message ? error.message : 'local_models_unavailable');
      }
    }

    // E2-03: chaves de clientes escopadas (valor único, sem storage/URL)
    async function createScopedClientKey(event) {
      event.preventDefault();
      const labelInput = document.getElementById('client-key-label');
      const tokenInput = document.getElementById('client-key-token');
      const copyButton = document.getElementById('copy-scoped-token-btn');
      const button = document.getElementById('client-key-create-btn');
      const msg = document.getElementById('client-key-msg');
      const scopes = Array.from(document.querySelectorAll('#client-key-scopes input:checked')).map((el) => el.value);
      const modelsRaw = document.getElementById('client-key-models');
      const expiresRaw = document.getElementById('client-key-expires');
      const rpmRaw = document.getElementById('client-key-rpm');
      if (!scopes.length) { if (msg) { msg.className = 'msg err'; msg.textContent = 'Selecione ao menos um escopo.'; } return; }
      const modelIds = typeof modelsRaw.value === 'string' && modelsRaw.value.trim() ? modelsRaw.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 64) : [];
      const body = { label: labelInput.value.trim(), scopes, modelIds, operationId: crypto.randomUUID() };
      if (typeof expiresRaw.value === 'string' && expiresRaw.value.trim()) body.expiresAt = expiresRaw.value.trim();
      if (typeof rpmRaw.value === 'string' && rpmRaw.value.trim()) {
        const rpm = Number(rpmRaw.value.trim());
        if (!Number.isSafeInteger(rpm) || rpm < 1 || rpm > 10000) { if (msg) { msg.className = 'msg err'; msg.textContent = 'Limite req/min inválido (1–10000).'; } return; }
        body.limits = { requestsPerMinute: rpm };
      }
      button.disabled = true;
      copyButton.disabled = true;
      if (msg) { msg.className = 'msg'; msg.textContent = 'Emitindo chave escopada...'; }
      try {
        const res = await authorizedFetch('/local/client-keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || typeof data.token !== 'string') throw new Error(data && data.error && data.error.type ? data.error.type : 'client_provision_failed');
        tokenInput.value = data.token;
        copyButton.disabled = false;
        if (msg) { msg.className = 'msg ok'; msg.textContent = 'Chave ' + data.prefixMasked + ' revisão ' + data.revision + ' emitida. Guarde agora: o valor não reaparece.'; }
        refreshClientKeys();
      } catch (error) {
        tokenInput.value = '';
        if (msg) { msg.className = 'msg err'; msg.textContent = 'Erro ao emitir: ' + explainLocalError(error && error.message ? error.message : 'client_provision_failed'); }
      } finally { button.disabled = false; }
    }

    async function refreshClientKeys() {
      const feed = document.getElementById('client-keys-feed');
      if (!feed) return;
      feed.className = 'msg status-feed';
      feed.textContent = 'Consultando chaves (metadados, sem valores)...';
      try {
        const res = await authorizedFetch('/local/client-keys?limit=100');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data && data.error && data.error.type ? data.error.type : 'list_failed');
        const keys = Array.isArray(data.keys) ? data.keys : [];
        if (!keys.length) { feed.textContent = 'Nenhuma chave emitida.'; return; }
        feed.textContent = keys.slice(0, 100).map((k) => {
          const scopes = Array.isArray(k.scopes) ? k.scopes.join(',') : '';
          const state = k.revokedAt ? 'revogada' : k.enabled === false ? 'desativada' : 'ativa';
          return '• ' + (k.label || '?') + ' ' + (k.prefixMasked || '') + ' rev' + k.revision + ' [' + state + '] escopos=' + scopes
            + ' expira=' + (k.expiresAt || '—') + ' últimoUso=' + (k.lastUsedAt || 'nunca');
        }).join('\\n');
      } catch (error) {
        feed.className = 'msg err status-feed';
        feed.textContent = 'Lista indisponível: ' + explainLocalError(error && error.message ? error.message : 'list_failed');
      }
    }

    async function copyScopedToken() {
      const tokenInput = document.getElementById('client-key-token');
      const copyButton = document.getElementById('copy-scoped-token-btn');
      if (!tokenInput || !tokenInput.value) return;
      try { await navigator.clipboard.writeText(tokenInput.value); copyButton.textContent = 'Valor copiado'; }
      catch { copyButton.textContent = 'Erro ao copiar'; }
      setTimeout(() => { copyButton.textContent = 'Copiar valor único'; }, 2000);
    }

    // E2-03: gestão remota OpenRouter (chave de gestão no cofre; hash opaco)
    async function saveOrManagementKey(event) {
      event.preventDefault();
      const keyInput = document.getElementById('or-mgmt-key');
      const msg = document.getElementById('or-mgmt-config-msg');
      try {
        const res = await authorizedFetch('/local/openrouter/management/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: keyInput.value }) });
        if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data && data.error && data.error.type ? data.error.type : 'save_failed'); }
        keyInput.value = '';
        if (msg) { msg.className = 'msg ok'; msg.textContent = 'Chave de gestão guardada no cofre local. Nunca usada para inferência.'; }
      } catch (error) {
        if (keyInput) keyInput.value = '';
        if (msg) { msg.className = 'msg err'; msg.textContent = 'Erro: ' + explainLocalError(error && error.message ? error.message : 'save_failed'); }
      }
    }

    async function clearOrManagementKey() {
      const msg = document.getElementById('or-mgmt-config-msg');
      const res = await authorizedFetch('/local/openrouter/management/config', { method: 'DELETE' });
      if (res.ok) { if (msg) { msg.className = 'msg ok'; msg.textContent = 'Chave de gestão removida do cofre.'; } }
      else if (msg) { msg.className = 'msg err'; msg.textContent = 'Não foi possível remover agora.'; }
    }

    async function createOrRemoteKey(event) {
      event.preventDefault();
      const nameInput = document.getElementById('or-mgmt-name');
      const limitInput = document.getElementById('or-mgmt-limit');
      const valueInput = document.getElementById('or-mgmt-value');
      const copyButton = document.getElementById('copy-or-key-btn');
      const msg = document.getElementById('or-mgmt-msg');
      const body = { operationId: crypto.randomUUID(), name: nameInput.value.trim() };
      if (typeof limitInput.value === 'string' && limitInput.value.trim()) {
        const limit = Number(limitInput.value.trim());
        if (!Number.isFinite(limit) || limit < 0) { if (msg) { msg.className = 'msg err'; msg.textContent = 'Limite inválido.'; } return; }
        body.limit = limit;
      }
      if (msg) { msg.className = 'msg'; msg.textContent = 'Criando chave remota (cobrança da sua conta OpenRouter)...'; }
      try {
        const res = await authorizedFetch('/local/openrouter/management/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data && data.error && data.error.type ? data.error.type : 'create_failed');
        if (typeof data.keyValueOnce === 'string' && data.keyValueOnce) { valueInput.value = data.keyValueOnce; copyButton.disabled = false; }
        else { valueInput.value = ''; copyButton.disabled = true; }
        if (msg) { msg.className = 'msg ok'; msg.textContent = 'Chave remota ' + (data.view && data.view.hash ? data.view.hash : '?') + ' criada. O valor não reaparece.'; }
        refreshOrKeys();
      } catch (error) {
        valueInput.value = ''; copyButton.disabled = true;
        if (msg) { msg.className = 'msg err'; msg.textContent = 'Erro: ' + explainLocalError(error && error.message ? error.message : 'create_failed'); }
      }
    }

    async function refreshOrKeys() {
      const feed = document.getElementById('or-keys-feed');
      if (!feed) return;
      feed.className = 'msg status-feed';
      feed.textContent = 'Consultando chaves remotas...';
      try {
        const res = await authorizedFetch('/local/openrouter/management/keys?operationId=' + encodeURIComponent(crypto.randomUUID()));
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data && data.error && data.error.type ? data.error.type : 'list_failed');
        const views = Array.isArray(data.views) ? data.views : [];
        if (!views.length) { feed.textContent = 'Nenhuma chave remota.'; return; }
        feed.textContent = views.map((v) => '• ' + (v.name || '?') + ' ' + v.hash + (v.disabled ? ' [desativada]' : '') + ' limite=' + (v.limit ?? '—')).join('\\n');
      } catch (error) {
        feed.className = 'msg err status-feed';
        feed.textContent = 'Lista indisponível: ' + explainLocalError(error && error.message ? error.message : 'list_failed');
      }
    }

    document.getElementById('refresh-status-btn')?.addEventListener('click', updateLiveStatus);
    document.getElementById('refresh-client-keys-btn')?.addEventListener('click', refreshClientKeys);
    document.getElementById('client-key-form')?.addEventListener('submit', createScopedClientKey);
    document.getElementById('copy-scoped-token-btn')?.addEventListener('click', copyScopedToken);
    document.getElementById('or-mgmt-config-form')?.addEventListener('submit', saveOrManagementKey);
    document.getElementById('or-mgmt-clear-btn')?.addEventListener('click', clearOrManagementKey);
    document.getElementById('or-mgmt-create-form')?.addEventListener('submit', createOrRemoteKey);
    document.getElementById('refresh-or-keys-btn')?.addEventListener('click', refreshOrKeys);
    document.getElementById('copy-or-key-btn')?.addEventListener('click', async () => {
      const valueInput = document.getElementById('or-mgmt-value');
      const copyButton = document.getElementById('copy-or-key-btn');
      if (!valueInput || !valueInput.value) return;
      try { await navigator.clipboard.writeText(valueInput.value); copyButton.textContent = 'Valor copiado'; }
      catch { copyButton.textContent = 'Erro ao copiar'; }
      setTimeout(() => { copyButton.textContent = 'Copiar valor único'; }, 2000);
    });
    document.getElementById('refresh-local-models-btn')?.addEventListener('click', refreshLocalModelsInventory);
    document.getElementById('integration-client-form')?.addEventListener('submit', provisionIntegrationClient);
    document.getElementById('copy-client-token-btn')?.addEventListener('click', copyIntegrationToken);
    document.getElementById('copy-beta-feedback-btn')?.addEventListener('click', copyBetaFeedbackDraft);
    document.getElementById('copy-status-snapshot-btn')?.addEventListener('click', copyStatusSnapshot);
    document.getElementById('optional-provider-name')?.addEventListener('change', loadOptionalProviderProfile);
    document.getElementById('optional-provider-form')?.addEventListener('submit', configureOptionalProviderFromUi);
    loadOptionalProviderProfile();

    // User-defined provider creation
    async function createUserDefinedProvider(event) {
      event.preventDefault();
      const nameInput = document.getElementById('udp-name');
      const endpointInput = document.getElementById('udp-endpoint');
      const modelInput = document.getElementById('udp-model');
      const keyInput = document.getElementById('udp-key');
      const ackInput = document.getElementById('udp-ack');
      const button = document.getElementById('udp-save-btn');
      const msg = document.getElementById('udp-msg');
      if (!ackInput || !ackInput.checked) { if (msg) { msg.className = 'msg err'; msg.textContent = 'Confirme que entende a responsabilidade antes de salvar.'; } return; }
      const rawName = nameInput && typeof nameInput.value === 'string' ? nameInput.value.trim().toLowerCase() : '';
      if (!rawName || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(rawName) || rawName.endsWith('-')) { if (msg) { msg.className = 'msg err'; msg.textContent = 'Nome inválido. Use letras minúsculas, números e hífen (1-50 chars, sem terminar em hífen).'; } return; }
      const providerName = 'custom-' + rawName;
      const endpointUrl = endpointInput && typeof endpointInput.value === 'string' ? endpointInput.value.trim() : '';
      const model = modelInput && typeof modelInput.value === 'string' ? modelInput.value.trim() : '';
      const key = keyInput && typeof keyInput.value === 'string' ? keyInput.value : '';
      if (!endpointUrl || !model) { if (msg) { msg.className = 'msg err'; msg.textContent = 'Informe endpoint e modelo.'; } return; }
      button.disabled = true;
      msg.className = 'msg'; msg.textContent = 'Salvando ' + providerName + '...';
      try {
        const res = await authorizedFetch('/local/provider/configure-optional', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: providerName, endpointUrl: endpointUrl, model: model, key: key, acceptProviderRisk: true })
        });
        const body = await res.json().catch(function() { return {}; });
        if (!res.ok) throw new Error(body && body.error && body.error.type ? body.error.type : 'provider_save_failed');
        keyInput.value = ''; ackInput.checked = false;
        msg.className = 'msg ok'; msg.textContent = providerName + ' salvo e ativo. Atualize as conexões no dashboard para selecionar seu modelo.';
        updateLiveStatus();
      } catch (error) {
        keyInput.value = '';
        msg.className = 'msg err'; msg.textContent = 'Erro: ' + explainLocalError(error && error.message ? error.message : 'provider_save_failed');
      } finally { button.disabled = false; }
    }
    document.getElementById('user-defined-provider-form')?.addEventListener('submit', createUserDefinedProvider);

    // Preset dropdown auto-fill
    document.getElementById('udp-preset')?.addEventListener('change', function() {
      var val = this.value;
      var parts = val.split('|');
      var nameInput = document.getElementById('udp-name');
      var endpointInput = document.getElementById('udp-endpoint');
      var modelInput = document.getElementById('udp-model');
      if (nameInput) nameInput.value = parts[0] || '';
      if (endpointInput) endpointInput.value = parts[1] || '';
      if (modelInput) modelInput.value = '';
      var keyInput = document.getElementById('udp-key');
      var acknowledgement = document.getElementById('udp-ack');
      if (keyInput) keyInput.value = '';
      if (acknowledgement) acknowledgement.checked = false;
    });

    updateLiveStatus();

    document.querySelectorAll('form[data-provider]').forEach((form) => {
      form.addEventListener('submit', (event) => saveProvider(event, form.getAttribute('data-provider')));
    });
    document.querySelectorAll('[data-revoke]').forEach((button) => {
      button.addEventListener('click', () => revokeProvider(button.getAttribute('data-revoke')));
    });
  </script>
</body>
</html>`;
}

function providerCard(id: "groq" | "gemini", label: string, configured: boolean, enabled: boolean, placeholder: string, gemini = false): string {
  const stateClass = enabled && configured ? "on" : configured ? "configured" : "";
  const stateText = enabled && configured ? "ativo" : configured ? "configurado" : "não configurado";

  return `<section class="card" id="provider-${id}">
    <div class="card-header">
      <h2>${label}</h2>
      <span data-state="${id}" class="pill ${stateClass}"><i class="dot"></i>${stateText}</span>
    </div>

    ${gemini ? `
      <div class="notice warn">
        <strong>Aviso de Privacidade (Gemini Free):</strong> ${escapeHtml(GEMINI_FREE_PRIVACY_NOTICE)}
      </div>
      <label class="consent-box">
        <input data-aceito="gemini" type="checkbox">
        <span><strong> ACEITO</strong> — concordo com os termos do nível gratuito do Gemini para uso de inferência.</span>
      </label>
    ` : `
      <p class="notice">
        Use sua conta do serviço. A chave fica no cofre nativo deste dispositivo.
      </p>
    `}

    <form data-provider="${id}">
      <label for="${id}-key">Chave de API / Provider Key</label>
      <input id="${id}-key" data-key="${id}" type="password" autocomplete="off" spellcheck="false" placeholder="${placeholder}">
      <div class="btn-row">
        <button data-save="${id}" type="submit">Salvar ${label}</button>
      </div>
    </form>

    <label for="${id}-revoke" class="revoke-label">Remover acesso ao serviço</label>
    <input id="${id}-revoke" data-revoke-confirm="${id}" type="text" autocomplete="off" spellcheck="false" placeholder="Digite REVOGAR para confirmar">
    <div class="btn-row">
      <button data-revoke="${id}" class="secondary" type="button">Revogar ${label}</button>
    </div>

    <div data-msg="${id}" class="msg"></div>
  </section>`;

}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
