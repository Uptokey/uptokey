import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionProfileService, defaultProfileId, memoryConnectionStorage } from "../src/connection-profiles.ts";
import { MemorySecretStore } from "../src/secret-store.ts";
import { defaultConfig } from "../src/config.ts";

function service() {
  const secrets = new MemorySecretStore();
  return { secrets, profiles: new ConnectionProfileService(secrets, memoryConnectionStorage()) };
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

test("E2-02 AC-02-01: duas contas do mesmo provedor vivem separadas", async () => {
  const { profiles } = service();
  const first = await profiles.create({ schemaVersion: 1, providerId: "groq", label: "Pessoal", accessMode: "byok", enabled: true, modelIds: ["m1"] }, "gsk_primeira-chave-0123456789abcdef");
  const second = await profiles.create({ schemaVersion: 1, providerId: "groq", label: "Trabalho", accessMode: "byok", enabled: true, modelIds: ["m1"] }, "gsk_segunda-chave-0123456789abcdef");
  assert.notEqual(first.id, second.id);
  const list = await profiles.list();
  assert.equal(list.filter((p) => p.providerId === "groq").length, 2);
  assert.equal(await profiles.readCredential(first), "gsk_primeira-chave-0123456789abcdef");
  assert.equal(await profiles.readCredential(second), "gsk_segunda-chave-0123456789abcdef");
});

test("E2-02 AC-02-02: revogar uma conta preserva a outra", async () => {
  const { profiles, secrets } = service();
  const first = await profiles.create({ schemaVersion: 1, providerId: "groq", label: "A", accessMode: "byok", enabled: true, modelIds: [] }, "gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const second = await profiles.create({ schemaVersion: 1, providerId: "groq", label: "B", accessMode: "byok", enabled: true, modelIds: [] }, "gsk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  await profiles.revoke(first.id, first.revision);
  assert.equal(await profiles.get(first.id), undefined);
  assert.equal(await secrets.get(`conn:${first.id}`), undefined);
  const kept = await profiles.get(second.id);
  assert.ok(kept);
  assert.equal(await profiles.readCredential(kept!), "gsk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});

test("a default cleanup failure retains the exact association, denies false success and permits a confirmed retry", async () => {
  for (const failure of ['hook','secret'] as const) {
    let failing=true, hooks=0;
    class Store extends MemorySecretStore { async delete(key:string) { if(failing && failure==='secret') throw Error('synthetic_delete_failed'); await super.delete(key); } }
    const secrets=new Store(),storage=memoryConnectionStorage(),profiles=new ConnectionProfileService(secrets,storage,{onDefaultRevoked:async(_provider,remaining)=>{hooks++;assert.equal(remaining,true);if(failing&&failure==='hook')throw Error('synthetic_hook_failed');config.providers.groq.configured=false;}});
    const config=structuredClone(defaultConfig);config.providers.groq.configured=true;config.providers.groq.enabled=true;
    await secrets.set('provider:groq','synthetic-default-key');await profiles.migrateFromLegacy(config);
    const original=(await profiles.get(defaultProfileId('groq')))!;
    const named=await profiles.create({schemaVersion:1,providerId:'groq',label:'Named',accessMode:'byok',enabled:true,modelIds:['m1']},'synthetic-named-key');
    await assert.rejects(profiles.revoke(original.id,original.revision),new RegExp(`synthetic_${failure==='hook'?'hook':'delete'}_failed`));
    assert.equal((await profiles.get(original.id))?.revision,original.revision);
    const reopened=new ConnectionProfileService(secrets,storage);await reopened.migrateFromLegacy(config);
    assert.equal((await reopened.list()).filter(row=>row.id===original.id).length,1,'failure never removes then remigrates a legacy association');
    assert.equal(await profiles.readCredential(named),'synthetic-named-key');
    failing=false;const confirmed=(await profiles.get(original.id))!;assert.equal((await profiles.revoke(original.id,confirmed.revision)).revoked,true);assert.equal(hooks,2);
    assert.equal(await profiles.get(original.id),undefined);assert.equal(await secrets.get('provider:groq'),undefined);assert.equal(await profiles.readCredential(named),'synthetic-named-key');
  }
});

test("E2-02: CAS de revisão e replay de operationId não duplicam", async () => {
  const { profiles } = service();
  const created = await profiles.create({ schemaVersion: 1, providerId: "gemini", label: "G", accessMode: "byok", enabled: true, modelIds: [] }, "AIza-some-key-01234567890123456789", UUID_A);
  const replay = await profiles.create({ schemaVersion: 1, providerId: "gemini", label: "G", accessMode: "byok", enabled: true, modelIds: [] }, "AIza-some-key-01234567890123456789", UUID_A);
  assert.equal(replay.id, created.id);
  assert.equal((await profiles.list()).length, 1);
  await assert.rejects(profiles.update(created.id, { revision: 999, label: "X" }), /revision_conflict/);
  const updated = await profiles.update(created.id, { revision: 1, label: "G2" });
  assert.equal(updated.revision, 2);
  assert.equal(updated.label, "G2");
  await assert.rejects(profiles.revoke(created.id, 1), /revision_conflict/);
  void UUID_B;
});

test("E2-02: migração legada é determinística, idempotente e preserva o legado", async () => {
  const { profiles, secrets } = service();
  const config = structuredClone(defaultConfig);
  config.providers.groq.configured = true;
  config.providers.groq.enabled = true;
  await secrets.set("provider:groq", "gsk_legada-012345678901234567890123");
  const first = await profiles.migrateFromLegacy(config);
  assert.deepEqual(first.created, ["groq"]);
  const again = await profiles.migrateFromLegacy(config);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.skipped, ["groq"]);
  const expectedId = defaultProfileId("groq");
  const profile = await profiles.get(expectedId);
  assert.ok(profile?.migratedFromLegacy);
  // Leitura compatível: segredo acessível pelo namespace por conexão…
  assert.equal(await profiles.readCredential(profile!), "gsk_legada-012345678901234567890123");
  // …e o legado segue intacto para o roteador.
  assert.equal(await secrets.get("provider:groq"), "gsk_legada-012345678901234567890123");
});

test("a connection born from the provider configuration follows models and switch chosen later", async () => {
  const { profiles, secrets } = service();
  const config = structuredClone(defaultConfig);
  config.providers.groq.configured = true;
  config.providers.groq.enabled = true;
  config.providers.groq.models = ["a-model"];
  await secrets.set("provider:groq", "gsk_legada-012345678901234567890123");
  await profiles.migrateFromLegacy(config);
  config.providers.groq.models = ["b-model", "a-model"];
  config.providers.groq.enabled = false;
  await profiles.migrateFromLegacy(config);
  const profile = await profiles.get(defaultProfileId("groq"));
  assert.deepEqual([...profile!.modelIds], ["b-model", "a-model"]);
  assert.equal(profile!.enabled, false);
  assert.equal(profile!.revision, 2);
  assert.equal(profile!.label, "groq (default)");
  assert.equal(await profiles.readCredential(profile!), "gsk_legada-012345678901234567890123");
  const created = await profiles.create({ schemaVersion: 1, providerId: "groq", label: "Mine", accessMode: "byok", enabled: true, modelIds: ["x"] }, "gsk_outra-0123456789012345678901234");
  await profiles.migrateFromLegacy(config);
  assert.deepEqual([...(await profiles.get(created.id))!.modelIds], ["x"]);
});

test("E2-02 AC-02-08: projeção pública nunca carrega segredo", async () => {
  const { profiles } = service();
  await profiles.create({ schemaVersion: 1, providerId: "groq", label: "S", accessMode: "byok", enabled: true, modelIds: [] }, "gsk_segredo-012345678901234567890123");
  const views = await profiles.projectViews(async () => ({ supportLevel: "built_in", status: "unknown" }));
  assert.equal(views.length, 1);
  assert.equal("credentialRef" in views[0]!, false);
  assert.equal(views[0]!.credentialPresent, true);
  assert.match(views[0]!.accountLabel, /••/);
  assert.ok(!JSON.stringify(views).includes("gsk_segredo"));
});

test("E2-02: rótulo mascarado e conta local sem credencial", async () => {
  const { profiles } = service();
  const local = await profiles.create({ schemaVersion: 1, providerId: "ollama", label: "Local", accessMode: "local", enabled: true, endpointUrl: "http://127.0.0.1:11434/v1/chat/completions", modelIds: ["llama3.2"] });
  assert.equal(await profiles.credentialPresent(local), true);
  assert.equal(await profiles.accountLabel(local), "ollama");
  const noKey = await profiles.create({ schemaVersion: 1, providerId: "deepseek", label: "Sem chave", accessMode: "byok", enabled: true, modelIds: [] });
  assert.equal(await profiles.credentialPresent(noKey), false);
  assert.equal(await profiles.accountLabel(noKey), "sem credencial");
});

test("PT01/JT03: a conta marcada principal dirige o despacho do provedor", async () => {
  const { profiles } = service();
  const first = await profiles.create({ schemaVersion: 1, providerId: "groq", label: "Pessoal", accessMode: "byok", enabled: true, modelIds: ["m1"] }, "gsk_primeira-chave-0123456789abcdef");
  const second = await profiles.create({ schemaVersion: 1, providerId: "groq", label: "Trabalho", accessMode: "byok", enabled: true, modelIds: ["m1"] }, "gsk_segunda-chave-0123456789abcdef");
  // Empate (priority 0): criação mais antiga permanece.
  assert.equal((await profiles.getActiveProfileForProvider("groq"))?.id, first.id);
  // Promover a segunda conta: priority 100 dirige o despacho.
  await profiles.update(second.id, { revision: second.revision, priority: 100 });
  assert.equal((await profiles.getActiveProfileForProvider("groq"))?.id, second.id);
  assert.equal(await profiles.readCredential((await profiles.getActiveProfileForProvider("groq"))!), "gsk_segunda-chave-0123456789abcdef");
  // Principal desabilitada: cai para a conta habilitada restante.
  await profiles.update(second.id, { revision: second.revision + 1, enabled: false });
  assert.equal((await profiles.getActiveProfileForProvider("groq"))?.id, first.id);
  // Outro provedor não é afetado.
  assert.equal(await profiles.getActiveProfileForProvider("openai"), undefined);
});

test("a migrated connection uses the provider's own key: replacing the key reaches every service, no stale copy", async () => {
  const { profiles, secrets } = service();
  const config = structuredClone(defaultConfig);
  config.providers.groq.configured = true;
  config.providers.groq.enabled = true;
  await secrets.set("provider:groq", "gsk_primeira-012345678901234567890123");
  await profiles.migrateFromLegacy(config);
  const profile = (await profiles.get(defaultProfileId("groq")))!;
  assert.equal(profile.credentialRef, "provider:groq");
  assert.equal(await profiles.readCredential(profile), "gsk_primeira-012345678901234567890123");
  await secrets.set("provider:groq", "gsk_trocada-0123456789012345678901234");
  assert.equal(await profiles.readCredential(profile), "gsk_trocada-0123456789012345678901234");
  // A profile migrated earlier with a copy still answers with the current provider key.
  const legacyCopy = { ...profile, credentialRef: `conn:${profile.id}` };
  await secrets.set(`conn:${profile.id}`, "gsk_copia_antiga-01234567890123456789");
  assert.equal(await profiles.readCredential(legacyCopy), "gsk_trocada-0123456789012345678901234");
});
