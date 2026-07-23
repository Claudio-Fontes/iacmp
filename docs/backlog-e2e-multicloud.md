# Backlog e2e — paridade por nuvem (AWS + Azure)

> **Régua (definida pelo usuário, 2026-07-03):** um prompt só está testado end-to-end quando tem **deploy na AWS + deploy no Azure + testes funcionais nos dois + destroy nos dois** — o MESMO cenário, em ciclos **isolados e independentes por nuvem**. Não existe (nem é objetivo) dependência cruzada entre nuvens: nenhum recurso AWS consome serviço Azure nem vice-versa. É o modo padrão de trabalho — não precisa ser repetido por tarefa. Ciclos sempre em projeto NOVO por cloud, zero edição em arquivos gerados.

## Matriz da bateria (01–20) pela régua dupla

Status AWS = bateria jun/jul + re-validações pós-refactors. Status Azure = só o que passou por deploy real.

| # | Cenário | AWS | Azure | Gap Azure (o que falta na ferramenta) |
|---|---|---|---|---|
| 01 | React CRUD + RDS + CloudFront | ✅ e2e (2×) | 🔄 em teste (p01az) | Postgres flexible server, CDN, site estático — deploy inédito |
| 02 | CRUD serverless DynamoDB | ✅ synth; 🔄 deploy (p02aws) | 🔄 em teste (p02az) | — (Cosmos Table validado no azure05) |
| 03 | SQS worker (producer→fila→consumer) | ✅ e2e (3 runs) | ❌ gap | Consumer de fila: Service Bus + KEDA scale rule (adapter só fala HTTP) |
| 04 | S3 CORS + refs de bucket | ✅ | ❌ não testado | Storage static/CORS — validar emissor |
| 05 | EventBridge scheduling | ✅ | ❌ gap | Agendamento: Container Apps Jobs (cron) ou Logic Apps |
| 06 | Site estático + OAC | ✅ e2e | ❌ não testado | Static website + CDN — validar emissor |
| 07 | Fan-out SNS→SQS | ✅ e2e | ❌ gap | Service Bus topic→queue ok no emissor; consumer = mesmo gap do 03 |
| 08 | API + Redis cache | ✅ e2e (2×) | ⛔ plataforma (2026-07-22) | Redis clássico RETIRADO pela Azure (recusa criação); Managed Redis (redisEnterprise Balanced_B0) = CreateFailed em 5 tentativas × 3 regiões (centralus/eastus2/westus2) — restrição da subscription free-trial. Synth já migrado p/ redisEnterprise (correto); DECISÃO do usuário 2026-07-22: re-testar SÓ quando a conta for de camada paga (sem mais sondas nem ticket). tier-map marca unavailable. |
| 09 | RDS PostgreSQL em VPC | ✅ e2e | ❌ não testado | Postgres flexible + VNet — sai do p01az |
| 10 | Fargate + ALB + autoscaling | ✅ e2e | ❌ não testado | Container Apps é o runtime natural — validar ingress/scale |
| 11 | S3→Lambda→DynamoDB (trigger) | ✅ e2e | ❌ gap | Trigger de blob: Event Grid → Container App |
| 12 | JWT Authorizer | ✅ | ❌ gap | Policy de validação JWT no APIM |
| 13 | CloudWatch + SNS | synth ✅ (deploy pendente) | ❌ gap | Azure Monitor alerts + Action Groups |
| 14 | Step Functions (aprovação) | ✅ e2e | ❌ gap | Sem equivalente implementado (Logic Apps / Durable Functions) |
| 15 | WAF no API Gateway | ✅ e2e | ❌ gap | WAF: Front Door ou App Gateway (APIM Consumption não tem WAF nativo) |
| 16 | DocumentDB | synth ✅ (deploy = pago, decisão do usuário) | ❌ não testado | Cosmos Mongo mapeado — deploy inédito |
| 17 | Kinesis | synth ✅ (conta AWS sem assinatura) | ❌ gap | Event Hubs + consumer (mesmo gap de runtime do 03) |
| 18 | Config multi-ambiente (secrets) | ✅ e2e | ❌ não testado | Key Vault mapeado — validar leitura no handler (managed identity ou env) |
| 19 | WebSocket | ✅ e2e | ❌ gap | Web PubSub (APIM/Container Apps não fazem WebSocket stateful) |
| 20 | Microsserviço RDS+Redis+alarme | synth ✅ | ❌ não testado | Composição de 08+09+13 — depende deles |

