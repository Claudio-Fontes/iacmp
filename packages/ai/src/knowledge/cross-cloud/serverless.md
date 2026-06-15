# Serverless & FaaS — AWS Lambda, Azure Functions, GCP Cloud Functions

### Modelo de execução: cold start, warm instance, concorrência, burst limit, timeout máximo

**Cold start** ocorre quando não há instância aquecida disponível: o runtime é inicializado, o código carregado e o handler executado. Duração varia de ~100ms (Node.js/Python sem VPC) a ~1-3s (Java/C# com VPC habilitada).

**Warm instance** reutiliza o container de uma execução anterior. O handler é chamado diretamente sem inicialização. O código fora do handler (inicialização de SDK, conexões de banco) persiste entre invocações.

| Parâmetro | AWS Lambda | Azure Functions | GCP Cloud Functions (gen2) |
|---|---|---|---|
| Timeout máximo | 15 minutos | 230s (Consumption) / ilimitado (Premium/Dedicated) | 60 minutos |
| Concorrência padrão | 1.000 por região (soft limit) | Controlado por plano | 1.000 por região |
| Burst limit | 3.000 (us-east-1, us-west-2, eu-west-1) / 500 outras regiões | Depende do plano de hospedagem | Sem burst limit explícito |
| Scale-to-zero | Nativo | Nativo (Consumption) | Nativo |
| Warm instance mantida | Indefinido (SLA não garantido) | Indefinido | Indefinido |

**AWS Lambda Provisioned Concurrency**: elimina cold start pré-aquecendo N instâncias. Cobrança separada por GB-segundo provisionado, mesmo sem invocações.

**Azure Premium Plan**: instâncias sempre aquecidas (pre-warmed), elimina cold start. Custo fixo por instância ativa.

**GCP Minimum instances**: equivalente ao Provisioned Concurrency, mantém N instâncias aquecidas. Configurado por `minInstances` na revision do Cloud Run (gen2 roda sobre Cloud Run).

### Runtimes suportados por cloud

**AWS Lambda (2025)**

| Runtime | Versões suportadas |
|---|---|
| Node.js | 18.x, 20.x, 22.x |
| Python | 3.10, 3.11, 3.12, 3.13 |
| Java | 11, 17, 21 |
| Go | 1.x (provided.al2023) |
| .NET | 6, 8 |
| Ruby | 3.2, 3.3 |
| Custom Runtime | provided.al2, provided.al2023 (Amazon Linux 2023) |

**Azure Functions (v4 runtime)**

| Runtime | Versões |
|---|---|
| Node.js | 18.x, 20.x |
| Python | 3.9, 3.10, 3.11 |
| Java | 8, 11, 17, 21 |
| Go | via Custom Handler |
| .NET | 6 (in-process), 7/8 (isolated worker) |
| PowerShell | 7.2, 7.4 |

**GCP Cloud Functions gen2 (via Cloud Run)**

| Runtime | Versões |
|---|---|
| Node.js | 18, 20, 22 |
| Python | 3.10, 3.11, 3.12 |
| Java | 11, 17, 21 |
| Go | 1.21, 1.22 |
| .NET | 6, 8 |
| Ruby | 3.2 |

### Triggers: HTTP, fila, evento, timer, stream

**HTTP / API**
- Lambda: URL direta (Function URLs) ou via API Gateway (REST/HTTP/WebSocket)
- Azure Functions: HttpTrigger nativo, integração com API Management
- GCP: HTTP trigger nativo (endpoint público automático na gen2)

**Fila / Mensagem**
- Lambda: SQS trigger (batch de até 10.000 msgs com batch window), SNS subscription
- Azure Functions: Service Bus Queue/Topic trigger, Storage Queue trigger
- GCP: Pub/Sub trigger (push subscription direto para a função)

**Evento / Notificação**
- Lambda: EventBridge rule, S3 event notification, DynamoDB Streams, Kinesis
- Azure Functions: Event Grid trigger, Event Hub trigger, Cosmos DB change feed
- GCP: Eventarc (CloudEvents), Cloud Storage notification, Firestore events

**Timer / Cron**
- Lambda: EventBridge Scheduled Rule (cron/rate expression)
- Azure Functions: TimerTrigger (NCRONTAB: `0 */5 * * * *`)
- GCP: Cloud Scheduler → Pub/Sub → Function ou HTTP trigger direto

**Stream**
- Lambda: Kinesis Data Streams (shard iterator, parallelization factor até 10), DynamoDB Streams
- Azure Functions: Event Hubs trigger (checkpointing via Storage)
- GCP: Pub/Sub pull com ordering keys, Dataflow para streams complexos

### Limites por cloud

| Limite | AWS Lambda | Azure Functions (Consumption) | GCP Cloud Functions gen2 |
|---|---|---|---|
| Payload de entrada (sync) | 6 MB | 100 MB | 32 MB |
| Payload de entrada (async) | 256 KB | — | — |
| Payload de resposta | 6 MB | 100 MB | 32 MB |
| Memória máxima | 10.240 MB | 1.536 MB | 32.768 MB (Cloud Run) |
| Duração máxima | 900s (15 min) | 230s | 3.600s (60 min) |
| Concorrência simultânea | 1.000 (padrão, aumentável) | 200 (padrão HTTP) | 1.000 (padrão) |
| Concorrência por instância | 1 (padrão) / até 10 (SnapStart) | 1 | até 1.000 (Cloud Run) |
| Tamanho do deployment (zip) | 50 MB (zip) / 250 MB descomprimido | 1 GB (ZIP via Kudu) | 500 MB |
| Variáveis de ambiente | 4 KB total | Sem limite documentado | 32 KB total |
| Timeout mínimo configurável | 1s | 1s | 1s |

**GCP Cloud Functions gen2** roda sobre Cloud Run, que permite concorrência de até 1.000 requests simultâneos por instância — diferencial importante para cargas com alta I/O.

### Custo: modelo de cobrança

**AWS Lambda**
- Invocações: $0,20 por 1 milhão de requisições
- Duração: $0,0000166667 por GB-segundo (x86) / $0,0000133334 por GB-segundo (ARM/Graviton2)
- Provisioned Concurrency: $0,015 por GB-hora provisionado
- Free tier: 1 milhão de invocações/mês + 400.000 GB-segundos/mês (permanente)

**Azure Functions (Consumption Plan)**
- Execuções: $0,20 por 1 milhão de execuções
- Duração: $0,000016 por GB-segundo
- Free tier: 1 milhão de execuções/mês + 400.000 GB-segundos/mês

**GCP Cloud Functions gen2**
- Invocações: $0,40 por 1 milhão (após 2 milhões gratuitos/mês)
- CPU: $0,00001800 por vCPU-segundo
- Memória: $0,00000200 por GB-segundo
- Concorrência adicional não tem custo extra — instâncias compartilham a cobrança por CPU/memória

**Comparativo para carga típica (10M invocações/mês, 256MB, 200ms médio)**

| Cloud | Custo estimado/mês |
|---|---|
| AWS Lambda (x86) | ~$10,50 |
| AWS Lambda (ARM) | ~$8,50 |
| Azure Functions | ~$10,50 |
| GCP Cloud Functions gen2 | ~$7,80 (com concorrência alta por instância) |

### Deployment: zip, container, layers, slots, revisions

**AWS Lambda**
- Zip: até 50 MB (direto) ou 250 MB descomprimido via S3
- Container: até 10 GB (ECR), suporte a imagens OCI
- Layers: até 5 layers por função, cada layer até 250 MB descomprimido. Compartilham dependências entre funções
- Aliases + versões: permite blue/green e weighted routing entre versões (`routing-config`)
- Lambda Extensions: rodam no mesmo sandbox, para telemetria e wrappers

**Azure Functions**
- Deployment slots: até 20 slots por app (Plano Standard+). Swap com tráfego produtivo sem downtime
- Zip deploy: `func azure functionapp publish` via Azure CLI
- Container: suporte via Azure Container Apps (modelo diferente) ou Premium plan com Docker
- WEBSITE_RUN_FROM_PACKAGE: função roda direto do ZIP sem extrair para disco

**GCP Cloud Functions gen2 / Cloud Run**
- Revision: cada deploy cria uma nova revision imutável
- Traffic splitting: distribuição percentual entre revisions (ex: 90%/10% para canary)
- Container: deploy de imagem OCI diretamente via `gcloud run deploy --image`
- Buildpacks: detecção automática do runtime via `gcloud functions deploy` sem Dockerfile

### VPC/Networking

**AWS Lambda VPC Mode**
- ENI criada na subnet especificada. Cold start adicional histórico de +1-2s foi eliminado com o modelo de ENI compartilhado (Hyperplane, 2019+)
- Requer subnet com NAT Gateway para acesso à internet (Lambda em VPC não tem saída pública)
- Security groups aplicados à ENI da Lambda
- Lambda@Edge e CloudFront Functions: sem suporte a VPC — rodam nos PoPs globais

**Azure Functions VNet Integration**
- Inbound: Private Endpoint para acesso privado ao Function App
- Outbound: VNet Integration (Regional) — roteia tráfego de saída para VNet. Requer subnet dedicada (mínimo /28)
- Premium Plan: suporte completo. Consumption Plan: VNet Integration disponível mas com limitações

**GCP Cloud Run VPC Connector**
- VPC Access Connector: recurso regional que permite Cloud Run acessar recursos em VPC privada
- Direct VPC egress (GA 2024): sem necessidade de conector intermediário, traffic roteia diretamente para VPC
- Serverless VPC Access: compartilhado entre Cloud Functions, Cloud Run, App Engine

### Observabilidade

**AWS Lambda + CloudWatch**
- Logs automáticos para CloudWatch Log Groups (`/aws/lambda/<function-name>`)
- Métricas nativas: `Duration`, `Invocations`, `Errors`, `Throttles`, `ConcurrentExecutions`, `IteratorAge` (streams)
- X-Ray: tracing distribuído. `TracingConfig: Active` habilita sampling automático. Adiciona ~1ms de overhead
- Lambda Insights: extensão para métricas de sistema (CPU, memória real usada, inicializações)
- Structured logging: recomendado JSON para facilitar CloudWatch Insights queries

**Azure Functions + Application Insights**
- SDK embutido via `APPINSIGHTS_INSTRUMENTATIONKEY` ou `APPLICATIONINSIGHTS_CONNECTION_STRING`
- Correlação automática de traces via `operation_Id` entre Functions, Service Bus, HTTP
- Live Metrics Stream: visibilidade em tempo real de invocações e erros
- Availability tests: ping de URL configurável para alertas de SLA

**GCP Cloud Functions + Cloud Logging**
- Logs automáticos para Cloud Logging. Structured logs (JSON no stdout) mapeiam campos para `jsonPayload`
- Cloud Trace: trace distribuído com sampling. `google-cloud-trace` SDK para instrumentação manual
- Cloud Monitoring: métricas de `cloudfunctions.googleapis.com/function/execution_count`, `execution_times`, `user_memory_bytes`
- Error Reporting: agrupamento automático de exceções não tratadas

**Correlação cross-cloud**: W3C TraceContext (`traceparent` header) é o padrão para propagação de trace ID entre clouds. OpenTelemetry Collector como sidecar/gateway unifica traces em Jaeger, Grafana Tempo ou Honeycomb.

### Padrões de uso

**Fan-out (SNS → SQS → Lambda)**
Publicação em SNS topic com N SQS queues como subscribers. Cada queue alimenta uma Lambda independente. Desacopla o produtor dos consumidores e garante retry independente por consumidor. Equivalente no Azure: Event Grid → Service Bus. GCP: Pub/Sub com múltiplas subscriptions.

**Orchestration vs Choreography**
- Orchestration: Step Functions (AWS), Durable Functions (Azure), Workflows (GCP). Estado centralizado, visibilidade do fluxo completo, mais simples para depurar erros.
- Choreography: eventos assíncronos entre funções via fila/tópico. Mais resiliente, sem ponto central de falha. Complexidade de rastrear o fluxo aumenta.

**Saga Pattern com Lambda + SQS**
Cada step da saga é uma Lambda. Sucesso publica evento na fila do próximo step. Falha dispara compensating transaction publicando em DLQ ou fila de rollback. Step Functions Express Workflows simplificam a implementação com retry e compensação built-in.

**Event Sourcing + Lambda**
DynamoDB Streams → Lambda para projeção de eventos. Lambda consome o stream de mudanças e atualiza read models em ElastiCache ou OpenSearch. Retry automático do stream garante at-least-once.

### Anti-padrões

**Long-running tasks (>15min)**: Lambda tem timeout máximo de 15 minutos. Para tarefas longas use ECS Fargate (AWS), Container Instances (Azure), ou Cloud Run Jobs (GCP). Step Functions pode orquestrar múltiplas Lambdas para simular tarefas longas mas aumenta complexidade.

**Código stateful entre invocações**: variáveis globais persistem dentro da mesma instância aquecida mas não são garantidas entre invocações. Nunca dependa de estado em memória para lógica de negócio — use ElastiCache, DynamoDB ou S3.

**Lambda para workloads compute-heavy**: 10 GB de memória = 6 vCPUs (proporcional). Para ML inference, encoding de vídeo ou processamento numérico intenso, use instâncias EC2/GPU ou ECS com instâncias otimizadas. Custo por GB-segundo de Lambda é alto para workloads longos.

**Conexões de banco não reutilizadas**: abrir conexão dentro do handler cria nova conexão a cada invocação fria. Inicialize o pool fora do handler. Para RDS, use RDS Proxy para pooling de conexões gerenciado — crítico com alta concorrência.

**Dependências pesadas no pacote**: aumenta cold start. Use Lambda Layers para dependências compartilhadas. Node.js: prefira `aws-sdk` v3 (modular) ao v2 monolítico. Python: use `--include-lib-dirs` para excluir boto3 (pré-instalado no runtime).
