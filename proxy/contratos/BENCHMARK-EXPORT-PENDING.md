# E2-22 — `./benchmark` export — DONE

# E2-22 — `./benchmark` export pending

`package.json` exports were **not** modified: E2-13 currently reserves `sync-contract/package.json`.

Consumers should import via relative path until the integrator adds:

```json
"./benchmark": { "types": "./benchmark.d.ts", "import": "./benchmark.js" }
```

Files ready: `benchmark.js`, `benchmark.d.ts`, `test/benchmark.test.mjs`.
Mirrored to `vendor/sync-contract/` (uptokey-work + uptokey-sync/proxy-local).


Marked DONE by Surgical-Apply-E2-22.
