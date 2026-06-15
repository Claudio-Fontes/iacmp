# Constructs Azure — Referência de Serviços

## Compute

### Azure Functions
- Planos: Consumption (serverless, paga por execução), Premium (warm instances, VNet), Dedicated (App Service Plan)
- Timeout: Consumption = 5 min (padrão), 10 min (máximo configurável); Premium/Dedicated = sem limite
- Triggers: HTTP, Timer, Service Bus, Event Grid, Blob, Queue, Cosmos DB, SignalR
- Runtimes: Node.js, Python, C#, Java, PowerShell, Go (custom handler)
- Cold start: Consumption tem cold start (100ms–2s); Premium mantém instâncias aquecidas
- Durable Functions: extensão para workflows stateful — Activity, Orchestration, Entity functions

### Azure Container Instances (ACI)
- Containers sem gerenciar VMs ou orquestrador
- Start em segundos, sem overhead de Kubernetes
- Ideal para: jobs batch, tarefas pontuais, dev/test, burst de compute
- Limitação: sem autoscaling nativo, sem service discovery — use AKS para orquestração

### AKS (Azure Kubernetes Service)
- Kubernetes gerenciado: control plane gratuito, você paga os nodes
- Integração nativa: Azure AD (autenticação), ACR (registry), Azure Monitor, Key Vault
- Node pools: múltiplos pools com tipos diferentes (CPU, GPU, Spot)
- Autoscaler: Cluster Autoscaler (nodes) + Horizontal Pod Autoscaler (pods)
- Workload Identity: substituiu Pod Identity — associa Service Account K8s a Managed Identity Azure

### Azure App Service
- PaaS para apps web: Node.js, Python, .NET, Java, PHP, Ruby
- Planos: Free (F1), Shared (D1), Basic, Standard, Premium, Isolated
- Deployment slots: staging → production com swap sem downtime
- Auto-scaling: regras por CPU, memória, requests/segundo
- Integração: Key Vault references em variáveis de ambiente

---

## Storage

### Azure Blob Storage
- Tipos de blob: Block (arquivos gerais), Append (logs), Page (discos VHD)
- Tiers de acesso: Hot (acesso frequente), Cool (30d mínimo), Cold (90d), Archive (180d, retrieval em horas)
- Lifecycle Management: mover automaticamente entre tiers por data ou último acesso
- Redundância: LRS (1 região, 3 cópias), ZRS (3 zonas), GRS (2 regiões), GZRS (zonas + geo)
- Soft delete: recuperação de blobs deletados (1–365 dias)
- Versioning: histórico automático de versões

### Azure Files
- File shares SMB 3.0 e NFS 4.1
- Montável em Windows, Linux, macOS e containers
- Tiers: Transaction Optimized, Hot, Cool, Premium (SSD)
- Azure File Sync: sincroniza file shares Azure com Windows Servers on-premises
- Integração com AKS via CSI driver

### Azure Managed Disks
- Premium SSD: latência <1ms, até 20.000 IOPS — equivalente ao io2
- Standard SSD: gp3 equivalente — bom custo-benefício para maioria dos workloads
- Standard HDD: archive, backup, acesso infrequente
- Ultra Disk: até 160.000 IOPS, latência sub-milissegundo — databases de alta performance
- Shared Disks: montável em múltiplas VMs (cluster de failover)

---

## Banco de Dados

### Azure SQL Database
- SQL Server gerenciado: managed instance (lift-and-shift) ou single database (cloud-native)
- Serverless: escala compute automaticamente, pausa quando inativo
- Hyperscale: armazenamento até 100 TB, read replicas em segundos
- Business Critical: réplicas Always On, read replica incluída no preço
- DTU vs vCore: DTU é modelo antigo (bundled), vCore é o recomendado (separado CPU/memória)

### Azure Cosmos DB
- Multi-model: Core (SQL), MongoDB, Cassandra, Gremlin (grafos), Table
- Distribuição global: replicação multi-região com failover automático
- Consistency levels: Strong, Bounded Staleness, Session, Consistent Prefix, Eventual
- Request Units (RU): unidade de throughput — 1 RU = 1 leitura de item de 1 KB
- Throughput: provisionado (RU/s fixo) ou autoscale (0–100% do máximo configurado) ou serverless
- Partition key: escolha crítica de design — distribui dados entre partições lógicas
- Partition lógica máxima: 20 GB
- TTL: expiração automática de documentos

### Azure Database for PostgreSQL / MySQL — Flexible Server
- Managed: backups automáticos, patches, HA
- HA: Same-zone ou Zone-redundant (réplica síncrona em outra AZ)
- Read replicas: até 5 assíncronas
- Compute: Burstable (B-series), General Purpose (D-series), Memory Optimized (E-series)
- Connection pooling: pgBouncer integrado (PostgreSQL)
- Maintenance window: configurável por você

### Azure Cache for Redis
- Tiers: Basic (dev, sem SLA), Standard (HA com réplica), Premium (cluster, persistência, VNet)
- Enterprise: Redis Enterprise — módulos (RediSearch, RedisJSON, RedisTimeSeries)
- Geo-replication: Premium e Enterprise — réplica passiva cross-region
- Persistence: RDB snapshots e AOF disponíveis no Premium

---

## Rede

### Azure Virtual Network (VNet)
- Escopo: regional (diferente de GCP que é global)
- Address spaces: múltiplos CIDRs por VNet
- Peering: transitivo não funciona — use Azure Virtual WAN ou NVA para hub-spoke
- Service Endpoints: tráfego para PaaS via backbone Azure, sem internet
- Private Endpoints (Private Link): IP privado na sua VNet para serviços Azure/parceiros

