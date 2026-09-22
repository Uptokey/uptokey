# Política de Segurança e Zero-Knowledge - Uptokey

## Princípios Inegociáveis

1. **BYOK Local-First:** Nenhuma chave de API privada (BYOK) tratada pelo Proxy Local ou App Desktop jamais é enviada aos servidores da Uptokey ou mantida em armazenamento desprotegido do navegador (`localStorage`).
2. **Cofre Nativo do Sistema Operacional:** Chaves e credenciais são armazenadas exclusivamente via DPAPI (Windows), Keychain (macOS) ou Secret Service API / D-Bus (Linux).
3. **Telemetria Higienizada:** A telemetria operacional é estritamente limitada a contagem de tokens e códigos de status HTTP (OpenTelemetry GenAI). Prompts, mensagens de chat e arquivos do usuário NUNCA são gravados ou transmitidos.

## Divulgação Responsável

Caso identifique qualquer potencial vulnerabilidade de segurança, envie um e-mail confidencial para `security@medbizu.com`. Não abra issues públicas para falhas de segurança críticas.