**Legenda:** ✅ validado · 🔄 ciclo em andamento · ❌ pendente · gap = exige feature nova na ferramenta; "não testado" = mapeamento existe, falta deploy real.

## Gaps de runtime Azure (features novas, por ordem de desbloqueio)

1. **Consumer de fila/stream** (desbloqueia 03, 07, 17): Container Apps + KEDA scale rule para Service Bus/Event Hubs; adapter precisa de modo "queue poller" além do HTTP
2. **Agendamento** (05): Container Apps Jobs com cron
3. **Trigger de storage** (11): Event Grid subscription → endpoint do Container App
4. **JWT no APIM** (12): policy `validate-jwt` gerada a partir do authorizer do construct
5. **Monitor/alertas** (13, 20): metric alerts + Action Group (email/webhook)
6. **WAF** (15): decisão de mapeamento — Front Door Standard vs App Gateway
7. **Workflow** (14): decisão — Logic Apps (declarativo, mais próximo do ASL) vs Durable Functions
8. **WebSocket** (19): Azure Web PubSub + handlers de evento

## Correções pré-re-run do p02 (achados do ciclo 2026-07-03; aplicar na janela entre ciclos)

1. ✅ **FEITO (2026-07-23) — Guard de synth: env vars dos handlers.** `validateHandlerEnvVars` (extrai `process.env.X` do fonte e exige a chave no `environment` do construct) já existia e é chamado no synth, MAS tinha o furo dos handlers aninhados: derivava o fonte do `Handler` ('index.handler'→src/index.ts) e PULAVA em silêncio handlers em pasta (`src/handlers/<op>/index.ts`, o layout que o synth gera). Criado helper compartilhado `resolveHandlerSrc` (cobre flat + aninhado, espelhando o `Code`) e religados 4 validadores (env-vars, handler-files, vpc-secrets, vpc-gateway) — agora protegem o caso comum. Testado: handler aninhado sem env → erro.
2. ✅ **FEITO — `iacmp init --azureRegion`.** Flag existe (`commands/init.ts`, default `eastus2`) e grava no iacmp.json.
3. ✅ **FEITO — Prompt Azure DynamoDB vs DocumentDB.** `prompts/azure/database.ts` já distingue: chave-valor/"DynamoDB" → `Database.DynamoDB`; documentos/Mongo → `Database.DocumentDB`, com atributos de `ref()` por tipo.

## Itens de ferramenta já registrados (fora da matriz)

- **Validação de tier/região no synth e deploy** — `resource-tier-map.ts` + `azure-resource-check.ts` existem mas só são chamados no `iacmp ai`. Integrar no `synth` e no `deploy` (e nos MCP tools `synth_project`/`deploy_project`) para que o check rode independente do flow de entrada.

- ✅ **FEITO (2026-07-23) — Validador de organização de stacks (anti-monólito).** `validateStackDomainSeparation` (validators/index.ts) chamado no synth: rejeita stack com ≥4 domínios estruturais distintos (rede/compute/dados/storage/cache/mensageria) — o clássico `main-stack.ts` com tudo junto. Limiar 4 porque combos de 3 são legítimos (serverless=compute+dados+storage) e o maior exemplo do corpus tem 3 → zero falso positivo. Testado via synth (monólito de 4 rejeitado com mensagem clara). Sobra: espelhar no `mcp__iacmp__write_stack` (iacmp-mcp).

