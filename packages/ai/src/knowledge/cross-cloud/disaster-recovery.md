# Disaster Recovery Multi-Cloud

Estratégias, métricas e implementação de DR nas três principais clouds.

---

## Definições fundamentais

### RPO (Recovery Point Objective)
Quanto de dados podemos perder em caso de desastre?
- RPO = 0: nenhuma perda de dados (replicação síncrona)
- RPO = 1h: aceitamos perder até 1h de dados
- RPO define a **frequência mínima de backup** ou **tipo de replicação** necessária

### RTO (Recovery Time Objective)
Em quanto tempo o sistema precisa estar disponível após o desastre?
- RTO = 0: zero downtime (ativo-ativo)
- RTO = 15min: sistema deve estar operacional em 15 minutos
- RTO define a **estratégia de DR** (quanto infraestrutura manter pré-aquecida)

### Relação RPO/RTO com custo
```
Menor RPO + Menor RTO = Maior custo
RPO = 0, RTO = 0: ativo-ativo em múltiplas regiões (custo 2x+)
RPO = 1h, RTO = 4h: warm standby (custo ~1.5x)
RPO = 24h, RTO = 72h: backup/restore (custo ~1.1x)
```

---

## Estratégias de DR (crescente complexidade e custo)

### 1. Backup and Restore
**RPO**: horas a dias | **RTO**: horas a dias

A estratégia mais simples. Backups periódicos armazenados em outra região/provider. Em caso de desastre, provisionando nova infraestrutura e restaurando backups.

**Quando usar**: sistemas não-críticos, dev/test, arquivos de dados históricos.

**Como implementar**:
- AWS: AWS Backup com cross-region copy rules; RDS automated backups para S3
- Azure: Azure Backup com geo-redundant storage; SQL Database automated backups
- GCP: Cloud SQL automated backups para GCS; Cloud Storage com turbo replication

**Custo adicional**: ~10-20% do custo de produção (apenas storage de backups)

### 2. Pilot Light
**RPO**: minutos | **RTO**: 1-4 horas

Mínimo de infraestrutura rodando na região de DR (apenas o "piloto" — núcleo crítico ativo). Dados são replicados continuamente. Em desastre, infra é escalada rapidamente.

**Componentes no pilot light**:
- Banco de dados replicado (mas com capacidade mínima)
- Imagens de containers/AMIs atualizadas
- IaC pronta para deploy (Terraform, CloudFormation)

**O que NÃO fica ativo**: servidores de aplicação, load balancers, capacidade adicional de banco

**Como implementar**:
- AWS: RDS Read Replica em outra região + Route 53 Health Check + CloudFormation template preparado
- Azure: SQL Database Geo-replication (secondary em modo read-only) + ARM template preparado
- GCP: Cloud SQL replica cross-region + GKE cluster pre-criado com 0 nodes

**Custo adicional**: ~20-40% do custo de produção

### 3. Warm Standby
**RPO**: segundos a minutos | **RTO**: minutos a 1 hora

Versão reduzida do ambiente de produção rodando continuamente na região de DR. Pode servir algum tráfego (ex: leitura). Em desastre, aumenta capacidade rapidamente.

**Diferença do Pilot Light**: aplicações já estão rodando (em capacidade mínima), não apenas dados.

**Como implementar**:
- AWS: EC2 Auto Scaling Group com capacidade mínima (1-2 instâncias) + RDS Read Replica promotável + Route 53 failover policy
- Azure: App Service em secondary region (scaled down) + SQL geo-replication + Traffic Manager com priority routing
- GCP: GKE cluster com pool mínimo + Cloud SQL cross-region replica + Cloud Load Balancing com backend groups em múltiplas regiões

**Custo adicional**: ~40-80% do custo de produção (ambiente menor mas funcional)

### 4. Multi-Site / Active-Active
**RPO**: 0 (ou segundos) | **RTO**: 0 (ou segundos)

Duas ou mais regiões processando tráfego simultaneamente. Falha em uma região é tratada sem intervenção manual.

**Como implementar**:
- AWS: Route 53 latency-based routing + ALBs em múltiplas regiões + Aurora Global Database (replicação <1s entre regiões) + DynamoDB Global Tables
- Azure: Azure Traffic Manager (routing global) + App Service multi-region + Azure SQL Failover Groups
- GCP: Cloud Load Balancing global anycast + Cloud Spanner multi-region (RPO=0 nativo) + Cloud Run multi-region

**Custo adicional**: ~100%+ do custo de produção (infra duplicada/triplicada)

**Complexidade**: muito alta — requer tratar conflitos de dados, gerenciar estado global, roteamento inteligente

---

## Backup por serviço em cada Cloud

### AWS

