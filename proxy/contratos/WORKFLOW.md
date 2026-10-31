# Workflow v1 — contrato de integração W0

Revisão `1.2.0`; `schemaVersion: 1`. Fonte única: `workflow.js` e `workflow.d.ts`.
Import: `@uptokey/sync-contract/workflow`. Não confundir com o contrato de sincronização E2EE ou recibos financeiros hospedados.

## Consumo pelos agentes

```ts
import {
  parseExecutionPlan, parseProjectContext, parseWorkflowCommand,
  canonicalPlanPayload, canonicalContextSnapshotPayload, validatePlanBindings,
  type ExecutionPlan, type ProjectContext,
} from '@uptokey/sync-contract/workflow';
```

Os parsers recebem `unknown`, rejeitam campos extras/versões desconhecidas e devolvem cópia independente. Erro público: `WorkflowContractError` com `code: workflow_invalid`, sem incluir conteúdo recebido. Tipos TypeScript não validam JSON; usar o parser na fronteira.

As interfaces descrevem os campos; limites numéricos, cardinalidade e relações entre campos são verificados em runtime. `steps: []` é inválido mesmo que TypeScript aceite a construção de um array vazio. O objetivo de um projeto pode estar vazio e pode ser limpo via patch; seu nome não pode ser vazio. Um comando de planejamento exige objetivo não vazio.

`test/fixtures/workflow.json` contém todos os tipos, relatório sintético, versão atualizada de projeto, plano de atualização, receita e valor ilustrativo de US$ 0,36. Os hashes são reais para esses dados sintéticos. Regeneração: `node test/fixtures/build-workflow-fixture.mjs`, a partir deste pacote. Fixtures não comprovam execução real, preço de mercado ou qualidade de modelo.

## Responsabilidade dos consumidores

- W1 usa `ProjectContext`, `ContextSnapshot`, `Artifact`. Owner/revisões/timestamps são do servidor. Nunca aceitar `ownerPrincipalId` de comando cliente.
- W2 usa `CapabilityDescriptor`, `PlanStep`, `ExecutionPlan`. Registro confiável fornece código, schema de cada operação e destinos; o catálogo editorial não concede execução.
- W3 usa `ProjectGrant`, `Run`, `ExecutionReceipt`. Validação estrutural não autoriza, não valida transições históricas e não reserva quotas. Derivar sujeito do token/pareamento; verificar grant, digest, destinos, revogação e limites antes de cada despacho.
- W4 usa `Recipe`, `RecipeBinding`. Receita não carrega autorização. Binding `parameter` deve ser resolvido/validado antes de construir `ExecutionPlan`.
- W6 usa `ReferenceTariff`, `UsageValueReceipt`, `RationalMicros`. Preço de referência não é fatura. W0 valida representação, não calcula preço nem garante autenticidade da tarifa.
- UI usa `WorkflowCommands`, tipos e fixtures. Endpoints ainda pertencem à integração W5, não são criados por W0.

## Hashes e referências

Gerar `contextSnapshotDigest = SHA-256(UTF8(canonicalContextSnapshotPayload(snapshot)))` em hex minúsculo. Construir plano com `digest` provisório de 64 zeros; calcular `digest = SHA-256(UTF8(canonicalPlanPayload(plan)))`. O payload canônico exclui somente o próprio digest. Recalcular e comparar ambos no executor; não confiar no hash enviado. Pode usar `node:crypto` no proxy ou WebCrypto no navegador; o contrato não importa APIs Node.

`validatePlanBindings` verifica projeto, revisão, ID do snapshot, versões/disponibilidade das capacidades e destinos. Não verifica hashes criptográficos, conteúdo dos arquivos, expiração, posse do projeto, scopes nem assinatura/autoria. O policy service deve completar essas checagens. Um plano adulterado com digest bem formado pode passar no parser; nunca despachar sem recalcular o digest e vinculá-lo à aprovação.

Refs a etapas só apontam para etapas anteriores, pelo campo `output` nomeado. Resolver esse nome segundo `outputSchemaId` do adapter. IDs de artefatos e fontes devem ser resolvidos no projeto autenticado, sem buscar conteúdo por URL arbitrária. Literais são dados, não expressões executáveis. O schema de argumentos de cada capability é validado pelo adapter após resolver bindings, antes de produzir efeitos.

No snapshot, `entries` são as entradas selecionadas para envio e `excludedEntryIds` são entradas do projeto deliberadamente não selecionadas. Os conjuntos devem ser disjuntos; W1 confere que ambos pertencem à revisão do projeto. Exigir que um excluído apareça também em `entries` seria contraditório.

## Persistência e limites

Revisão 1.1.0 adiciona `PlanApproval` e `parsePlanApproval`, promovendo o formato de entrada de W3 sem alterar seus campos. A aprovação é um registro interno vinculado a projeto, principal, plano, digest, destinos e expiração. O servidor a produz a partir da confirmação autenticada; nunca aceitar uma aprovação completa enviada pelo modelo/cliente. Persistir o registro completo e consumir `consumedByRunId` na mesma transação que cria o run. O parser aceita registros expirados para leitura histórica e não autoriza execução.

