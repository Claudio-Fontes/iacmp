# Equivalências GCP ↔ AWS ↔ Azure

## Compute

| AWS | Azure | GCP | Observações GCP |
|---|---|---|---|
| EC2 | Azure VMs | Compute Engine | Machine types: E2 (economy), N2 (general), C3 (compute optimized), M3 (memory optimized) |
| EC2 Auto Scaling | VMSS | Managed Instance Groups (MIG) | MIG com autoscaler, suporta rolling updates |
| Lambda | Azure Functions | Cloud Functions (Gen 2) | Gen 2 usa Cloud Run internamente, mais poderoso |
| ECS/Fargate | ACI | Cloud Run | Serverless containers — mais simples que K8s |
| EKS | AKS | GKE (Google Kubernetes Engine) | GKE Autopilot: sem nodes para gerenciar |
| Elastic Beanstalk | App Service | App Engine | App Engine Standard vs Flexible |
| AWS Batch | Azure Batch | Cloud Batch | Jobs em HPC e ML |
| EC2 Spot | Azure Spot VMs | Spot VMs (Preemptible) | GCP: 24h máximo, 60-91% de desconto |

---

## Storage

| AWS | Azure | GCP | Observações GCP |
|---|---|---|---|
| S3 | Blob Storage | Cloud Storage | Storage classes: Standard, Nearline (30d), Coldline (90d), Archive (365d) |
| S3 Glacier | Blob Archive | Cloud Storage Archive | Retrieval em horas |
| EFS | Azure Files | Filestore | Filestore: Basic, Enterprise, High Scale tiers |
| EBS | Managed Disks | Persistent Disk | PD Standard, Balanced, SSD, Extreme |
| — | Ultra Disk | Hyperdisk | Ultra-low latency para databases |

---

## Banco de Dados

| AWS | Azure | GCP | Observações GCP |
|---|---|---|---|
| RDS MySQL | Azure DB for MySQL | Cloud SQL for MySQL | Cloud SQL: fully managed, até 96 vCPUs |
| RDS PostgreSQL | Azure DB for PostgreSQL | Cloud SQL for PostgreSQL | AlloyDB: compatível com PostgreSQL, 4x mais rápido |
| Aurora | Azure SQL Hyperscale | AlloyDB | AlloyDB Omni: roda on-premises também |
| DynamoDB | Cosmos DB | Bigtable + Firestore | Bigtable: wide-column, alta throughput. Firestore: documentos com queries |
| DocumentDB | Cosmos DB (MongoDB) | Firestore (Native mode) | Firestore: consultas em tempo real, offline sync |
| ElastiCache Redis | Azure Cache for Redis | Memorystore for Redis | Memorystore: Redis 6/7, Standard tier com HA |
| ElastiCache Memcached | — | Memorystore for Memcached | |
| Redshift | Azure Synapse | BigQuery | BigQuery: serverless, sem cluster, paga por query ou por slot |
| Neptune | Cosmos DB Gremlin | — | GCP não tem managed graph database nativo |
| Keyspaces | Cosmos DB Cassandra | Bigtable (compatibilidade parcial) | |

### Serviços de Banco Únicos do GCP
- **Spanner**: banco relacional globalmente distribuído, ACID em escala global, sem equivalente na AWS/Azure
- **Firestore**: banco NoSQL de documentos com sincronização em tempo real (ideal para apps mobile/web)
- **BigTable**: wide-column NoSQL para analytics e IoT, base do HBase

---

## Rede

| AWS | Azure | GCP | Observações GCP |
|---|---|---|---|
| VPC | VNet | VPC | GCP VPC é global (não por região como AWS) — uma VPC, subnets por região |
| Subnet | Subnet | Subnet | Subnets GCP são regionais (dentro da VPC global) |
| Security Group | NSG | Firewall Rules | GCP: regras de firewall por rede, aplicadas via tags em VMs |
| Internet Gateway | — | Cloud Router / NAT | GCP VMs com IP público têm acesso automático |
| NAT Gateway | NAT Gateway | Cloud NAT | Sem IPs por porta — shared NAT pool |
| VPC Peering | VNet Peering | VPC Peering | Transitivo não funciona — use Shared VPC |
| Transit Gateway | Azure Virtual WAN | Shared VPC + Cloud Router | Shared VPC: uma VPC host, projetos satélite |
| Direct Connect | ExpressRoute | Cloud Interconnect | Dedicated e Partner Interconnect |
| Route53 | Azure DNS + Traffic Manager | Cloud DNS + Cloud Load Balancing | |
| CloudFront | Azure CDN / Front Door | Cloud CDN + Cloud Armor | Cloud Armor = WAF + DDoS |
| ALB | Application Gateway | HTTP(S) Load Balancing | Layer 7 global |
| NLB | Azure Load Balancer | TCP/UDP Load Balancing | Layer 4 regional ou global |
| WAF | Azure WAF | Cloud Armor | Cloud Armor: regras pré-configuradas + custom rules |

