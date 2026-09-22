import { createSecretStore } from '@uptokey/core';

export function initializeDesktop(): void {
  console.log('Inicializando Uptokey Desktop (Tauri runtime)...');
  const store = createSecretStore();
  console.log(`Cofre nativo: ${store.backend}`);
}
