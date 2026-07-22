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

1. **Guard de synth: env vars dos handlers** — o modelo gera handler lendo `process.env.TABLE_NAME` mas omite `environment` no `Fn.Lambda` (CRUD inteiro 502 em runtime). Fix na altitude certa: validador de synth (padrão `validateHandlerDynamoNoSql`) que extrai os `process.env.X` do fonte do handler e exige a chave no `environment` do construct — erro claro que o loop de auto-correção conserta. + regra curta no system-prompt.
2. **`iacmp init` sem controle de região Azure** — gera `azureRegion: 'eastus'` fixo; os ciclos precisam de westus e dependem de edição manual do iacmp.json (setup frágil, dois agentes já esqueceram). Fix: flag `--azureRegion` no init (e considerar default westus enquanto East US estiver sem capacidade Cosmos).
3. **Prompt Azure: cenário "DynamoDB" ⇒ `Database.DynamoDB` SEMPRE** — o modelo escolheu `Database.DocumentDB` (Mongo) e o `COSMOS_CONNECTION` saiu como resource ID ARM (DocumentDB não tem ConnectionString no AZURE_ATTR_MAP). Fix: proibição explícita na seção condicional Azure + (opcional) suporte a ConnectionString no DocumentDB via listConnectionStrings.

## Itens de ferramenta já registrados (fora da matriz)

- **Validação de tier/região no synth e deploy** — `resource-tier-map.ts` + `azure-resource-check.ts` existem mas só são chamados no `iacmp ai`. Integrar no `synth` e no `deploy` (e nos MCP tools `synth_project`/`deploy_project`) para que o check rode independente do flow de entrada.

- **Validador de organização de stacks** (produção + bateria) — synth e `mcp__iacmp__write_stack` devem rejeitar arquivos que misturam domínios (ex: `Fn.Lambda` + `Database.DynamoDB` + `Network.VPC` no mesmo arquivo). Sem esse validador tanto o `iacmp ai` quanto os agentes de bateria geram monólito — a regra do CLAUDE.md não é suficiente porque os exemplos contradizem ela.

- **Exemplos `examples/` são monolíticos** — `examples/webapp/stacks/webapp-stack.ts` tem `Network.VPC` + `Storage.Bucket` no mesmo arquivo. O `iacmp ai` aprende pelo exemplo, não pela regra escrita no CLAUDE.md. Corrigir todos os exemplos para usar stacks separadas por domínio.

- **Template `fullstack` do `iacmp init` é monolítico** — `stackContent` do template `fullstack` em `commands/init.ts` tem VPC + Compute + Database + Storage numa única stack. Refatorar para gerar múltiplos arquivos separados.

- **Convenção de stacks: SEPARADAS por domínio em AMBAS as clouds** — confirmado pelo usuário. Input TypeScript deve ter stacks separadas por domínio (messaging, compute, database, api, network…) tanto no AWS quanto no Azure. O `_main.bicep` é OUTPUT gerado automaticamente pelo synth Azure a partir dessas stacks separadas — não é um input `main.ts` escrito à mão. Os agentes de bateria estavam gerando `stacks/main-stack.ts` monolítico para ambas as clouds — isso é errado e precisa ser corrigido nas instruções dos agentes e no template do `iacmp init`.

- **Performance do deploy Azure** (achados 2026-07-21; o piso APIM ~30-45min e CAE ~15-20min é da plataforma, mas o nosso lado amplifica):
  1. 2º passo re-deploya o `_main.bicep` inteiro só para preencher FQDN do Event Grid (`deploy.ts:195-223`) — tornar incremental (só o módulo afetado)
  2. Zip deploy das Functions é sequencial com retry 10s (`azure.ts:421-429`) — paralelizar
  3. esbuild + zip refeitos a cada deploy sem cache, inclusive no 2º passo (`azure.ts:150-390`) — cachear bundles por hash do fonte
  4. `waitForStackTerminal` com `Atomics.wait` de 30s bloqueante (`azure.ts:655`) — reduzir granularidade/desbloquear

- **APIM compartilhado (`azureSharedApim`) — DECIDIDO pelo usuário 2026-07-22: um só APIM para todos os testes; "se o APIM estiver no iacmp.json, usa".** Design: chave no `iacmp.json` (ex. `azure.sharedApim: { name, resourceGroup }`); presente → synth emite o APIM como `existing` e só cria APIs/operations/policies do projeto como filhos; destroy remove SÓ as APIs do projeto (nunca o APIM); ausente → comportamento atual (APIM próprio). Política de bateria: APIM compartilhado é infraestrutura da ferramenta (como o ACR de bootstrap) — fora da verificação de conta limpa. Elimina o piso de ~30-45min por projeto. Implementar assim que o fix do Managed Redis assentar (mesmos arquivos do synth Azure).

