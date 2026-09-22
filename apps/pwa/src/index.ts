import { createSecretStore } from '@uptokey/core';

export function initializePwaApp(): void {
  console.log('Inicializando Uptokey PWA Tricoluna...');
  const store = createSecretStore();
  console.log(`Backend de armazenamento seguro detectado: ${store.backend}`);
}

export * from './index.js';
