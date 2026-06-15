# Constructs GCP — Referência de Serviços

## Compute

### Cloud Functions (Gen 2)
- Baseado em Cloud Run internamente — mais poderoso que Gen 1
- Triggeres: HTTP, Pub/Sub, Cloud Storage, Firestore, Eventarc (todos os eventos GCP)
- Runtimes: Node.js, Python, Go, Java, Ruby, PHP, .NET
- Concorrência: Gen 2 suporta até 1.000 requests simultâneos por instância (vs 1 no Gen 1)
- Timeout: até 60 minutos (Gen 2), 9 minutos (Gen 1)
- Memória: 128 MB a 32 GB (Gen 2)
- Cold start: reduzido no Gen 2 com min instances configurável

### Cloud Run
- Containers serverless: deploy de qualquer container Docker
- Escala: 0 a N instâncias, incluindo 0 quando sem tráfego
- Concorrência: até 1.000 requests por instância (configurável)
- Timeout: até 60 minutos por request
- VPC: conecta a VPC via Serverless VPC Access Connector
- Jobs: tarefas batch que não precisam de HTTP trigger (Cloud Run Jobs)
- Revision-based: cada deploy cria uma revisão, com traffic splitting (canary, blue/green)

### GKE (Google Kubernetes Engine)
- Standard: você gerencia os nodes, controle total
- Autopilot: GKE gerencia nodes — paga por pod, não por node
- Control plane: gratuito (Standard) / incluído (Autopilot)
- Workload Identity: associa Service Account K8s a Service Account GCP — sem keys
- Node pools: múltiplos pools (CPU, GPU, TPU, Spot)
- Release channels: Rapid, Regular, Stable para updates automáticos do cluster

### Compute Engine
- Machine types: E2 (economy), N2/N2D (general purpose), C3 (compute optimized), M3 (memory optimized), A2/G2 (GPU)
- Custom machine types: vCPU e memória configuráveis independentemente
- Preemptible VMs: até 91% de desconto, interrompidas com 30s de aviso, máximo 24h
- Spot VMs: mesma premissa que Preemptible, sem limite de 24h
- Live Migration: VMs migradas entre hosts transparentemente durante manutenção
- Committed Use Discounts (CUD): 1 ou 3 anos, 37–55% de desconto
- Sole-tenant nodes: hardware dedicado (compliance, licenças por socket)

---

## Storage

### Cloud Storage
- Storage classes: Standard (acesso frequente), Nearline (acesso mensal, mínimo 30 dias), Coldline (acesso trimestral, 90 dias), Archive (anual, 365 dias)
- Objetos: até 5 TB por objeto
- Lifecycle: transição automática entre classes, deleção após N dias
- Versioning: histórico automático de versões de objetos
- Object holds: prevent deletion para compliance
- Signed URLs: acesso temporário sem autenticação
- Transfer Service: migração de S3, Azure Blob, HTTP sources para Cloud Storage
- Redundância: Regional (1 região), Dual-region (2 regiões específicas), Multi-region (ampla área geográfica)

### Persistent Disk
- Standard (HDD): econômico, acesso sequencial
- Balanced (SSD): custo-benefício, maioria dos workloads
- SSD (pd-ssd): alta IOPS, databases
- Extreme: até 120.000 IOPS por disco, databases críticos
- Hyperdisk: nova geração — performance configurável independente do tamanho
- Multi-writer: disco compartilhado entre até 8 VMs (equivale ao EBS multi-attach)
- Snapshots: incrementais, globais (acessíveis de qualquer região)

### Filestore
- NFS gerenciado: Basic (HDD/SSD), Enterprise (HA, backup), High Scale (análise)
- Montável em Compute Engine, GKE, Cloud Run (via VPC)
- Capacity: 1 TB a 100 TB por instância
- Enterprise tier: Multi-zone HA, backups automáticos

---

## Banco de Dados

### Cloud SQL
- MySQL, PostgreSQL e SQL Server gerenciados
- HA: standby em outra zona com failover automático (60–120 segundos)
- Read replicas: cross-region possível
- Storage: auto-increase, HDD ou SSD
- Backups: automáticos (7 dias padrão, até 365), point-in-time recovery
- Proxy: Cloud SQL Auth Proxy — conexão segura sem IP público nem SSL manual
- Serverless: não existe — para serverless use AlloyDB Omni ou Spanner