---

## Segurança e Identidade

| AWS | Azure | GCP | Observações GCP |
|---|---|---|---|
| IAM | AAD + RBAC | Cloud IAM | IAM no GCP é por projeto/recurso, não separado por conta |
| IAM Role para EC2 | Managed Identity | Service Account | Service Accounts são tanto identidade quanto credencial |
| Secrets Manager | Key Vault | Secret Manager | |
| Parameter Store | App Configuration | Cloud Config Connector / Secret Manager | |
| KMS | Key Vault Keys | Cloud KMS | Cloud HSM para hardware security modules |
| CloudTrail | Activity Log | Cloud Audit Logs | Admin Activity, Data Access, System Event logs |
| Config | Azure Policy | Security Command Center + Config Connector | |
| GuardDuty | Defender for Cloud | Security Command Center | |
| Shield | Azure DDoS Protection | Cloud Armor | Cloud Armor tem proteção DDoS integrada |

### IAM do GCP — Diferenças Importantes
- **Hierarquia**: Organization → Folder → Project → Resource
- **Herança**: políticas definidas em nível superior herdam para baixo (pode ser negado em nível filho)
- **Service Accounts**: são recursos, têm email (nome@projeto.iam.gserviceaccount.com), podem ter keys ou usar Workload Identity
- **Roles**: Primitive (Owner/Editor/Viewer — evite), Predefined (granular por serviço), Custom
- **Workload Identity Federation**: acesso a GCP sem Service Account keys (recomendado para CI/CD)

---

## Messaging e Eventos

| AWS | Azure | GCP | Observações GCP |
|---|---|---|---|
| SQS | Service Bus Queues | Cloud Tasks | Cloud Tasks: HTTP tasks com retry, rate limiting |
| SNS | Service Bus Topics | Pub/Sub | Pub/Sub: alta throughput, at-least-once delivery |
| EventBridge | Event Grid | Eventarc | Eventarc roteia eventos de serviços GCP para Cloud Run/Functions |
| Kinesis | Event Hubs | Pub/Sub | Pub/Sub é equivalente funcional ao Kinesis |
| MSK | Event Hubs com Kafka | Managed Service for Apache Kafka | |
| Step Functions | Logic Apps / Durable Functions | Cloud Workflows | Workflows usa sintaxe YAML, suporta parallelism |
| SWF | Durable Functions | Workflows + Eventarc | |

---

## Observabilidade

| AWS | Azure | GCP | Observações GCP |
|---|---|---|---|
| CloudWatch Metrics | Azure Monitor Metrics | Cloud Monitoring | |
| CloudWatch Logs | Log Analytics | Cloud Logging | Cloud Logging usa filtros avançados (similar ao grep) |
| CloudWatch Alarms | Azure Monitor Alerts | Cloud Monitoring Alerting | |
| X-Ray | Application Insights | Cloud Trace + Cloud Profiler | |
| CloudWatch Dashboards | Azure Monitor Dashboards | Cloud Monitoring Dashboards | |

---

## Serviços Únicos do GCP sem Equivalente Direto

### BigQuery
- Data warehouse serverless — sem clusters, sem provisionamento
- Paga por TB processado em queries (ou flat-rate com slots)
- Integração nativa com Looker Studio, Vertex AI, Data Studio
- Streaming insert direto (sem Kinesis/Firehose necessário)

### Vertex AI
- Plataforma ML gerenciada: treinamento, serving, MLOps
- Integra BigQuery ML, AutoML, custom training
- Workbench: JupyterLab managed

### Anthos
- Gerenciamento de K8s multi-cloud e on-premises
- Run GKE em AWS, Azure, ou on-premises
- Sem equivalente no AWS/Azure

### Cloud Spanner
- RDBMS globalmente distribuído com ACID em escala horizontal
- Sem equivalente no mercado — única opção gerenciada
- Custo alto, mas para sistemas que precisam de SQL + escala global + consistência forte

### Apigee
- API management enterprise de alta maturidade (adquirido pela Google)
- Mais completo que AWS API Gateway para casos enterprise
