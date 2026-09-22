# Uptokey 🔑

> Assistente de IA Open Source, Local-First e Zero-Knowledge com Armazenamento de Chaves no Cofre Nativo do Sistema Operacional.
> Repositório Oficial: [github.com/Uptokey/uptokey](https://github.com/Uptokey/uptokey) | Organização: [@Uptokey](https://github.com/Uptokey)

## Arquitetura em Monorepo

- **`packages/core`**: Proxy headless local, gerenciamento de rotas e cofre nativo.
- **`packages/cli`**: Interface de linha de comando para terminal (`npx @uptokey/cli`).
- **`apps/pwa`**: Interface web canônica e Design Bridge.
- **`apps/desktop`**: App Desktop leve em Tauri/Rust.
- **`extensions/`**: Extensões para VS Code e Google Chrome.

## Desenvolvimento Local

```bash
# Instalar dependências
pnpm install

# Rodar typecheck em todos os pacotes
pnpm typecheck

# Executar testes
pnpm test
```

## Licença

Distribuído sob a licença [Apache-2.0](./LICENSE).