O contrato aceita no máximo 256 KiB por registro/snapshot/comando JSON, 12 etapas/plano e 256 entradas/fontes por snapshot. A quota de 100 MiB refere-se ao armazenamento total do projeto, incluindo artefatos separados; não aumenta o tamanho permitido do snapshot. Artefatos carregam metadados, nunca corpo inline. Exportação valida/remapeia nomes se necessário e obtém autorização de pasta separadamente. Nome válido não é autorização de filesystem.

Grants têm versão e expiração; parser aceita grants expirados/revogados para leitura histórica. Executor decide se estão ativos com relógio confiável. Parser de run valida estados terminais básicos, não a máquina de transições: W3 mantém essa autoridade. `unknown` não autoriza retry automático de inferência.

## Prazo de execução

Em planos e grants, `ExecutionLimits.timeoutMs` limita o run inteiro, não cada chamada. O prazo absoluto é `Run.createdAt + min(plan.limits.timeoutMs, grant.limits.timeoutMs)`. Etapas, esperas entre tentativas e tempo transcorrido durante uma interrupção consomem esse orçamento. Recuperar um run não renova seu prazo. Limites de tempo anunciados por uma capacidade restringem sua operação e não ampliam o orçamento restante do run.

W3 verifica o prazo antes de novos despachos e propaga `deadlineAt` e `AbortSignal` ao serviço de efeitos. W5 deve preservar esses limites nas chamadas e no fallback. Abortar não comprova que o provedor deixou de executar ou cobrar: inferência já despachada sem resultado conclusivo permanece `unknown`, sem reenvio automático. A implementação atual depende do relógio do host; esta regra não constitui proteção contra retrocesso desse relógio.

## Medição e dólares

`TokenUsage` preserva entrada ou saída parcial, com campos ausentes `null`; `basis: unknown` exige todos nulos. Valores de referência agregáveis exigem entrada/saída reportadas e tarifa. Uso estimado/parcial não entra como valor confirmado. `cachedInputTokens` é subconjunto da entrada. Adapter precisa normalizar unidade e semântica do provedor.

Tarifa v1 cobre **tokens**, não imagem/áudio/chamada. Unidades adicionais exigem evolução explícita. Preços são strings inteiras em microdólares por milhão de tokens; montantes racionais são `{numeratorMicros, denominator}`. Por exemplo `360000000000 / 1000000` microdólares = US$ 0,36. W6 verifica a fórmula e a correspondência modelo/provedor/tarifa e vigência.

`confirmedUptokeyCharge` zero exige evidência do modo gratuito; o parser não consegue conferir faturamento. `estimatedProviderCharge` não é cobrança confirmada. Cache local não entra no total de uso upstream. Se houver várias causas de exclusão, prioridade recomendada: local_cache → missing_usage → estimated_usage → not_comparable → missing_tariff. UI mostra a cobertura do projeto/executor, não alega cobertura global.

## Comandos iniciais

`createProject`, `importProject`, `patchProject` (nome/objetivo/restrições), `createPlan`, `startRun`, `cancelRun`, `createRecipe`, `recipePlan`. Todos passam por `parseWorkflowCommand`. Alteração de entradas de contexto/grants e confirmação humana terão comandos específicos na integração, com autoridade validada; não aceitar snapshots inteiros do LLM como comandos de alteração.

Revisão 1.2.0 adiciona `importProject`: `legacyId`, nome, objetivo e até 256 entradas selecionadas com `id`, `content` e `origin: user/model`. O comando não aceita proprietário, caminho, status confirmado ou autorização. A integração deriva proprietário e ID de importação no servidor, mantém o original e cria as entradas como propostas. Reimportação do mesmo legado/sujeito abre a cópia existente sem sobrescrevê-la.

A integração HTTP aceita seleção explícita de entradas e artefatos ao planejar. As exclusões são registradas no snapshot e participam do digest. Quando a seleção é omitida numa atualização, a integração preserva a seleção do último plano, inclusive conjuntos vazios. Material novo exige seleção e nova aprovação; importar ou planejar não executa efeitos.

Congelamento: agentes usam esta revisão e propõem alterações ao Codex. Não editar exports ou inventar equivalentes em cada módulo. Novas necessidades resultam em revisão de contrato e atualização conjunta de fixtures, declarações e consumidores. W0 não é autorização para pular W3 nem evidência de conclusão dos cinco componentes.

## Propostas de ferramentas do gateway — versão 1

