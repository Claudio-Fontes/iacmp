# GCP Reference Architectures

Padrões arquiteturais de referência no GCP com foco nos diferenciais da plataforma.

---

## Data Platform Architecture

O GCP é a cloud mais forte para workloads de dados e analytics. Esta é a arquitetura de referência para uma plataforma de dados moderna.

### Componentes da plataforma

```
Fontes de dados
  ├── Aplicações (eventos via Pub/Sub)
  ├── Bancos relacionais (Cloud SQL, AlloyDB)
  ├── APIs externas
  └── Uploads em batch (GCS)
          ↓
Ingestão
  ├── Streaming: Pub/Sub → Dataflow → BigQuery
  └── Batch: GCS → Dataflow ou BigQuery Transfer Service → BigQuery
          ↓
Storage / Processamento
  ├── BigQuery (analytics warehouse)
  ├── Cloud Spanner (transacional global)
  ├── Bigtable (time-series, alto throughput)
  └── Firestore (documentos, real-time)
          ↓
Transformação
  ├── dbt (Data Build Tool) rodando em Cloud Run Jobs ou Cloud Composer
  └── Dataflow (transformações em streaming)
          ↓
Consumo
  ├── Looker / Looker Studio (dashboards)
  ├── BigQuery ML (modelos ML)
  ├── Vertex AI (modelos avançados)
  └── APIs custom via Cloud Run
```

### Padrão Medallion no BigQuery
- **Bronze**: dados brutos conforme chegam (particionados por data de ingestão)
- **Silver**: dados limpos e normalizados (dbt models, sem duplicatas)
- **Gold**: agregações e KPIs para consumo de BI

### Data Catalog
- Descoberta automática de assets: BigQuery datasets, Cloud Storage buckets, Bigtable, Pub/Sub topics
- Tags de metadados: classificação de dados (PII, confidencial)
- Linhagem de dados (Data Lineage): rastreia de onde veio cada coluna no BigQuery

---

## ML Pipeline Architecture

Arquitetura end-to-end para treinamento, experimentação e serving de modelos ML.

### Vertex AI como centro

**Vertex AI Workbench**
- Jupyter notebooks gerenciados em VMs com GPUs
- Integração nativa com BigQuery, GCS, Artifact Registry

**Vertex AI Pipelines**
- Orquestração de ML pipelines via Kubeflow Pipelines ou TFX
- Cada step é um container — reprodutível e versionado
- Artefatos rastreados automaticamente no Vertex ML Metadata

**Vertex AI Training**
- Custom Training Jobs: treina em GPUs/TPUs sem gerenciar infraestrutura
- Hyperparameter Tuning: Vizier (Bayesian optimization) para busca de hiperparâmetros
- Distributed Training: suporte nativo a multi-node com MirroredStrategy (TF), DDP (PyTorch)

**Vertex AI Model Registry**
- Versiona modelos com metadados (accuracy, dataset hash, commit SHA)
- Integra com pipelines para registro automático pós-treino

**Vertex AI Endpoints**
- Deploy de modelos para serving online (REST API)
- Traffic splitting: 90% v1 / 10% v2 para canary deployment
- Autoscaling baseado em requests/s
- GPUs disponíveis para serving de modelos grandes

**Vertex AI Batch Prediction**
- Para scoring offline de grandes volumes
- BigQuery nativo: input e output direto em tabelas BQ

### Feature Store
- Armazena e serve features de ML com consistência entre treino e serving
- Evita "training-serving skew"
- Online serving: <10ms p99 via Bigtable
- Offline serving: BigQuery para treino

### Pipeline típico de MLOps
```
1. Feature Engineering (Dataflow/BigQuery)
   ↓
2. Treinamento (Vertex AI Training + GPUs)
   ↓
3. Avaliação (comparação com modelo em produção)
   ↓
4. Registro (Vertex AI Model Registry)
   ↓
5. Deploy (Vertex AI Endpoints)
   ↓
6. Monitoramento (Vertex AI Model Monitoring — drift detection)
   ↓
7. Retreinamento automático se drift detectado (volta ao passo 1)
```

---

## Serverless Architecture no GCP

### Opções serverless por caso de uso

| Serviço | Caso de uso | Modelo de billing |
|---|---|---|
| Cloud Functions gen2 | Funções event-driven simples | Por invocação + CPU/memória |
| Cloud Run | APIs HTTP, containers complexos | Por CPU/memória durante request |
| Cloud Run Jobs | Batch, tarefas periódicas | Por CPU/memória durante execução |
| BigQuery | Analytics SQL | Por TB processado |
| Dataflow Serverless | ETL complexo sem cluster | Por unidade de data processada |
| App Engine Standard | Web apps com scaling a zero | Por instância-hora |

