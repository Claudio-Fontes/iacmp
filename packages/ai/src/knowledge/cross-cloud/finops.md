# FinOps Multi-Cloud

Práticas de otimização de custo em nuvem comparadas entre AWS, Azure e GCP.

---

## Modelos de precificação por cloud

### AWS
- **On-Demand**: preço cheio, sem comprometimento
- **Savings Plans (Compute)**: desconto de 17-66% com commit de $ por hora por 1 ou 3 anos — aplica automaticamente a Lambda, Fargate, EC2 (qualquer família, tamanho, região)
- **Savings Plans (EC2 Instance)**: maior desconto mas limitado a família e região específica
- **Reserved Instances (RI)**: para RDS, ElastiCache, Redshift, OpenSearch — sem Savings Plans para esses serviços
- **Spot Instances**: 60-90% de desconto para workloads interrompíveis
- **Dedicated Hosts**: para licenciamento por socket/core (Oracle, Windows)

### Azure
- **Pay-as-you-go**: preço cheio
- **Reserved VM Instances (RIs)**: 1 ou 3 anos — 40-72% de desconto para VMs, SQL Database, Cosmos DB, App Service Plans, AKS node pools
- **Azure Savings Plan for Compute**: similar ao AWS Compute Savings Plans — flex em família/região por $ comprometido
- **Azure Hybrid Benefit**: usa licenças Windows Server e SQL Server on-premises no Azure — até 40% adicional em VMs, até 80% em Azure SQL
- **Dev/Test pricing**: preços especiais para ambientes de desenvolvimento (subscriptions específicas)
- **Spot VMs**: 60-90% de desconto para workloads interrompíveis

### GCP
- **On-demand**: preço cheio
- **Committed Use Discounts (CUDs) — Resource-based**: commit de vCPU/GB RAM por 1 ou 3 anos — 37-55% de desconto. Não se compromete com tipo de máquina específico
- **Committed Use Discounts — Spend-based**: commit de $ por hora por 1 ou 3 anos (para Cloud Run, GKE Autopilot, Cloud SQL, BigQuery reservations)
- **Sustained Use Discounts (SUDs)**: desconto automático proporcional ao uso mensal de VMs — sem comprometimento. 20-30% automaticamente para instâncias usadas >25% do mês
- **Preemptible VMs / Spot VMs**: 60-91% de desconto

---

## Rightsizing

Ajustar o tamanho dos recursos para o workload real — evitar over-provisioning.

### AWS Compute Optimizer
- Analisa métricas CloudWatch dos últimos 14 dias (configurável até 93 dias)
- Recomendações para: EC2, Auto Scaling Groups, Lambda (memory), EBS volumes, ECS on Fargate, RDS
- Identifica: over-provisioned, under-provisioned, ou adequado
- Estimated savings: calcula impacto financeiro de cada recomendação
- Exporta para S3 para análise custom

### Azure Advisor
- Recomendações de rightsizing baseadas em utilização de CPU/memória dos últimos 7 dias (configurável)
- Categorias: Cost, Performance, Reliability, Security, Operational Excellence
- Custo estimado por recomendação com 1-click implementation

### GCP Recommender
- Recomendações por tipo de recurso: VM rightsizing, Idle VM, Idle IP, Idle disk
- Cada recomendação tem: impacto (custo salvo), prioridade, e ação sugerida
- `gcloud recommender recommendations list --recommender=google.compute.instance.MachineTypeRecommender`

### Regras gerais de rightsizing

**CPU**
- Alvo de utilização média: 40-60%
- Se p99 < 80% consistentemente: candidato a downsize
- Pico de CPU > 80% frequente: considerar upsize ou autoscaling

**Memória**
- Evitar paging/swapping em produção (working set > RAM)
- Alvo: 60-70% de uso médio

**Lambda / Cloud Functions / Cloud Run**
- Lambda: Memory size afeta CPU disponível. Aumentar memória = mais CPU = execução mais rápida (pode reduzir custo total)
- Cloud Run: ajustar min-instances para evitar cold starts caros vs custo de idle
- Tip: AWS Lambda Power Tuning (step function open source) encontra configuração ótima de memória

---

## Reserved vs On-Demand vs Spot: Comparação

### Quando usar cada modelo

| Workload | Recomendação |
|---|---|
| Produção 24/7, previsível | Reserved/Committed (1-3 anos) |
| Produção com variação | Savings Plans + Autoscaling com on-demand |
| Batch, CI/CD, ML training | Spot/Preemptible (tolerante a interrupção) |
| Dev/Test | Ligar quando usar, desligar quando não usar (scheduler) |
| Serverless (Lambda/Cloud Run) | Savings Plans (AWS) ou CUD spend-based (GCP) |

### Calculadoras de ROI para reservas

Fórmula básica:
```
Breakeven Point = Upfront Cost / (Monthly On-Demand - Monthly Reserved)
```

Para 3 anos all-upfront ser mais econômico que mensal:
- AWS EC2: payback em ~12-15 meses tipicamente
- Azure VM: payback em ~12 meses
- GCP CUD: payback em ~8-10 meses (SUDs reduzem o delta)

### Flexibilidade das reservas

**AWS Savings Plans**: mais flexível — qualquer instância EC2 (família/tamanho/OS), qualquer região (Compute SP), Lambda, Fargate

**Azure Reserved Instances**: 
- Instance Size Flexibility: troca de tamanho dentro da mesma família (normalizable units)
- Scope: compartilhado entre subscriptions ou restrito a uma subscription
- Exchange: pode trocar RI antes do vencimento (por RI de mesmo ou maior valor)

**GCP CUDs**:
- Resource-based: flexível em tipo de máquina, inflexível em região
- Spend-based: mais flexível que resource-based

---