GATEWAY_TOOL_CONTRACT_VERSION=1 adiciona parseGatewayFunctionTools e parseGatewayToolProposal ao módulo gateway. Catálogo: 1–16 funções, nomes únicos, parâmetros JSON object, description e strict opcionais; até 65536 bytes canônicos. Proposta: schemaVersion, content textual ou null e 1–16 toolCalls com IDs únicos e nomes presentes no catálogo aprovado. Strings de arguments são preservadas exatamente e devem conter objeto JSON limitado. A validação específica do schema e a autorização pertencem à criação do plano e ao executor; esses parsers não buscam referências de schema nem executam ferramentas.

A revisão 3 do contrato de chat admite tools, tool_choice (auto, none, required ou função nomeada) e parallel_tool_calls. Ausência e valores explícitos permanecem distintos no digest. Na revisão 3, histórico de mensagens tool não era admitido; a revisão 4 descrita abaixo estende esse limite. Propostas recebidas em JSON ou no frame terminal SSE são persistidas como artefatos application/json vinculados ao run; nenhuma ferramenta é executada por essa persistência. A tradução existente do 9Router é reutilizada.

POST /v1/workspace/projects/:id/tool-plans recebe somente expectedRevision, artifactId e callId (parseGatewayToolPlanRequest). O servidor resolve o artefato do proprietário, exige run/recibo gateway concluídos, recupera as ferramentas do plano produtor e usa os argumentos persistidos. Apenas ferramentas presentes no catálogo filesystem atual podem virar plano; relativePath passa pelo parser existente. O plano registra proveniência (artefato, chamada e run produtor) e exige novo consentimento P256. A PWA oferece seleção explícita das ferramentas, apresenta a proposta e prepara esse novo plano. Propostas e resultados locais ficam fora de inferenceMessages e não são regeneráveis. Provas automatizadas e visuais estão em quimera/output/gateway-tools-execution/.


A revisão 4 acrescenta histórico assistant/tool pareado: IDs únicos, resultados vinculados às chamadas aprovadas e nenhuma chamada sem resultado ao final do pedido. POST /v1/workspace/projects/:id/tool-result-plans recebe somente expectedRevision e resultArtifactId. O runtime reconstrói o histórico a partir da proposta e do resultado persistidos, verifica a proveniência e prepara outro plano com tool_choice none. A implementação atual aceita retorno de proposta com uma chamada; conjuntos de múltiplas chamadas são recusados como incompletos. Preparar não despacha: o novo envio exige consentimento P256. O contexto automático continua excluindo esses registros. Integração ponta a ponta desta revisão está em verificação; as provas da revisão 3 não a substituem.

GatewayProtocolRequest v1 preserva body JSON exato e protocolo openai-responses/anthropic-messages. POST projects/:id/protocol-plans prepara via tradutor upstream restrito, armazena arguments.protocol original e chat/wire transformados no digest. A porta interna autenticada /api/quimera/normalize opera sem despacho; não é endpoint de inferência nativo. Campos sem representação, reparação de argumentos/histórico e truncamento de IDs são recusados.

GET /v1/workspace/projects/:id/runs/:runId/protocol-output projeta o resultado persistido de um run concluído para JSON Responses ou Messages, usando os tradutores upstream. Aceita o artefato canônico JSON ou SSE concluído, verifica proprietário e recibo, e não cria inferência. Identidade, timestamp e uso devem ter sido fornecidos pelo provedor; valores desconhecidos não são substituídos por números fictícios. A apresentação e o artefato original são publicados juntos. Quatro casos em processo real com provedor falso estão registrados em quimera/output/gateway-protocols/result.json.

GET /v1/workspace/projects/:id/runs/:runId/protocol-events transmite eventos SSE nativos da execução já aprovada. `after=N` ou `Last-Event-ID: N` retoma após o evento N; valores conflitantes são recusados. O término só é publicado depois do run e recibo `succeeded`, com referência ao artefato persistido. Desconectar o consumidor não repete nem cancela a inferência. A recuperação após reabertura reconstrói somente streams concluídos a partir do artefato, sem executar o modelo. Há limites de sessões, bytes e consumidores; falha de observação não altera o efeito. Anthropic aguarda uso medido quando ele não chega antecipadamente. A prova com tradutores reais, consentimento e provedor local controlado está em quimera/output/gateway-protocols/runtime-events-result.json. As rotas públicas padrão /v1/responses e /v1/messages não estão implementadas.

## Revisão 1.3.0 — escrita externa explícita

CapabilityDescriptor admite write_external somente com retryClass never_automatic. O contrato browser exporta BrowserFillRequest v1: URL do perfil controlado e até oito pares label/value, sem código, seletor, ferramenta ou submit fornecido pelo cliente. Limites de texto/UTF-8, duplicidade de rótulo e propriedades extras são validados antes de qualquer worker. O parser não autoriza a operação; o plano e o consentimento continuam vinculando os dados exatos. O preenchimento sequencial pode ser parcial em caso de falha e não deve ser repetido automaticamente. Integração do serviço, das rotas e da interface em andamento; isto não anuncia automação pública de formulários.
