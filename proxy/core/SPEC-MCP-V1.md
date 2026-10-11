# SPEC-MCP-V1 — Embedded MCP surface

## Start and transport

`uptokey mcp` exposes tools over MCP stdio. Start the local service first (normally by opening `uptokey`); the MCP command does not start it automatically. Standard output is reserved for MCP framing; session diagnostics use standard error.

The MCP-to-core HTTP client accepts only `http://127.0.0.1:21435`: no `localhost` DNS, alternate hosts or ports, credentials in URLs, or redirects. This restriction applies to that local transport. Inference may subsequently reach the configured provider; optional browser functionality may reach the requested website.

## Session and authorization

The command reads `local:api-token` from the operating system secret store and uses it only to provision a paired local client through `POST /local/client/provision`. Administrative and paired tokens remain in symbol-keyed private session properties and are omitted from public metadata and tool results. Public metadata includes `sessionId`, `clientId`, `scopes`, `expiresAt`, `proxyOrigin` and `proxyHost`.

Proxy-backed tools check an active session and their internal capability (`providers`, `models`, `chat`, `usage`, `doctor` or `browser`) before the HTTP request. The paired core token is provisioned with inference scope; core authorization remains authoritative. Default session lifetime is one hour. Stdio shutdown attempts client revocation through `/local/client/revoke` and clears the in-memory tokens. Pure helpers and local manifest inspection do not perform an HTTP request.

## Registered tools

| Tool | Behavior |
| --- | --- |
| `providers` | Projects configured provider/admission information from `GET /v1/connections`; omits credential-bearing endpoints and tokens. |
| `models` | Reads the local `GET /v1/models` catalog. |
| `usage` | Reads `GET /v1/usage`. |
| `doctor` | Reads `/health`, `/local/status` and `/v1/usage`; reports unavailable probes with public session metadata and recent sanitized audit entries. |
| `chat` | Sends non-streaming Chat Completions to `/v1/chat/completions`; returns projected completion metadata and assistant text. |
| `integrations_list` | Lists integration profiles; does not install them. |
| `integrations_copy` | Generates configuration previews for `cline`, `continue` or `aider`; does not install packages. |
| `skills_preview` | Builds a skill manifest and inspects destination files for conflicts; returns a preview without writing or executing files. |
| `skills_manifest` | Reads the installed skill manifest at the supplied target directory. |
| `mcp_discover` | Paginates a supplied list of tool definitions; does not execute `tools/call`. |
| `browser_navigate` | With an injected `WorkspaceBrowser`, reads a page with a deadline/output bound. The normal stdio entry has no injected browser and returns configured browser capability information from `/v1/workspace/browser`. |
| `browser_action_plan` | Creates a project browser-fill plan through `/v1/workspace/projects/<id>/browser-fill-plans`; returns `awaiting_w5_consent`, not proof of execution. |

## Models and chat

The catalog includes virtual IDs `auto`, `uptokey-auto`, `uptokey-fast` and `uptokey-coder`, plus enabled configured provider models. A catalog entry is not proof of account access, quota or successful inference. Virtual IDs are resolved by the router rather than sent upstream unchanged.

MCP `chat` accepts `system`, `user`, `assistant` and `tool` roles with string content, plus optional temperature and maximum tokens. Streaming is not exposed by this tool: omit `stream` or use `false`. It returns assistant text and selected metadata rather than the entire upstream response.

## HTTP interfaces outside MCP

The core also provides Chat Completions (`/v1/chat/completions`), Anthropic Messages (`/v1/messages`) and the supported text/function-call subset of Responses (`/v1/responses`), with streaming where supported. Unsupported inputs are rejected before dispatch. These HTTP surfaces are separate from the non-streaming MCP `chat` contract.

## Output and safety boundaries

Tool results pass redaction and `assertNoSecretMaterial` before serialization. Audit redaction removes recognized prompt-bearing fields and secret material. Provider keys and local session tokens are not returned as tool data. The proxy client rejects redirects, refuses expired/closed sessions before HTTP and caps each HTTP response body at 1 MiB; this cap is not a universal MCP-result size limit.

Local skill helpers inspect the supplied destination on disk. Configuration previews do not install integrations or execute skills. Browser-plan creation does not execute the plan; it follows the core's project revision, authorization and W5 consent flow. Stdio session startup is not acceptance of every optional browser/service capability, and this document does not publish or sign the package.