## Tag Strategy e Cost Allocation

Tags são a base para qualquer prática de FinOps — sem tags, não há visibilidade de custo por aplicação/time/ambiente.

### Taxonomia de tags recomendada

```
Environment:  production | staging | development | sandbox
Application:  nome-da-aplicacao
Team:         nome-do-time
CostCenter:   codigo-cc-financeiro
Owner:        email@empresa.com
Project:      nome-do-projeto-ou-epic
ManagedBy:    terraform | manual | cloudformation
```

### Implementação por cloud

**AWS**
- Tag Policies via AWS Organizations: define quais tags são obrigatórias e valores válidos
- Cost Allocation Tags: ativar tags específicas para aparecer em Cost Explorer e faturamento
- AWS Config Rule: `required-tags` para detectar recursos sem tags obrigatórias

**Azure**
- Azure Policy: `require-tag-on-resource-group` e `inherit-tag-from-resource-group`
- Bicep: tags definidas no RG se propagam para recursos filhos
- Cost Management: agrupa custos por tags no portal

**GCP**
- Labels (equivalente a tags): key-value pairs em recursos GCP
- `constraints/gcp.resourceLocations` e labels obrigatórias via Org Policy (mais limitado que AWS/Azure)
- Billing export para BigQuery: queries customizadas por label são muito mais flexíveis que consoles

### Showback vs Chargeback
- **Showback**: mostra o custo por time/app mas não cobra internamente — para consciência
- **Chargeback**: cobra o custo do centro de custo do time — maior accountability
- Implementação: relatórios em AWS Cost Explorer, Azure Cost Management, ou GCP BigQuery billing export

---

## Custo de transferência de dados (Data Transfer)

Um dos maiores custos surpresa em nuvem.

### AWS Data Transfer
- **Inbound**: gratuito (da internet para AWS)
- **Outbound para internet**: $0.09/GB (primeiros 10TB/mês, cai para $0.085 e menos em volume)
- **Between AZs**: $0.01/GB por direção (source paga)
- **Between Regions**: $0.02-0.09/GB dependendo da rota
- **CloudFront**: $0.085/GB (mas sem custo de AZ-to-AZ se CloudFront + origem na mesma região)
- **S3 para internet**: $0.09/GB mas gratuito via S3 Transfer Acceleration + CloudFront
- **VPC Endpoints (S3/DynamoDB)**: evitam custo de NAT Gateway data processing

### Azure Data Transfer
- **Inbound**: gratuito
- **Outbound para internet**: ~$0.087/GB (Zona 1 — US, Europe, Korea) primeiros 10TB
- **Between AZs**: gratuito! (diferencial do Azure vs AWS)
- **Between Regions**: $0.02-0.14/GB dependendo das regiões

### GCP Data Transfer
- **Inbound**: gratuito
- **Outbound para internet**: $0.12/GB (primeiros 1TB gratuitos/mês)
- **Between Zones (mesma região)**: $0.01/GB por direção
- **Between Regions**: $0.01-0.08/GB

### Estratégias para reduzir custo de data transfer
- Usar CDN (CloudFront, Azure CDN, Cloud CDN) para conteúdo estático — evita repetir download
- VPC Endpoints para tráfego S3/DynamoDB (AWS) — evita NAT Gateway
- Private Endpoints (Azure) — evita egress pelo endpoint público
- Colocar compute próximo dos dados (mesma região, preferencialmente mesma AZ)
- Comprimir dados antes de transferir (gzip para HTTP APIs)

---

## Custo de serviços serverless

### Lambda (AWS)
- $0.20/million requests + $0.0000166667/GB-second
- Exemplo: 1M requests de 500ms com 512MB = $0.20 + ($0.0000166667 × 0.5 × 0.5 × 1M) = $0.20 + $4.17 = ~$4.37
- Free tier: 1M requests e 400.000 GB-seconds/mês permanente

### Cloud Functions (GCP)
- $0.40/million requests + $0.0000100/GB-second + $0.00001/vCPU-second
- Free tier: 2M requests, 400K GB-seconds, 200K CPU-seconds/mês

### Azure Functions (Consumption)
- $0.20/million executions + $0.000016/GB-second
- Free tier: 1M executions e 400K GB-seconds/mês permanente

### Cloud Run (GCP) vs Fargate (AWS) vs Container Apps (Azure)
- Cloud Run: $0.00002400/vCPU-second + $0.00000250/GiB-second durante request processing
- Fargate (Spot): $0.01334/vCPU-hour + $0.00146/GB-hour (~$9.7/vCPU/mês)
- Container Apps: $0.000024/vCPU-second + $0.0000030/GiB-second (similar ao Cloud Run)

---

## Ferramentas de FinOps

### Nativas
| Cloud | Ferramenta | Função |
|---|---|---|
| AWS | Cost Explorer | Análise e projeção de custos |
| AWS | AWS Budgets | Alertas por serviço/tag/conta |
| AWS | Trusted Advisor | Idle resources, rightsizing |
| AWS | Compute Optimizer | Rightsizing ML-based |
| Azure | Cost Management + Billing | Análise, budgets, alertas |
| Azure | Azure Advisor | Recomendações de custo |
| GCP | Cloud Billing | Análise de faturamento |
| GCP | Recommender | Rightsizing e idle resources |
| GCP | BigQuery Billing Export | Análise SQL de custos |

### Terceiros populares
- **Infracost**: custo de IaC (Terraform) antes do apply — CI/CD integration
- **CloudHealth (VMware)**: plataforma multi-cloud de FinOps
- **Apptio Cloudability**: enterprise FinOps
- **CAST AI**: otimização de Kubernetes (rightsizing + Spot automaticamente)
- **Spot by NetApp**: gestão de Spot Instances com SLA
