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
| 08 | API + Redis cache | ✅ e2e (2×) | ❌ não testado | Azure Cache for Redis mapeado — deploy inédito (custo/tempo de provisão ~20min) |
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

- **APIM compartilhado (`azureSharedApim`)** — modo em que o projeto referencia um APIM existente (`existing` no Bicep) em vez de criar o próprio: synth emite só APIs/operations/policies como filhos; destroy remove só as APIs do projeto. Elimina o piso de ~30-45min de criação por projeto. Útil em produção (um APIM para vários serviços) e na bateria (ciclos Azure próximos dos AWS). Trade-off na bateria: relaxa o isolamento total e a verificação de conta limpa — decidir política antes de adotar nos ciclos.

- Deploy Azure sem Docker local (blob+SAS) — adiado, ver plano-p4
- Handlers multi-cloud nível 2 (facade `@iacmp/runtime`) — a jogada estratégica, ver plano-p4
- Migração GCP/Azure para o grafo (P4) + GCP via Terraform — ver plano-p4
- Prompt: tabela de atributos de `ref()` gerada de `CONSTRUCT_ATTRIBUTES` (34 tipos)
- Deprecar refs string (só após bateria completa com refs tipadas)
- Release 1.2.2 (npm 1.2.1 não tem os fixes de hoje) — publicar da main pós-merge
- PR da branch `feat/bateria-prompts-deploy-real` → main
- Goldens multi-stack fora do cfn-lint (um arquivo por stack)

## Processo por ciclo (o padrão validado)

Projeto novo por cloud (`pNN aws`/`pNN az`) → `iacmp ai` (geração por provider) → synth → deploy → teste funcional com evidências (status codes) → destroy + verificação de conta limpa. Bug de ferramenta: corrigir na ferramenta → `npm run sync` → REGERAR em projeto novo. Nunca editar gerados.
