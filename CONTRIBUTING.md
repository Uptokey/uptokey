# Contributing

Uptokey welcomes focused fixes and improvements. Keep credentials, local
profiles, conversations and project files out of commits and issue reports.

The public source tree is the buildable source for the terminal beta. Use
Node.js 22.12 or newer:

```sh
npm ci --prefix proxy/integracoes/api-instruments
npm ci --prefix proxy/integracoes/e2-20-diagnostic
npm ci --prefix proxy/core
npm run verify
npm run build
npm test
```

Changes to provider behavior need a reproducible request contract, failure
mapping and recovery path. A catalog entry alone does not prove execution.
Contributions are licensed under AGPL-3.0-or-later unless a directory carries a
compatible upstream license and notice.
