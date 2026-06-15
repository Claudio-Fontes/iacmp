# GCP Unique Services

Serviços que são exclusivos do GCP ou onde o GCP tem diferencial significativo em relação a AWS e Azure.

---

## Cloud Spanner

Banco de dados relacional distribuído globalmente com consistência forte (ACID) e escala horizontal — algo sem equivalente real em outras clouds.

### Diferenciais únicos
- **NewSQL**: SQL completo + escala horizontal automática (impossível em MySQL/Postgres tradicionais)
- **Consistência externa**: consistência forte garantida globalmente, sem divergência entre réplicas (usa TrueTime — relógios atômicos + GPS nos datacenters da Google)
- **Multi-region com escala de leitura**: réplicas em múltiplas regiões com leituras locais e escritas globalmente consistentes

### Casos de uso
- Sistemas financeiros que precisam de consistência forte e escala global (ex: banco, gaming de alta frequência)
- Substituição de Oracle/MySQL para sistemas que cresceram além da capacidade de um único server
- Sistemas de inventário global

### Limites e preços (aproximados)
- Nós: 1 node = ~2000 QPS de leitura, ~1800 QPS de escrita
- Armazenamento: $0.30/GB-mês (regional), $0.65/GB-mês (multi-region)
- Nó regional: ~$0.90/h (~$648/mês)
- Free trial: 90 dias com 1 instância de processamento

### Quando NÃO usar
- Custo por nó é alto — para workloads pequenas, Cloud SQL é muito mais econômico
- Não suporta stored procedures complexas como Oracle

---

## BigQuery

Data warehouse serverless para análise de petabytes — pay-per-query ou flat-rate.

### Arquitetura interna
- Separação de storage e compute (precursora do modelo moderno popularizado pelo Snowflake)
- Storage: Colossus (sistema de arquivos distribuído do Google) em formato Capacitor (colunar)
- Compute: Dremel — executa queries em paralelo massivo, sem tuning de índices

### Modelos de precificação
**On-demand (pay-per-query)**
- $6.25/TB de dados processados (após 1TB gratuito/mês)
- Bom para: queries ad-hoc, análises ocasionais

**Capacity-based (slots)**
- Standard: $0.04/slot-hora (mínimo 100 slots)
- Enterprise: reservas de 1 ano com desconto; até 500 slots inclusos no plano
- Enterprise Plus: até 2000 slots, máximo de eficiência para workloads intensas
- Bom para: workloads previsíveis, controle de custo

### Recursos diferenciais
- **BigQuery ML**: treina modelos ML com SQL diretamente no BQ (regressão, classificação, clustering, Time Series, boosted trees, neural networks, importação de modelos TF/PyTorch)
- **BigQuery Omni**: queries em dados no S3 (AWS) ou Azure Blob Storage — sem mover dados
- **BigQuery Streaming**: inserção em tempo real via API (vs batch via Cloud Storage)
- **INFORMATION_SCHEMA**: metadados de jobs, tabelas, partições para auditoria e otimização
- **Row-level security**: filtros aplicados automaticamente por identidade do usuário
- **Column-level security**: mascaramento de colunas sensíveis por IAM
- **Authorized views**: compartilha resultados de query sem expor dados brutos

### Otimização de custo
- Particionamento por data/coluna: queries que filtram pela partição processam menos TB
- Clustering: ordena dados dentro de partições por colunas de filtro frequente
- Materialized views: pré-computa queries frequentes
- Slot reservations: para workloads ≥ 150-200 TB/mês, capacity é mais barato

---

## Dataflow

Serviço gerenciado de Apache Beam para processamento de dados em streaming e batch.

### Paradigma Apache Beam
- Modelo unificado: mesmo código processa batch e streaming
- Runners: Dataflow (GCP), Spark, Flink, Direct (local)
- Primitivas: PCollection, PTransform, Pipeline

### Casos de uso
- ETL em tempo real: Pub/Sub → Dataflow → BigQuery (padrão canônico)
- Enriquecimento de dados em streaming
- Agregação com janelas (tumbling, sliding, session windows)
- Reprocessamento histórico de eventos

### Vantagens sobre Spark
- Totalmente serverless — sem cluster para gerenciar
- Autoscaling de workers em segundos (Streaming Engine)
- Drain: para jobs graciosamente sem perder mensagens em flight
- Shuffle service: offload do shuffle para infraestrutura gerenciada (elimina bottleneck de memória em joins massivos)

### Preço
- $0.056/vCPU-h + $0.003/GB-h de memória + $0.054/PD-GB-mês de storage
- Dataflow Prime: preço por unidade de streaming data processada (sem gerenciar workers)

---

## Pub/Sub

Mensageria distribuída de alta throughput — equivalente ao Kinesis (streaming) + SNS (fan-out) no AWS.

### Características
- **Pull**: subscriber faz polling ao Pub/Sub
- **Push**: Pub/Sub entrega para endpoint HTTPS do subscriber
- **BigQuery subscription**: entrega direto em tabela BQ sem código intermediário
- **Cloud Storage subscription**: entrega mensagens em arquivos no GCS
- **Ordered delivery**: opção de entrega ordenada por chave de ordenação
- **Schema**: validação de mensagens com Avro ou Protocol Buffers

### Throughput
- Escala automaticamente para milhões de msgs/s sem configuração
- Sem provisionamento de shards ou partições (diferente do Kinesis)
- Retenção: 7 dias por padrão (configurável até 31 dias)

