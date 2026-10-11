# Uptokey

A coding assistant in your terminal, with a local service for your provider connections, project tools and conversations. Provider API keys are stored in the operating system's secret store.

- **Portable terminal beta:** Windows, macOS and Linux, on x64 or ARM64, with Node.js **22.12.0 or newer**. npm installs the matching renderer and runtime; no separate Bun setup is needed. Platform execution results accompany each release artifact.
- **Local API:** `http://127.0.0.1:21435/v1` by default.
- **License:** AGPL-3.0-or-later. See `LICENSE` and the included third-party notices.

## Open Uptokey

With Node.js installed, run one command:

```sh
npx --yes uptokey@latest
```

This downloads the current public release and opens it without a global install, administrator access or PATH configuration. npm selects the native components for your operating system and processor, including Intel and Apple Silicon Macs.

The command opens the coding interface in the current folder. To open another project:

```sh
npx --yes uptokey@latest "./my-project"
```

The launcher connects to the local service and starts it when needed. If local terminal access needs authorization, it asks you to confirm that access. You do not need to start the service manually for normal terminal use.

## Connect and start coding

1. Enter **`/connect`**. Choose a provider, then enter its API key in the masked credential field. Known providers have connection presets; a custom service may also need an endpoint. Local runtimes may not require a key and must already be running.
2. Choose a model from the returned list. Discovery uses the provider's account catalog where available; a declared catalog is identified as such. A listed model is not proof of available quota or a successful request.
3. After saving, the picker closes and the selected **provider and model** appear in the coding interface. Selecting an external model authorizes subsequent requests and their permitted context to go to that destination.
4. Write a normal request, for example: “Inspect this project and explain how to run its tests.” File tools operate on the authorized project. Review proposed changes and commands when prompted; applied changes have receipts.

Use **`/models`** to switch models, **`/projects`** to select a project and **`/sessions`** to reopen a saved conversation. Saved credentials and the destination preference are reused in the same local service profile. Ordinary letters are text; commands start with `/`, or use the command palette.

Normal conversations are stored locally. **`/temporary`** starts a conversation with temporary retention; it does not promise saved history or a remembered destination. The current processing policy is visible. **`/processing local`** restricts the conversation to local processing; choosing an external model changes that policy explicitly.

See [FIRST-RUN-BETA.md](./FIRST-RUN-BETA.md) for the complete first-use checklist and recovery steps.

## Language and accessibility

English is the default independently of the operating system language. Choose an interface language explicitly:

```sh
npx --yes uptokey@latest --lang pt-BR
npx --yes uptokey@latest --screen-reader
```

Available locales: `en`, `pt-BR`, `es`, `fr`, `de`, `it`, `ja`, `ko`, `zh-CN`, `ar`. The accessible linear presentation uses the same conversations, tools and local service.

Open **`/help`** for the current commands and keyboard controls. `tui`, `code`, `forge` and `--next` are compatibility aliases for the same terminal frontend.

## Diagnose a problem

Inside the terminal, use **`/doctor`**. Outside it:

```sh
npx --yes uptokey@latest doctor
npx --yes uptokey@latest version
npx --yes uptokey@latest help
npx --yes uptokey@latest tui --help
```

A successful key save or model discovery does not certify inference. If the first request fails, check the selected account/model, provider access, quota and the reported recovery action. Keep the draft and retry after correcting the cause.

BYOK requests do not require a fresh control-plane login solely because an offline grace period expired. Explicit revocation or suspension still applies. Do not change offline policy settings as a routine onboarding step.

## Other clients and automation

The CLI also exposes explicit administration and automation subcommands; `npx --yes uptokey@latest help` lists them. Terminal coding is the default interactive entry point.

OpenAI-compatible clients can use `http://127.0.0.1:21435/v1` with an authorized **local client token**, not a provider API key. The HTTP interfaces include Chat Completions, Anthropic Messages and the supported text/function-call subset of Responses, with streaming where supported. Unsupported input is rejected before dispatch.

`npx --yes uptokey@latest mcp` exposes the documented stdio tools. See [SPEC-MCP-V1.md](./SPEC-MCP-V1.md). Provider credentials and local vault tokens are not returned as MCP tool results.

This tarball contains the local core and terminal frontend. It does not include the PWA or Tauri desktop distribution. Other platform packages require their own built and tested renderer.

## Build and verify (maintainers)

From `proxy/core` in the source checkout:

```sh
npm ci
npm run pack:beta
npm run verify:beta
```

The packer includes the manifest-verified frontend and resolves the canonical first-use guide from `docs/beta/FIRST-RUN-BETA.md`. Verification checks the actual file inventory, runtime dependencies, frontend hashes, notices and forbidden paths; it does not rely on a fixed historical file count. Packaging does not publish.

Keep API keys out of prompts, repository files, environment examples, client configurations and screenshots. The local API binds to loopback; storing a key locally does not change the privacy terms of the provider you choose.