### Azure Load Balancer (Standard)
- Layer 4 (TCP/UDP)
- Internal (ILB) ou Public
- Health probes: TCP, HTTP, HTTPS
- Availability zones: zone-redundant por padrão no Standard tier
- Backend pools: VMs, VMSS, IP addresses

### Azure Application Gateway
- Layer 7 (HTTP/HTTPS)
- WAF integrado: OWASP Core Rule Set, regras customizadas
- Path-based routing: /api/* → backend A, /static/* → backend B
- SSL offload e SSL passthrough
- Autoscaling: v2 escala automaticamente
- Cookie-based session affinity

### Azure Front Door
- CDN global + WAF + load balancing em um serviço
- Anycast: rota para o ponto de presença mais próximo do usuário
- Health probes globais com failover automático entre origins
- Rules Engine: roteamento por headers, query strings, path, country
- WAF: regras gerenciadas + custom, rate limiting, geo-blocking
- Caching por regra, cache invalidation programática

---

## Segurança e Identidade

### Azure Active Directory (AAD / Entra ID)
- Planos: Free, P1, P2 (Conditional Access, PIM, Identity Protection)
- App Registrations: registra aplicações para OAuth 2.0 / OIDC
- Service Principals: identidade de aplicação (equivale ao IAM Role para serviços)
- Managed Identity: System-assigned (life cycle da VM/Function) ou User-assigned (compartilhável)
- Conditional Access: MFA condicional, bloqueio por localização, compliance de device

### Azure Key Vault
- Secrets: strings, connection strings, API keys — versioning automático
- Keys: RSA e EC, soft-delete e purge protection para compliance
- Certificates: geração e renovação automática com DigiCert ou Let's Encrypt
- HSM: Premium tier usa Hardware Security Module
- Access: RBAC (recomendado) ou Access Policies (legado)
- Soft delete: 7–90 dias de recuperação após deleção
- Key rotation: automático com notificação via Event Grid

### Azure RBAC
- Escopo: Management Group → Subscription → Resource Group → Resource
- Built-in roles: Owner, Contributor, Reader + centenas de roles específicas por serviço
- Custom roles: JSON com Actions, NotActions, DataActions, NotDataActions
- Deny assignments: explicitamente negar ações (via Azure Blueprints ou Managed Apps)
- PIM (Privileged Identity Management): acesso just-in-time com aprovação

---

## Observabilidade

### Azure Monitor
- Métricas: coletadas automaticamente de todos os recursos Azure, retenção 93 dias
- Logs: Log Analytics workspace — armazenamento, query com KQL
- Alertas: por métrica (estático ou dinâmico/anomaly detection) ou por query de log
- Action Groups: notificação por email, SMS, webhook, ITSM, Azure Function, Logic App
- Workbooks: dashboards interativos com parâmetros

### Application Insights
- APM completo: requests, dependencies, exceptions, traces, custom events
- Distributed tracing: correlação entre serviços via correlation IDs
- Smart Detection: anomalias de performance e falha automáticas
- Live Metrics: streaming de métricas em tempo real
- Availability Tests: ping tests e multi-step tests de URL globais
- Sampling: adaptive (recomendado), fixed rate, ou ingestion sampling
- Integração: SDK para Node.js, Python, .NET, Java, JavaScript

### Log Analytics (KQL)
- Linguagem: KQL (Kusto Query Language)
- Exemplos básicos:
  - `requests | where resultCode == "500" | summarize count() by bin(timestamp, 1h)`
  - `exceptions | where timestamp > ago(1h) | project timestamp, type, outerMessage`
  - `AzureActivity | where OperationName contains "delete" | project TimeGenerated, Caller, ResourceId`
- Workspaces: centralize logs de múltiplos recursos e subscriptions
- Data Export: continuous export para Storage Account ou Event Hubs

---

## Messaging e Integração

### Azure Service Bus
- Queues: mensagem vai para um único consumer (ponto-a-ponto)
- Topics: mensagem vai para múltiplos subscribers (fan-out com filtros)
- Sessions: garante ordem e processamento exclusivo por session ID
- Dead-letter queue: mensagens que falham após maxDeliveryCount
- Message TTL: configurável por mensagem ou na criação da fila
- Scheduled delivery: envio em horário futuro
- Tamanho: 256 KB (Standard), 100 MB (Premium)
- Tiers: Basic (só queues), Standard (topics, sessions), Premium (VNet, isolamento, 100 MB)

### Azure Event Grid
- Eventos de recursos Azure: criação de Blob, VM iniciada, etc.
- CloudEvents 1.0: padrão aberto suportado nativamente
- Handlers: Azure Functions, Logic Apps, Service Bus, Event Hubs, Webhooks
- Filtros: por tipo de evento, prefixo/sufixo de subject
- Dead-letter: mensagens não entregues após 24h ou 30 tentativas

### Azure Event Hubs
- Streaming de alta throughput: compatível com protocolo Kafka 1.0+
- Partições: 1–32 (Basic/Standard), até 2.000 (Dedicated)
- Retenção: 1–7 dias (Standard), até 90 dias (Premium/Dedicated)
- Capture: persiste eventos diretamente em Blob Storage ou ADLS
- Consumer Groups: múltiplos consumers lendo independentemente
- Schema Registry: versionamento de schemas Avro/JSON