### Padrão serverless para APIs

```
Client → Cloud Load Balancing (HTTPS)
  → Cloud Armor (WAF, DDoS)
    → Cloud Run (API containers)
      ├── Firestore (dados de usuário, real-time)
      ├── Cloud SQL (dados relacionais via Cloud SQL Auth Proxy)
      ├── Secret Manager (credenciais)
      └── Pub/Sub (events para background processing)
            ↓
          Cloud Run Jobs (background processing)
```

### Cloud Functions gen2 vs gen1
- gen2 baseado em Cloud Run internamente
- Concurrência: gen2 suporta 1000 concurrent requests por instância (gen1: 1)
- Timeout: gen2 até 60 minutos (gen1: 9 minutos)
- Triggering: gen2 suporta todos os triggers do Eventarc (gen1 limitado)
- Recomendação: usar gen2 para todos os novos projetos

---

## Multi-Region Architecture

GCP tem vantagens específicas para deployments multi-region.

### Regiões e zonas
- Regiões: ~40 regiões globais
- Zonas: 3+ zonas por região
- Latência entre zonas na mesma região: <1ms

### Serviços intrinsecamente multi-region

**Cloud Spanner**
- Configurações: `nam6` (US), `eur3` (Europa), `asia1` (Ásia), `nam-eur-asia1` (global)
- Escrita sincronizada para quorum de réplicas — consistência global garantida
- RPO=0, RTO=0 para falhas regionais (sem interrupção visível)

**Cloud Bigtable**
- Replication entre clusters em múltiplas regiões
- Failover automático ou manual (com controle de qual cluster serve tráfego)
- Eventual consistency entre clusters (sem strong consistency cross-region)

**Firebase / Firestore**
- Modo Native: single region ou multi-region (nam5, eur3)
- RTO: automático — sem ação do operador em failover

**Cloud Load Balancing**
- Global load balancing com anycast: 1 IP público serve usuários de todo o mundo
- Premium Tier: tráfego roteia pela rede interna do Google até o backend mais próximo
- Standard Tier: tráfego usa internet pública após entrar no Google (mais barato, mais latência)

### Estratégia ativa-ativa multi-region
```
Global Anycast IP (Google Cloud Load Balancing)
  ├── us-central1 → Cloud Run + Cloud Spanner us-central1
  ├── europe-west1 → Cloud Run + Cloud Spanner europe-west1
  └── asia-east1 → Cloud Run + Cloud Spanner asia-east1

Cloud Spanner (configuração multi-region nam-eur-asia1):
  - Leituras: sempre no replica local (sem cross-region latency)
  - Escritas: quorum de réplicas (latência depende da configuração multi-region)
```

### Traffic Director
Service mesh global para routing de tráfego entre serviços com afinidade regional, failover, e canary cross-region.

---

## Event-Driven Architecture no GCP

### Padrão canônico: Pub/Sub + Dataflow + BigQuery

```
Aplicações/IoT → Pub/Sub Topics
                    ↓
               Dataflow (Apache Beam)
               - Windowing (tumbling 5min)
               - Deduplicação
               - Enriquecimento (lookup em Bigtable)
               - Validação de schema (Avro)
                    ↓
               BigQuery (tabelas particionadas)
```

### Eventarc
Roteamento de eventos de serviços GCP para Cloud Run, Cloud Functions, Workflows, ou via Pub/Sub.

Fontes de eventos:
- Mudanças em Cloud Storage (objetos criados/deletados)
- Operações em BigQuery (job completado)
- Mudanças em Firestore
- Eventos de Audit Logs (qualquer API call GCP)
- Pub/Sub mensagens
- Eventos de terceiros via webhooks

### Cloud Workflows
Orquestração de APIs e serviços serverless — equivalente ao AWS Step Functions.
- Sintaxe YAML/JSON para definir steps
- Retry automático, condicionais, loops
- Integra com qualquer API HTTP (GCP ou externa)
- Preço: $0.01/1000 passos internos executados

### Cloud Scheduler
Cron-as-a-service: agenda calls HTTP, mensagens Pub/Sub, ou invocações de Cloud Functions.
- 3 jobs gratuitos, depois $0.10/job-mês
