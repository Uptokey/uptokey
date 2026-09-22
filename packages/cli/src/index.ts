#!/usr/bin/env node
import { createSecretStore, QuotaLedger } from '@uptokey/core';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  console.log(`[Uptokey CLI] Executando comando: ${command}`);

  switch (command) {
    case 'status': {
      const store = createSecretStore();
      const keys = await store.listKeys();
      console.log(`Cofre ativo: ${store.backend}`);
      console.log(`Chaves configuradas: ${keys.length}`);
      break;
    }
    case 'quota': {
      const ledger = new QuotaLedger();
      console.log(`Consumo total de tokens: ${ledger.getTotalTokens()}`);
      break;
    }
    case 'help':
    default: {
      console.log(`Uso: uptokey <status|quota|help>`);
      break;
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error('Erro na execução do Uptokey CLI:', err);
    process.exit(1);
  });
}