### AlloyDB
- PostgreSQL 100% compatível, 4x mais rápido que Cloud SQL PostgreSQL em OLTP
- Separação compute/storage: storage distribuído como Aurora
- HA: failover em <60 segundos (mais rápido que Cloud SQL)
- Columnar Engine: aceleração de queries analíticas sem indexação adicional
- AlloyDB Omni: roda on-premises ou em outros clouds

### Cloud Spanner
- RDBMS globalmente distribuído com ACID e SQL
- Sem equivalente na AWS ou Azure
- Escala horizontal sem downtime (adicionar nodes adiciona capacidade)
- External consistency: consistência mais forte que strong consistency
- Interleaved tables: co-localiza tabelas pai/filho (melhora performance de joins)
- Commit timestamps: every row tem timestamp de escrita
- Custo: mais caro — justificado para sistemas que precisam SQL + escala global + consistência forte

### Firestore
- NoSQL de documentos: coleções → documentos → subcoleções
- Modo Native: apps mobile/web, offline sync, real-time listeners
- Modo Datastore: APIs do Datastore legado (compatibility)
- Queries: compostas, range, array-contains — sem JOINs
- Transactions: ACID em até 500 documentos por transação
- Segurança: Security Rules por documento/coleção (apps mobile)

### Bigtable
- NoSQL wide-column: alta throughput para analytics, IoT, series temporais
- Compatível com HBase API
- Acesso por row key apenas — sem queries secundárias
- Auto-scaling: nodes adicionados/removidos automaticamente
- Casos de uso: dados de séries temporais, dados de monitoramento, dados de AdTech
- Replicação: multi-cluster, mesmo data center ou cross-region

### Memorystore
- Redis: 1–300 GB, Standard tier com HA (réplica síncrona em outra zona)
- Redis Cluster: sharding automático para datasets maiores
- Memcached: até 5 TB distribuído em múltiplos nodes
- Private Service Connect: acesso via IP privado na sua VPC

### BigQuery
- Data warehouse serverless: sem clusters para gerenciar
- Modelo de preço: on-demand (por TB processado, $5/TB), ou capacity slots (flat rate)
- Storage: separado do compute — armazenamento barato, compute sob demanda
- BI Engine: aceleração in-memory para Looker Studio e ferramentas BI
- ML: BigQuery ML — treinamento de modelos com SQL
- Streaming insert: ingestão em tempo real (pequena latência para queries)
- External tables: query em dados no Cloud Storage, Bigtable, Drive sem importar
- Partitioning: por data, por coluna inteira, ou por ingestion time
- Clustering: organização física por colunas (melhora performance e reduz custo)

---

## Rede

### VPC (Virtual Private Cloud)
- Global: uma VPC abrange todas as regiões (diferente de AWS/Azure que é regional)
- Subnets: regionais, criadas explicitamente por região com CIDR específico
- Firewall rules: aplicadas por tag de rede ou Service Account (não por subnet como NSG)
- Routes: customizáveis por rede, usam next-hop (instance, IP, VPN tunnel, etc.)
- Shared VPC: uma VPC host, múltiplos projetos satélite — centraliza rede
- VPC Peering: entre VPCs, não transitivo — use rede hub ou Shared VPC

### Cloud Load Balancing
- Global: HTTP(S) Load Balancing — anycast, distribui globalmente
- Regional: TCP/UDP/SSL Proxy e interno
- HTTP(S) LB: Layer 7, SSL offload, URL maps, backend services
- Cloud Armor: WAF integrado ao HTTP(S) LB — regras OWASP, DDoS, geo-blocking
- NEG (Network Endpoint Groups): endpoints podem ser Cloud Run, Cloud Functions, GKE Pods

### Cloud CDN
- Integrado ao HTTP(S) Load Balancing
- Cache Modes: CACHE_ALL_STATIC, USE_ORIGIN_HEADERS, FORCE_CACHE_ALL
- Cache invalidation: por URL ou prefixo
- Signed URLs/Cookies: acesso restrito a conteúdo

### Cloud DNS
- DNS gerenciado: zonas públicas e privadas
- DNSSEC: assinatura de zonas para autenticidade
- Política de resposta: intercepta queries e retorna resposta customizada
- Peering de zona: compartilha zona DNS entre VPCs

---

## Segurança e Identidade