- ⏳ **Exemplos `examples/` (parcial)** — `examples/{webapp,database,network}` têm 2 domínios por stack (passam no validador ≥4, não quebram), mas idealmente separados p/ o modelo aprender bem. Baixa prioridade (não bloqueiam). O corpus @iacmp/knowledge está limpo (max 3 domínios/stack).

- ✅ **FEITO (2026-07-23) — Template `fullstack` do `iacmp init` separado por domínio.** Era monólito (VPC+Compute+Database+Storage num arquivo) — o próprio validador anti-monólito o rejeitaria. Refatorado em 4 stacks (`stacks/network`, `stacks/database`, `stacks/compute`, `stacks/storage`) via `extraFiles`. Testado: `init --template fullstack && synth` passa (CFN validate OK nas 4).

- **Convenção de stacks: SEPARADAS por domínio em AMBAS as clouds** — confirmado pelo usuário. Input TypeScript deve ter stacks separadas por domínio (messaging, compute, database, api, network…) tanto no AWS quanto no Azure. O `_main.bicep` é OUTPUT gerado automaticamente pelo synth Azure a partir dessas stacks separadas — não é um input `main.ts` escrito à mão. Os agentes de bateria estavam gerando `stacks/main-stack.ts` monolítico para ambas as clouds — isso é errado e precisa ser corrigido nas instruções dos agentes e no template do `iacmp init`.

- **Performance do deploy Azure** (achados 2026-07-21; o piso APIM ~30-45min e CAE ~15-20min é da plataforma, mas o nosso lado amplifica):
  1. 2º passo re-deploya o `_main.bicep` inteiro só para preencher FQDN do Event Grid (`deploy.ts:195-223`) — tornar incremental (só o módulo afetado)
  2. Zip deploy das Functions é sequencial com retry 10s (`azure.ts:421-429`) — paralelizar
  3. esbuild + zip refeitos a cada deploy sem cache, inclusive no 2º passo (`azure.ts:150-390`) — cachear bundles por hash do fonte
  4. `waitForStackTerminal` com `Atomics.wait` de 30s bloqueante (`azure.ts:655`) — reduzir granularidade/desbloquear

- ✅ **FEITO (2026-07-23, iacmp `f569c4e`) — APIM compartilhado (`azureSharedApim`).** `iacmp.json` → `azure.sharedApim: { name, resourceGroup }`. Presente → synth Azure referencia o APIM `existing` (não cria `Microsoft.ApiManagement/service`) e cria só os filhos (apis/backends/operations/policies/namedValues) prefixados pelo projeto (nome ARM + path no gateway). Ausente → comportamento atual (regressão zero: 144 testes + golden inalterados). Destroy: como o APIM vira `existing` (fora da deployment stack), o `deleteAll` já não o toca — só as APIs do projeto saem. Validado com `az bicep build`. LIMITAÇÃO cross-RG (BCP165 scope mismatch): implementado o caso mesmo-RG (o real); cross-RG exigiria módulos aninhados (deployment stack) — registrado. Elimina o piso de ~30-45min de APIM por projeto.

- **`Fn.Lambda` Azure sem VNet integration** — Functions no plano Consumption não suportam VNet (limitação de plataforma); Flex Consumption suporta. Hoje o único compute com `subnetIds` no Azure é `Compute.Container`. Avaliar suporte a Flex Consumption para paridade com Lambda-em-VPC da AWS. (Achado bat3-azure-p07, 2026-07-22.)

- **`destroy_project` reporta falha prematura em Lambda-em-VPC** — o comando retorna erro no timeout padrão mas o CloudFormation segue deletando (ENI cleanup demora); e a stack de VPC não ganha novo trigger automático após o RDS terminar (bat3-aws-p09 precisou de `delete-stack` manual na vpc-stack). Fix: aguardar DELETE_IN_PROGRESS de verdade + re-disparar stacks dependentes ao final.

