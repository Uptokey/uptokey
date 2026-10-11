# E2-20 W0 contract stubs (lab)

**Status:** `proposed_lab` — mirrors W0 capability shape for product merge later.

These files live under `20-work/contracts/` on purpose. They are **not** edits to Windows
`quimera/uptokey/sync-contract` or any shared package. Merge into W0 only when sole ownership
of that package is proven and a normal product PR is opened.

| File | Role |
| --- | --- |
| `diagnostic.js` | Parsers, limits, error codes, capability descriptors |
| `diagnostic.d.ts` | TypeScript shapes for the same |
| `operations.json` | Machine-readable operation catalog |

Consumers today: lab `W5DiagnosticAdapter` + unit tests. Product UI (AC09) and real W0 publish remain pending.