- **`Fn.Lambda` Azure sem VNet integration** — Functions no plano Consumption não suportam VNet (limitação de plataforma); Flex Consumption suporta. Hoje o único compute com `subnetIds` no Azure é `Compute.Container`. Avaliar suporte a Flex Consumption para paridade com Lambda-em-VPC da AWS. (Achado bat3-azure-p07, 2026-07-22.)

- **`destroy_project` reporta falha prematura em Lambda-em-VPC** — o comando retorna erro no timeout padrão mas o CloudFormation segue deletando (ENI cleanup demora); e a stack de VPC não ganha novo trigger automático após o RDS terminar (bat3-aws-p09 precisou de `delete-stack` manual na vpc-stack). Fix: aguardar DELETE_IN_PROGRESS de verdade + re-disparar stacks dependentes ao final.

- **Exemplos AWS do KB com padrões que o validador atual rejeita** (achado bat3-aws-p08) — `REDIS_HOST: ref('AppCache','Host')` ('Host' nunca existiu no RESOLVE_MAP; é Endpoint/Port) e `TABLE_NAME: 'ItemsTable'` literal (validador exige `ref()` explícito). Corrigir NA FONTE (iacmp-mcp src/knowledge) — mais um caso para os testes de contrato dos exemplos.

- **Destroy AWS deixa bucket Retain órfão (recorrente)** — todo prompt com `Storage.Bucket` (DeletionPolicy: Retain) termina com bucket órfão pós-destroy, às vezes com delete-marker de versionamento bloqueando `s3 rb` (p01, p04r, p06). Agentes limpam manualmente toda vez. Avaliar: `destroy --purge-retained` que esvazia (incl. versions/delete-markers) e remove buckets Retain do projeto, com confirmação.

- **Destroy Azure deixa o Resource Group como casca vazia** — `az stack group delete --action-on-unmanage resourceGroups:detach` remove os recursos mas desanexa o RG em vez de deletar (achado bat3-azure-p06, 2026-07-22; o agente precisou de `az group delete` manual). Avaliar: deletar o RG no destroy quando ele foi criado pelo iacmp (ou flag `--delete-rg`).

- **Testes de contrato dos exemplos do knowledge base** — cada exemplo do KB vira teste de CI: roda `iacmp synth` real sobre as stacks do exemplo e valida invariantes (tipo de recurso emitido, formato de connection string, env vars auto-injetadas, portas). Mata a classe de bug "dessincronização" que dominou 2026-07-22: Mongo migrado só no synth (prompt/helper/shim/KB para trás), `bucketRef` só no synth AWS, KB documentando Redis Enterprise com synth emitindo o clássico retirado. Todos os três teriam falhado em CI antes de qualquer deploy. Casa com a unificação das fontes (item abaixo).

- **Unificar as duas fontes de conhecimento** — hoje o mesmo "padrão da casa" vive em dois lugares: `packages/knowledge` (corpus indexado em memória pelo RAG do `iacmp ai`) e `iacmp-mcp/src/knowledge/` → `~/.iacmp/knowledge.db` (SQLite consultado via `search_examples`). Risco real de deriva — já aconteceu (3 exemplos com `BUCKET_NAME` errado corrigidos em 2026-07-21, um lado tinha o fix e o outro não). Alvo: uma fonte única (provavelmente `@iacmp/knowledge`) da qual o seed do MCP e o indexer do RAG derivam; correção de exemplo passa a valer para os dois front-ends num commit só.

- Deploy Azure sem Docker local (blob+SAS) — adiado, ver plano-p4
- **Handlers multi-cloud nível 2 (facade `@iacmp/runtime`) — APROVADO pelo usuário 2026-07-22 ("tudo separado com abstração"); PRÓXIMA feature grande após fechar a bateria 3.** Handler importa só interfaces agnósticas (kv/table, sql, blob, queue, cache, events); adaptador por cloud resolvido no bundle/deploy; shims (`azure-dynamo-shim`, `azure-s3-shim`) deprecados ao final da migração; prompts de IA + knowledge base migram juntos. Ver plano-p4.
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
