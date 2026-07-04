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

## Itens de ferramenta já registrados (fora da matriz)

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