- **Exemplos AWS do KB com padrões que o validador atual rejeita** (achado bat3-aws-p08) — `REDIS_HOST: ref('AppCache','Host')` ('Host' nunca existiu no RESOLVE_MAP; é Endpoint/Port) e `TABLE_NAME: 'ItemsTable'` literal (validador exige `ref()` explícito). Corrigir NA FONTE (`packages/knowledge/src/corpus` no monorepo iacmp) — mais um caso para os testes de contrato dos exemplos.

- ✅ **FEITO (2026-07-23, iacmp `10199e0`) — Destroy AWS bucket Retain órfão.** `maybePurgeRetainedBuckets` (commands/destroy.ts) detecta os buckets do PROJETO (declarados nos templates, DeletionPolicy Retain, com BucketName) que sobreviveram e oferece esvaziar (incl. TODAS as versões + delete-markers, via `emptyBucket`) e remover — com CONFIRMAÇÃO (sem TTY/--force só avisa). `emptyBucket` testado contra S3 real versionado (2 versões + 1 marker → removido).

- ✅ **FEITO (2026-07-23, iacmp `10199e0`) — Destroy Azure RG casca vazia.** `maybeDeleteEmptyRg` (commands/destroy.ts): após o destroy, se o RG ficou VAZIO (checa `az resource list`), oferece removê-lo com CONFIRMAÇÃO (nunca às cegas — RG pode ser compartilhado; sem TTY/--force só avisa). Lógica segura por construção (só RG comprovadamente vazio); teste end-to-end contra Azure real pendente (lento/caro), mas a construção é conservadora.

- ✅ **FEITO (2026-07-23, iacmp-mcp master; GitHub Actions verde) — Testes de contrato dos exemplos do knowledge base + gate de CI** — harness `iacmp-mcp/test/contract-battery.mjs` (`npm run test:contract`) roda `iacmp synth` real sobre cada exemplo + 10 invariantes + cobertura da matriz; modos `curados` e `db`. Achou 112/242 quebrados → corpus saneado para 126/126. **CI-gate no ar** (`.github/workflows/contract-harness.yml`): roda em todo push/PR, checa os 2 repos públicos, builda o iacmp, linka core/knowledge local (IACMP_LINK_LOCAL), roda o harness — **passou 126/126, 0 falhas**. Bônus: o gate expôs um bug real de UX (`iacmp synth --provider aws` falhava sem credencial/região AWS; synth é offline) — corrigido em `commands/synth.ts` (`fix(cli)` 60bafc4). Mata a classe "dessincronização". Sobra: as deps `@iacmp/knowledge`/`@iacmp/core` são resolvidas via `file:`/link no CI porque `@iacmp/knowledge` não é publicado — ver item de distribuição.

- ✅ **FEITO (2026-07-22, iacmp-mcp master `2e9a395`) — Unificar as fontes de conhecimento** — os 105 legados que só existiam no banco vivo (`~/.iacmp/knowledge.db`, do `insert-batch` manual, JSON fora do repo) foram materializados em `iacmp-mcp/src/knowledge/legacy/examples.ts` (versionado) e merjados em `ALL_EXAMPLES` (=126). `migrateStatic` semeia do repo e roda no boot do MCP → **banco == repo automaticamente**. Agora "no repo" == "no banco" == "validado pelo harness"; corrigir um exemplo é 1 commit que vale para gerador + teste. Backup dos 242 originais em `knowledge.db.pre-purge.bak`. Sobra: deprecar `insert-batch.ts` (fonte agora é o repo).

