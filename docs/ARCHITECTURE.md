# Arquitetura Uptokey

Visão geral da arquitetura de 4 camadas e da Cadeia Canônica da plataforma Uptokey.

## As 4 Camadas da Arquitetura

1. **Camada 1: Host OS & Cofre Nativo (Zero-Knowledge)**
   - Gerenciamento seguro de credenciais via primitivas do sistema operacional:
     - Windows: DPAPI (Data Protection API)
     - macOS: Apple Keychain Services
     - Linux: Secret Service API / D-Bus (libsecret)
   - Armazenamento em disco criptografado por chaves atreladas ao usuário da máquina.

2. **Camada 2: Daemon & Proxy Headless (`@uptokey/core`)**
   - Proxy reverso local HTTP/WebSocket que orquestra chamadas aos modelos de linguagem (OpenAI, Anthropic, Gemini, Ollama, etc.).
   - Aplicação de BYOK (Bring Your Own Key), medição de cotas/orçamentos (`quota-ledger.ts`) e injeção de credenciais em tempo real.
   - Nenhuma credencial trafega desprotegida ou sai para servidores intermediários Uptokey.

3. **Camada 3: Superfície de Apresentação Canônica (`apps/pwa`)**
   - Interface Web Tricoluna unificada com Design Bridge.
   - Comunicação local estrita com o daemon via HTTP/SSE (`http://127.0.0.1:4040`).
   - Sem dependência de nuvem Uptokey para persistência de conversas ou chaves.

4. **Camada 4: Clientes e Extensões (`apps/desktop`, `extensions/*`, `@uptokey/cli`)**
   - `apps/desktop`: Empacotador desktop em Rust com Tauri.
   - `extensions/vscode`: Integração com o editor VS Code via Language Server e comandos.
   - `extensions/chrome`: Assistente de navegação integrado via extensões Manifest V3.
   - `@uptokey/cli`: Ferramenta de linha de comando para terminal (`npx @uptokey/cli`).

## Cadeia Canônica de Requisição

```
PWA / Desktop / Extensões / CLI
       │
       ▼ (HTTP Local / Auth Bearer Local)
Daemon Proxy (@uptokey/core)
       ├── Validação de Cotas (quota-ledger)
       ├── Resgate de Chaves no Cofre SO (secret-store)
       └── Streaming com Provedor Externo (OpenAI / Anthropic / Gemini / Local)
```