| Serviço | Mecanismo | Cross-region |
|---|---|---|
| RDS / Aurora | Automated backups (ponto no tempo, 35 dias) + Snapshots manuais | Copiar snapshot cross-region manualmente ou via AWS Backup |
| DynamoDB | Point-in-time recovery (PITR) 35 dias + Global Tables (replicação ativa) | Global Tables: multi-region ativo-ativo |
| S3 | Versioning + S3 Cross-Region Replication (CRR) | CRR para bucket em outra região |
| EBS | Snapshots no S3 + Data Lifecycle Manager | Copiar snapshot cross-region |
| EFS | AWS Backup com cross-region | Via AWS Backup |
| EC2 | AMI (imagem de instância) | Copiar AMI cross-region |
| Lambda | Code em S3 (versionado) | S3 CRR para código |
| DocumentDB | Automated backups + Snapshots | Copiar snapshot cross-region |

**AWS Backup**: serviço centralizado para coordenar backups de múltiplos serviços com políticas, retenção e cross-region automaticamente.

### Azure

| Serviço | Mecanismo | Geo-redundância |
|---|---|---|
| SQL Database | Automated backups (full semanal, diferencial 12h, log 5-12min) por 7-35 dias | Geo-restore (GRS) ou Geo-replication ativa |
| Cosmos DB | Backup contínuo (PITR 30 dias) | Multi-region nativo (ativo-ativo com $) |
| Blob Storage | Versioning + Blob Soft Delete + Point-in-time restore | GRS ou RA-GRS para leitura na região secundária |
| VM (Discos) | Azure Backup (recovery points) | Cross-region restore via Azure Backup |
| Key Vault | Soft-delete (90 dias) + Purge protection | Backup de secrets para outro Key Vault |
| App Service | Automated backups para Storage Account | Manual restore em outra região |

**Azure Backup**: vault unificado para VMs, SQL, blobs, discos com políticas de retenção.

### GCP

| Serviço | Mecanismo | Multi-region |
|---|---|---|
| Cloud SQL | Automated backups diários + PITR (7 dias) | Réplica cross-region (não automaticamente promotável via console) |
| Cloud Spanner | Backups automáticos (1 dia default) + PITR | Configurações multi-region nativas (RPO≈0) |
| Firestore | Exports para GCS + PITR (7 dias, Firestore native) | Multi-region bucket + multi-region Firestore |
| GCS (Buckets) | Versioning + Retention policies | Multi-region ou dual-region buckets |
| Bigtable | Backups + replication cross-cluster | Cluster replication entre regiões |
| GKE | Velero (open source) para backup de estado | Cluster em múltiplas regiões |
| Compute Engine | Snapshots de disco agendados | Copiar snapshot cross-region |

---

## Testes de DR

### Por que testar é essencial
Planos de DR não testados falham. Estudos mostram que 60-70% dos planos de DR falham no primeiro teste real.

### Tipos de teste

**Tabletop Exercise**
- Simulação sem ação técnica — time discute "o que faríamos se X falhasse?"
- Frequência: trimestral
- Identifica gaps de processo e comunicação

**Simulation Test (DR Drill)**
- Executa o procedimento de DR em ambiente separado (não produção)
- Valida que os scripts/playbooks funcionam
- Frequência: semestral

**Chaos Engineering**
- Introduz falhas intencionalmente em produção para validar resiliência
- AWS: Fault Injection Simulator (FIS)
- Azure: Azure Chaos Studio
- GCP: não tem serviço nativo — usar chaos-mesh no GKE ou scripts customizados
- Netflix: Chaos Monkey (open source, referência da área)

**Failover Real**
- Fail over para região de DR durante janela de manutenção programada
- Valida RTO/RPO reais
- Frequência: anual mínimo para sistemas críticos

### Métricas de teste de DR
- MTTR (Mean Time to Recovery): tempo médio para recuperar — deve ser ≤ RTO
- MTBF (Mean Time Between Failures): frequência de falhas — guia investimentos em resiliência
- Change Failure Rate: % de mudanças que resultam em incidente — manter <15%

---

## Considerações de custo em DR

### Custo de storage de backup
- AWS S3 Standard-IA: $0.0125/GB-mês (vs S3 Standard $0.023) — boa opção para backups
- AWS S3 Glacier Instant Retrieval: $0.004/GB-mês — para backups históricos com RTO >1h
- Azure ZRS vs GRS: GRS custa 25% mais mas replica cross-region automaticamente
- GCP: Dual-region bucket = 25-50% mais caro que single region; Multi-region = mais caro ainda

### Custo de replicação de dados
- Entre regiões: data transfer cross-region se aplica (ver finops.md)
- AWS Aurora Global Database: custo de replicação cross-region em cima do Aurora normal
- Azure SQL Failover Groups: sem custo adicional de replicação (incluso no DTU/vCore)
- GCP Spanner multi-region: premium significativo sobre single-region

### Calculando o custo de downtime para justificar DR
```
Custo de DR = Custo adicional de infraestrutura de DR + Operação + Testes anuais

Custo de downtime = (Revenue per hour × Expected downtime hours) + 
                    (Reputational damage) + 
                    (SLA penalties) +
                    (Recovery costs)

Se Custo de downtime > Custo de DR → investir em DR é justificado
```