- Deploy Azure sem Docker local (blob+SAS) — adiado, ver plano-p4
- **Handlers multi-cloud nível 2 (facade `@iacmp/runtime`) — APROVADO pelo usuário 2026-07-22 ("tudo separado com abstração").** Handler importa só interfaces agnósticas (kv/table, sql, blob, queue, cache, events); adaptador por cloud resolvido no bundle/deploy; prompts de IA + knowledge base migram juntos. Ver plano-p4.
  - ✅ **Fase 1 FEITO (2026-07-23, iacmp main `9701d2e`)** — pacote `packages/runtime` (facade `table`/`blob`, adaptadores AWS DynamoDB/S3 + Azure Mongo/Blob), wiring de deploy via esbuild-alias por cloud, `noExternal` exclui runtime (publicável). Shims mantidos (coexistência).
  - ✅ **Fase 2 FEITO (2026-07-23, iacmp main `13e3933` + iacmp-mcp `fcc0dc9`)** — prompts aws/azure database+storage e exemplos KB (dynamodb-crud/s3-presigned/s3-lambda-trigger/cosmos-table-crud + legados) migrados p/ `import { table }/{ blob } from '@iacmp/runtime'`; validador Lambda-em-VPC detecta serviço via facade (Gateway VPC Endpoint não some com a abstração); fallback ao driver bruto onde o facade não cobre. Harness 126/126.
  - ⏳ **Fase 3 PENDENTE (expandir cobertura + deprecar shims)** — o facade hoje é estreito: `table()` só `partitionKey:'id'` SEM sortKey; `blob()` Azure FIXO no container `'data'`; sem equivalente p/ filtro `<`, HeadObject/ETag, StorageClass DEEP_ARCHIVE, Object Lock. Por isso ~14 exemplos ficaram nos shims. Expandir o facade (chave composta, container nomeado, range/predicados, metadados) → migrar os ~14 restantes → só então deprecar `azure-dynamo-shim`/`azure-s3-shim`.
- Migração GCP/Azure para o grafo (P4) + GCP via Terraform — ver plano-p4
- Prompt: tabela de atributos de `ref()` gerada de `CONSTRUCT_ATTRIBUTES` (34 tipos)
- Deprecar refs string (só após bateria completa com refs tipadas)
- Release 1.2.2 (npm 1.2.1 não tem os fixes de hoje) — publicar da main pós-merge
- PR da branch `feat/bateria-prompts-deploy-real` → main
- Goldens multi-stack fora do cfn-lint (um arquivo por stack)

## Processo por ciclo (o padrão validado)

Projeto novo por cloud (`pNN aws`/`pNN az`) → `iacmp ai` (geração por provider) → synth → deploy → teste funcional com evidências (status codes) → destroy + verificação de conta limpa. Bug de ferramenta: corrigir na ferramenta → `npm run sync` → REGERAR em projeto novo. Nunca editar gerados.

- **Preflight lag do Container Apps Environment em VNet cross-stack** (achado p09 Azure, 2026-07-22) — quando VNet+subnet(delegada) e o `Microsoft.App/managedEnvironments` são criados no MESMO top-level Deployment Stack, o preflight do Microsoft.App pode rejeitar com `ManagedEnvironmentSubnetDelegationError` mesmo com a subnet comprovadamente delegada (Succeeded, sem SAL) — é lag do plano de validação do Microsoft.App vs Microsoft.Network. Template idêntico ao p07 (que passou). Mitigação a avaliar: deployar a stack de rede como operação separada e deixar assentar antes do CAE, OU retry com backoff no preflight do CAE. NÃO é bug de synth (template correto).

- **Quota: 1 Container App Environment por região por subscription** (achado 2026-07-22, contenção entre 2 agentes de bateria paralelos em centralus — `MaxNumberOfRegionalEnvironmentsInSubExceeded`). Consequência operacional: baterias Azure que usam `Compute.Container` NÃO podem rodar em paralelo na MESMA região — serializar o slot de CAE, ou distribuir por regiões diferentes. Vale também para o retest em camada paga (confirmar se o limite sobe fora do free-trial). NÃO é bug de ferramenta.

- **Capacidade de AKS regional trava criação de CAE** (achado p07-check, 2026-07-22) — `AKSCapacityHeavyUsage` em centralus (Container Apps roda sobre AKS; região sem capacidade no momento). Pior: quando o CAE falha por capacidade, fica preso em estado interno `Failed` e TODO redeploy seguinte falha no preflight com `ManagedEnvironmentNotReadyForAppCreation` — e `destroy_project` NÃO remove o CAE órfão (precisa `az` manual). Não é bug de synth (synth limpo, CAE chega a ser criado). Mitigação: região alternativa para CAE, ou detectar CAE em Failed e limpá-lo antes de redeploy. Reforça a serialização (1 CAE/região) + o valor do nível rápido (harness não toca CAE).