### Cloud IAM
- Hierarquia: Organization → Folder → Project → Resource
- Herança: permissões se propagam para baixo na hierarquia (não podem ser negadas abaixo)
- Tipos de roles: Primitive (Owner/Editor/Viewer — evite), Predefined (granular), Custom
- Membros: Google Account, Service Account, Google Group, Cloud Identity, allUsers, allAuthenticatedUsers
- Conditions: restringe acesso por data, IP, atributo de recurso

### Service Accounts
- Identidade de aplicação/VM/container dentro do GCP
- Email: nome@projeto.iam.gserviceaccount.com
- Keys: JSON key files (evite) vs Workload Identity (recomendado para GKE/Cloud Run)
- Impersonation: assume SA temporariamente para operações — sem criar keys
- Workload Identity Federation: acesso sem keys de SA para workloads externos (GitHub Actions, AWS, Azure)

### Secret Manager
- Versioning automático de secrets
- Rotação: notifica via Pub/Sub para rotação custom
- Acesso auditado: Cloud Audit Logs registra cada acesso
- Regional: secret criado em região específica ou multi-região
- Integração: Cloud Run, Cloud Functions, GKE via Workload Identity

### VPC Service Controls
- Perímetro de segurança em torno de APIs GCP
- Bloqueia exfiltração de dados entre projetos ou para internet
- Útil para compliance: impede que dados do BigQuery sejam copiados para projetos não autorizados

---

## Observabilidade

### Cloud Monitoring
- Métricas: coletadas automaticamente de todos os serviços GCP
- Custom metrics: via API ou OpenTelemetry
- Dashboards: até 100 gráficos por dashboard
- Alerting: por threshold, baseline, forecast; notificação via email, SMS, PagerDuty, Slack
- Uptime checks: HTTP, HTTPS, TCP de múltiplas regiões

### Cloud Logging
- Logs de todos os serviços GCP coletados automaticamente
- Log Router: roteia logs para Cloud Storage, BigQuery, Pub/Sub, Splunk
- Filtros avançados: linguagem de filtro própria (similar ao grep com operadores lógicos)
- Retenção: 30 dias padrão, configurável por bucket de log (1 dia a 10 anos)
- Log-based metrics: cria métricas de Cloud Monitoring a partir de logs

### Cloud Trace
- Distributed tracing: latência de requests distribuídos
- Integração: App Engine, Cloud Run, GKE automático; outros via SDK
- Latency reports: P50, P95, P99 por endpoint

### Cloud Profiler
- Profiling contínuo em produção: CPU, heap, threads
- Overhead mínimo: <1% de impacto em produção
- Suporte: Go, Java, Node.js, Python

---

## Messaging e Integração

### Pub/Sub
- Alta throughput: bilhões de mensagens por dia
- At-least-once delivery: sem garantia de ordem (use Pub/Sub Lite ou Dataflow para ordering)
- Retenção: até 7 dias (padrão 10 minutos, configurável)
- Dead-letter: subscription com dead letter topic após maxDeliveryAttempts
- Ordering keys: garante ordem por chave, requer subscription com ordering habilitada
- Filtros: subscription pode filtrar por atributos sem código no consumer
- Push subscriptions: entrega via HTTP para endpoint (Cloud Run, Cloud Functions, etc.)
- Snapshots: captura estado de backlog para replay

### Cloud Tasks
- Gerenciamento de filas HTTP: enfileira chamadas HTTP com retry, rate limiting
- Deduplicação: task ID para evitar duplicatas
- Scheduling: execute em horário específico
- Rate limits: max dispatches/segundo por fila
- Casos de uso: background jobs, distribuição de carga, processamento assíncrono

### Eventarc
- Roteamento de eventos de serviços GCP para Cloud Run e Cloud Functions Gen 2
- CloudEvents 1.0: formato padronizado
- Fontes: Cloud Storage, BigQuery, Cloud SQL, Pub/Sub, Audit Logs, etc.
- Filtros: por tipo de evento e atributos

### Cloud Workflows
- Orquestração de workflows serverless
- Sintaxe YAML (ou JSON)
- Steps: HTTP calls, variáveis, condicionais, loops, paralelismo, try/catch
- Connectors: chamadas diretas a APIs GCP sem código boilerplate
- Callback: pausa workflow e aguarda evento externo
- Casos de uso: orquestração de APIs, processamento multi-step, ETL pipelines
