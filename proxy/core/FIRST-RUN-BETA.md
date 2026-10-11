# Uptokey — first use of the terminal beta

Updated: 2026-10-08.

This guide covers the portable terminal beta for Windows, macOS and Linux (x64 and ARM64). It covers the supplied npm tarball, not the PWA or Tauri desktop installer. Use Node.js **22.12.0 or newer**; npm installs the matching renderer and runtime automatically. Consult the accompanying release evidence for the platforms exercised with this artifact. Earlier self-contained Windows tarballs remain Windows-only.

## Open Uptokey

With Node.js installed, run one command:

```sh
npx --yes uptokey@latest
```

This downloads the current public release and opens it without a global install, administrator access or PATH configuration. npm selects Intel or Apple Silicon components automatically on macOS.

The command opens the coding interface in your current folder and starts or reconnects to its local service. To select a folder at launch, use `npx --yes uptokey@latest "./my-project"`. If asked to authorize this terminal's local access, confirm after reviewing the prompt. This local identity is separate from the provider API key.

The interface opens in English. An explicit `--lang` selects `en`, `pt-BR`, `es`, `fr`, `de`, `it`, `ja`, `ko`, `zh-CN` or `ar`. Use `--screen-reader` for the accessible linear presentation.

## Connect your first model

1. Type **`/connect`** and choose your provider.
2. Paste its API key into the **masked credential field**. The key goes to the operating system's secret store, not the conversation. Known-provider presets supply the connection details; custom services may ask for an endpoint. Local runtimes may not require a key and must already be running.
3. Select a model from the discovered account catalog. Services without compatible discovery may use a clearly identified declared catalog or request a model ID.
4. Confirm the selection. The dialog closes, the chat input returns and the **provider plus model** identify the destination.

Saving a key and retrieving a model list do not prove an inference request succeeded. The first response confirms that request's result. Your provider controls access, availability, quota and charges.

Choosing an external model authorizes subsequent requests and permitted project context to be sent to that destination. If you want only local processing, use **`/processing local`** and a local model. An external choice changes the policy explicitly; a send failure does not silently authorize another policy.

## Make the first request

Try:

> Inspect this folder, identify the project and explain how its tests run.

The assistant can list and read authorized project files through tools. You do not need to paste the whole project into chat. Use **`/projects`** or cite a folder path when you want to work elsewhere; review any requested change of project access.

For a small coding exercise in a test folder, try:

> Create a small JavaScript calculator app, add tests and run them.

Review proposed file changes and commands when prompted. Applied changes have receipts. A test or build must show its actual outcome; if the configured project runner is unavailable, it is reported as not executed. Use **`/doctor`** to inspect the cause.

Typing normal letters does not open a command. Use **`/`** or the command palette for actions. **`/help`** lists the available controls, including interruption, scrolling and copying.

## Continue without re-entering the key

- **`/models`** chooses another model from saved connections.
- **`/sessions`** reopens a saved conversation.
- Reopening Uptokey against the same local service profile reuses saved credentials and destination preferences.
- Normal conversation history is local. **`/temporary`** has temporary retention and does not promise a saved conversation or remembered destination.

Check the visible provider/model and processing policy before sending. A new terminal window and a new conversation are different from resuming an existing conversation.

## Recover in place

| Symptom | Next step |
| --- | --- |
| Service does not connect | Open `/doctor` or run `npx --yes uptokey@latest doctor`; follow the reported recovery action. Normal startup is handled by the launcher. |
| API key is rejected | Reopen `/connect`, check the provider/account and replace the credential in the masked field. Do not put it in chat. |
| Model is unavailable | Open `/models` and choose a model your account can use. A catalog entry alone is not proof of access. |
| Quota or rate limit is reached | Check the provider's account and retry when allowed, or explicitly choose another configured destination. |
| Conversation is local-only | Keep the restriction with a local model, or explicitly select the external destination you intend to authorize. |
| Test/build is not executed | Check the project runner diagnosis. A missing runtime configuration is not a successful test. |
| Existing service occupies the port | Diagnose the existing local service; do not start an unrelated second service or delete its profile. |

The local API defaults to `http://127.0.0.1:21435/v1`. BYOK requests do not require a fresh control-plane login solely because the offline grace period expired; revocation and suspension remain enforced. Offline-policy bypasses are not part of first use.

## Share useful feedback safely

Record the beta version (`npx --yes uptokey@latest version`), operating system, step that failed, expected behavior and the sanitized error/recovery message. Send it through the beta feedback channel provided with your distribution.

Do not include API keys, local client tokens, conversation contents, personal file contents or screenshots containing secrets. You do not need a source checkout or a developer script to report a problem.

This guide is onboarding documentation. It is not evidence of a complete clean-user coding journey, installer signing, other-platform acceptance or hosted free-credit availability.