- **SNS→SQS fan-out cross-stack quebra o synth** (achado pelo harness, 2026-07-22) — `Messaging.Topic` com `subscriptions[].protocol:'sqs'` gera `AWS::SQS::QueuePolicy` com `Queues:[Ref]` same-stack direto (não passa pelo resolvedor cross-stack, diferente do `Endpoint` da subscription que passa). Topic numa stack + Queue em outra → synth falha "Ref para recurso inexistente". Workaround no fixture `aws-sns-fanout` (Queue+Topic na mesma stack, legítimo). Fix real = rotear o `Queues:[]` do QueuePolicy pelo mesmo resolvedor cross-stack. Dono: cloudformation-expert.

## Achados da sessão hook-001 (deploy real AWS, 2026-07-23)

- ✅ **FEITO (iacmp `424450f`) — Mensagem de erro de deploy enganosa.** `deploy/exec.ts` emitia "Se for um problema de autenticação…" em QUALQUER falha de comando (aws/az/gcloud/terraform) — enganou 2× numa sessão (falha por export cross-stack em uso; e por handler não compilado), nada era auth. Corrigido: `deployFailureMessage()` neutro, lista as causas por probabilidade (erro de deploy → artefato faltando → credencial por último).

- ✅ **FEITO (iacmp `424450f`) — Handlers aninhados não compilavam no deploy.** `ensureLambdaCodeBuilt` (deploy/aws.ts) derivava o fonte do `Handler` ('index.handler'→src/index.ts), errando para handlers em pasta (`src/handlers/<op>/index.ts`) — pulava em silêncio, `dist/` ficava vazio e `cloudformation package` quebrava com "file does not exist". Corrigido: derivar o dir-fonte do `Code` (dist/…→src/…) e o arquivo do módulo do Handler. O deploy compila os handlers sozinho (sem `npm run build` manual); provado em deploy real (dist apagado → rebuild ok).

- ✅ **FEITO (2026-07-23, iacmp `8f3dd77`) — Export cross-stack AWS: pré-flight no deploy.** `checkExportConflicts` (deploy/aws.ts) roda antes do package (read-only: describe-stacks + list-imports): se um export que a stack tem hoje SOME no template novo E ainda está em uso, ABORTA com orientação ("não é update incremental — rode `iacmp destroy && iacmp deploy`") em vez do rollback confuso lido como "credencial inválida". Testado contra AWS real (2 SSM stacks): detecta o export-em-uso-que-some; 0 falso positivo quando permanece ou a stack é nova. Opção (b) deploy em 2 fases fica como evolução futura; hoje o pré-flight + destroy/recreate resolve.

- **Distribuição da knowledge base para o cliente (npm install)** — ✅ **CÓDIGO FEITO (2026-07-23, iacmp `b191c33` + iacmp-mcp `aaee9bb`); falta só PUBLICAR.** Escolhida a rota (a)+(b) unificadas: o corpus (126 exemplos) + o seeder saíram do iacmp-mcp e foram para `@iacmp/knowledge` (`packages/knowledge/src/corpus` + `seed.ts` com `ensureSeeded()`), que agora é "corpus + retrieval + seed". Como o CLI INLINA `@iacmp/knowledge` no bundle, o corpus viaja embutido; `searchKnowledgeBase` semeia `~/.iacmp/knowledge.db` no 1º uso (gate por hash, idempotente). Corrigido também o furo `better-sqlite3` não-declarado nas deps do CLI. O MCP passou a consumir de `@iacmp/knowledge` (sem cópia local — some a duplicação). Harness 126/126; caminho do cliente testado (banco cru → exemplo validado). **PENDENTE = a publicação** (ver item RELEASE abaixo): publicar `@iacmp/knowledge` (agora com o corpus) e `@iacmp/runtime`, depois bumpar/publicar o CLI. Enquanto não publicar, o cliente do `@iacmp/mcp` ainda não instala limpo (a CLI já resolve pelo bundle).