### Pub/Sub Lite
- Versão zonalmente limitada com throughput provisionado
- Preço ~4x menor que Pub/Sub padrão
- Trade-off: menos durabilidade, sem entrega cross-zone automática

### Preço Pub/Sub
- $0.04/GB de dados (após 10GB gratuitos/mês)
- Snapshot storage: $0.04/GB-mês

---

## Anthos

Plataforma de gerenciamento de aplicações híbrida e multi-cloud baseada em Kubernetes.

### Componentes
- **GKE Enterprise (antigo Anthos GKE)**: GKE + ferramentas enterprise (Policy Controller, Config Sync, Identity Service)
- **Anthos Clusters on-prem (VMware/Bare Metal)**: GKE rodando em hardware on-premises, gerenciado via GCP
- **Attached Clusters**: EKS (AWS) ou AKS (Azure) registrados no Anthos para gerenciamento unificado
- **Anthos Service Mesh**: Istio gerenciado pela Google
- **Anthos Config Management (ACM)**: GitOps com Policy Controller (OPA Gatekeeper)
- **Anthos Identity Service**: SSO unificado para múltiplos clusters

### Casos de uso
- Empresa com datacenters existentes que quer modernizar sem migração total para cloud
- Requisitos regulatórios de data residency que impedem cloud puro
- Multi-cloud com governança centralizada

### Custo
GKE Enterprise: ~$7 por vCPU/mês para clusters registrados (além do custo dos nós GKE)

---

## Cloud Run

Plataforma serverless para containers — "Fargate serverless" ou "Lambda para containers".

### Características
- Deploy de qualquer container Docker sem gerenciar infraestrutura
- Escala de 0 a N instâncias em segundos
- Concurrência configurável: 1 a 1000 requests simultâneos por instância (diferencial vs Lambda — pode processar múltiplos requests por container)
- Cold start: tipicamente 1-3s para containers comuns
- Billing: por CPU/memória durante o tempo de processamento de requests (pausa quando idle)

### Cloud Run vs Cloud Run Jobs
- **Cloud Run Services**: para workloads HTTP/gRPC com scaling baseado em requests
- **Cloud Run Jobs**: para execuções batch/tasks que terminam — sem HTTP endpoint

### Integrações
- Cloud SQL (via Cloud SQL Auth Proxy como sidecar)
- Secret Manager (via env vars ou volume mounts)
- Pub/Sub Push subscription: Pub/Sub entrega mensagens via HTTP para o Cloud Run service
- Eventarc: trigger de eventos de serviços GCP, Pub/Sub, ou eventos customizados

### Domínios e networking
- HTTPS automático com certificado gerenciado
- Custom domains: mapeamento de domínio próprio
- VPC Connector (Direct VPC Egress): Cloud Run em VPC privada
- Ingress controls: all (público), internal (apenas VPC), internal-and-cloud-load-balancing

### Preço
- CPU: $0.00002400/vCPU-second (fora de request = $0 por padrão)
- Memory: $0.00000250/GiB-second
- Requests: $0.40/million
- Gratuito: 180.000 vCPU-seconds, 360.000 GiB-seconds, 2M requests/mês

---

## Apigee

API Management platform — o mais completo e maduro do mercado, adquirido pela Google em 2016.

### Componentes
- **API Proxies**: encapsula backends, adiciona políticas sem alterar o backend
- **Developer Portal**: documentação self-service para desenvolvedores de API
- **API Products**: agrupa proxies em produtos com planos de acesso e rate limits
- **Monetization**: cobrar por API calls, com planos e relatórios de billing
- **Analytics**: dashboards de tráfego, latência, erros por proxy, product, app

### Políticas disponíveis
- Security: OAuth 2.0, API Keys, JWT, SAML, mTLS, HMAC
- Traffic management: Spike Arrest, Quota, Response Cache, Concurrent Rate Limit
- Mediation: XML/JSON transformation, Extract Variables, Assign Message, Service Callout
- Extension: JavaScript, Python, Java callout, Integration (Apigee Integration)

### Tiers
- **Evaluation**: gratuito, limitado
- **Pay-as-you-go**: ~$0.13 por 1000 API calls
- **Subscription**: Enterprise pricing baseado em volume contratado

### Apigee vs Azure APIM vs AWS API Gateway
- Apigee: mais madura, mais políticas out-of-the-box, developer portal incluído, monetization nativa
- Azure APIM: bem integrada ao Azure, bom developer portal
- AWS API Gateway: mais simples, integrada com Lambda, menos recursos de API management

---

## Looker

Plataforma de BI e analytics — adquirida pela Google em 2019.

### LookML
Linguagem de modelagem de dados proprietária do Looker. Define dimensões, métricas e relacionamentos em YAML/SQL. Permite que analistas de negócio façam queries sem SQL.

### Modalidades
- **Looker (core)**: plataforma completa de BI — dashboards, exploração de dados, scheduled reports
- **Looker Studio (antigo Data Studio)**: gratuito, mais simples, integra com Google Sheets, GA4, BigQuery
- **Looker Studio Pro**: features enterprise (row-level security, SLA, suporte)

### Embedded Analytics
Looker permite embedding de dashboards em aplicações via API e iframe signed URLs — comum em SaaS products que querem analytics para seus clientes.

### Integração GCP
- Conexão nativa com BigQuery (sem ODBC)
- PDTs (Persistent Derived Tables): materializa queries LookML no BigQuery automaticamente
- BigQuery BI Engine: accelerator para queries Looker (resulta em latência <1s para dashboards)
