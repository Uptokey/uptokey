/** The isolated journey fixture supplies the same controller and provider service to either presentation. */
import { createPrivateKey, sign } from "node:crypto"
import { TuiClient } from "../../client.ts"
import { TuiController } from "../../controller.ts"
import { createProviderSetupService } from "../../provider-setup.ts"
import { MemorySecretStore } from "../../../secret-store.ts"
import { autoDetect, setLang } from "../../i18n.ts"
import type { UptokeyMainOptions } from "./bootstrap.ts"

export async function fixtureOptions(): Promise<UptokeyMainOptions> {
  // A packaged main has a separate module instance; configure the injected controller's dictionary too.
  setLang(autoDetect([], process.env))
  const fixture = JSON.parse(process.env.UPTOKEY_FIXTURE ?? "{}") as {
    baseUrl: string; token: string; privateKeyPem: string; cwd: string; model?: string
    admin: string; empty?: boolean; upstreamPort: number
  }
  const key = createPrivateKey(fixture.privateKeyPem)
  const controller = new TuiController({
    cwd: fixture.cwd,
    baseUrl: fixture.baseUrl,
    token: fixture.token,
    processingPolicy: "external_allowed",
    folderMentionBinding: "off",
    client: new TuiClient({ baseUrl: fixture.baseUrl }),
    sign: (nonce: string) => sign("sha256", Buffer.from(nonce), { key, dsaEncoding: "ieee-p1363" }).toString("base64url"),
  })
  let providerSetup
  if (fixture.empty) {
    const secrets = new MemorySecretStore()
    await secrets.set("local:api-token", fixture.admin)
    const fixtureFetch: typeof fetch = Object.assign(
      (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => String(url).startsWith("https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models")
        ? fetch(`http://127.0.0.1:${fixture.upstreamPort}/models`, init)
        : fetch(url, init),
      { preconnect: fetch.preconnect },
    )
    providerSetup = createProviderSetupService({
      secrets,
      fetch: fixtureFetch,
      reload: async () => {
        const response = await fetch(`${fixture.baseUrl}/local/config/reload`, { method: "POST", headers: { authorization: `Bearer ${fixture.admin}` } })
        if (response.status !== 204) throw new Error("provider_reload_failed")
      },
    })
  }
  return { cwd: fixture.cwd, controller, screenReader: process.env.UPTOKEY_FIXTURE_LINEAR === "1", ...(providerSetup ? { providerSetup } : {}) }
}