- **RELEASE: publicar `@iacmp/runtime` junto com a CLI** (achado 2026-07-23, regra [[feedback-npm-client-impact]]) — a Fase 1 do facade tornou `@iacmp/runtime` uma dependência EXTERNA (não inlinada) da CLI publicável (`packages/cli/package.json` + `tsup noExternal` exclui runtime). Ele NÃO está no npm (E404). Publicar a próxima `iacmp` sem publicar `@iacmp/runtime@0.1.0` antes quebra `npm install -g iacmp` do cliente. Checklist de release: publicar `@iacmp/runtime` (e resolver o mesmo pendente de `@iacmp/knowledge`) ANTES de bumpar a CLI. Deps de runtime do adaptador Azure (`mongodb`, `@azure/storage-blob`) precisam estar resolvíveis no bundle do deploy (como os shims hoje).

- **Loop de aprendizado: knowledge base auto-enriquecida por deploy real** (ideia do usuário, 2026-07-23) — HOJE não existe: infra inédita que passa synth+deploy+teste NÃO volta pra base; o conhecimento se perde e o próximo pedido parecido começa do zero. Decidido (2026-07-23) em DOIS modos opt-in, "dar pra receber":
  - ✅ **MODO 1 — base local isolada (FEITO 2026-07-23, iacmp `61d5efd`):** opt-in `iacmp.json` → `knowledge.autolearn: "local"` (default off). Após deploy bem-sucedido de padrão INÉDITO, o CLI mostra preview e oferece gravar na base LOCAL (`~/.iacmp/knowledge.db`, `origin='local'`, `validated=true`) — fica só no cliente, nada enviado. Impl: `@iacmp/knowledge` ganhou colunas `origin`/`provenance` (migração idempotente) + `addLocalExample`/`hasSimilarExample`/`fingerprintOf`; re-seed nunca apaga locais; `packages/cli/src/learn.ts` (buildCandidate→generalize(no-op)→persist) com hook em `deploy.ts` (3 pontos de sucesso, guardado por !dry-run). Gatilho = auto-pós-deploy-com-preview; sem notas (só estrutura). Forward-compat com o Modo 2: título genérico, id determinístico por fingerprint, provenance `shareStatus='private'`, slot `generalize()`. Harness 126/126.
  - **MODO 2 — compartilhado/central (BACKLOG, estruturar antes de fazer):** cliente opta por compartilhar anonimizado → base central; em troca recebe o coletivo. Decisões de design a fechar:
    - **QUE se compartilha:** só a FORMA da infra (stacks generalizadas: constructs + grafo + wiring + env vars, com nomes trocados) + handlers ESQUELETIZADOS (shape sem lógica de negócio). NUNCA código de negócio cru — é onde mora o dado proprietário. O valor do iacmp é o padrão de infra multi-cloud, não a regra de negócio.
    - **PRA ONDE vai:** preferir **GitHub como base central** (CLI abre PR/issue no repo `@iacmp/knowledge`; curadoria = review do PR; gate = harness no CI; promoção = merge que já propaga p/ banco e cliente) — ZERO infra nova. Alternativa cara: backend próprio (ingestão+fila+dedup global+curadoria) — só se virar produto.
    - **Privacidade (limitação honesta):** "zero exposição automática garantida" NÃO é realista. Mitigação em 3 camadas: (1) compartilhar só estrutura+esqueleto; (2) CLI mostra PREVIEW exato do que será enviado e cliente APROVA (não é cego); (3) curadoria no PR. + termos de contribuição.
  - Gates herdados (valem p/ os 2 modos): HARNESS (synth+invariantes, só entra se verde), `validated:true` só se deploy-validado, escrita via fonte única (repo/banco conforme o modo) — sem eles, reintroduz o rot dos 112 purgados. Prioridade: média-alta.
