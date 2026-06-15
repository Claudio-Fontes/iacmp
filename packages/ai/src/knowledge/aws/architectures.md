# Padrões de Arquitetura AWS

## 3-Tier Web Application (Tradicional)

```
Internet → CloudFront → ALB → ECS/EC2 (App Layer) → RDS (Data Layer)
                   ↓
               S3 (Static Assets)
```

Componentes típicos:
- CloudFront: CDN + WAF para proteção e cache de assets
- ALB: distribui tráfego entre instâncias/tasks da aplicação
- ECS Fargate: camada de aplicação sem gerenciar servidores
- RDS Multi-AZ: banco relacional com failover automático
- ElastiCache Redis: cache de sessões e dados frequentes
- S3: assets estáticos, uploads de usuário

Quando usar: apps web tradicionais, e-commerce, portais, SaaS

---

## Serverless API (Event-Driven)

```
Cliente → API Gateway → Lambda → DynamoDB
                    ↓
              SQS → Lambda (workers assíncronos)
                    ↓
              S3 (outputs, relatórios)
```

Componentes típicos:
- API Gateway HTTP API: roteamento de endpoints
- Lambda: lógica de negócio por função
- DynamoDB: dados primários (on-demand para escala automática)
- SQS: desacoplamento de tarefas assíncronas
- EventBridge: eventos entre serviços

Quando usar: APIs com carga variável, startups, apps event-driven, MVPs

Vantagens: custo zero em idle, escala automática, zero administração de servidor
Desvantagens: cold start, timeout de 15min, stateless

---

## Microserviços em EKS/ECS

```
Internet → ALB + WAF → EKS/ECS Cluster
                             ↓
                    [Service A] [Service B] [Service C]
                         ↓           ↓           ↓
                       RDS       DynamoDB     ElastiCache
                                      ↓
                              SQS / EventBridge (async)
```

Padrões internos:
- Service Discovery: AWS Cloud Map ou CoreDNS (K8s)
- Circuit breaker: AWS App Mesh ou Istio (EKS)
- API entre serviços: REST sobre HTTP interno, gRPC para alta performance
- Config centralizado: AWS Systems Manager Parameter Store / Secrets Manager

Quando usar: times grandes, domínios bem definidos, escala independente por serviço

---

## Data Lake na AWS

```
Fontes → Kinesis Data Streams/Firehose → S3 (Raw)
                                              ↓
                                    Glue ETL → S3 (Processed)
                                              ↓
                                       Athena (Query) / Redshift
                                              ↓
                                    QuickSight (Visualização)
```

Camadas do S3:
- Raw (Bronze): dados como chegam, sem transformação
- Processed (Silver): dados limpos e normalizados
- Curated (Gold): agregações e datasets prontos para análise

Quando usar: analytics, ML training, compliance/auditoria, dados históricos

---

## Disaster Recovery Patterns

### Backup & Restore (RPO: horas, RTO: horas)
- S3 para backups de RDS, DynamoDB exports, EBS snapshots
- Custo mínimo — restauração manual em caso de desastre
- Adequado para: sistemas não-críticos, ambientes de dev/staging

### Pilot Light (RPO: minutos, RTO: minutos)
- Infraestrutura mínima rodando na região secundária (só banco replicado)
- Após desastre: escala os recursos de compute na região secundária
- Adequado para: sistemas de média criticidade

### Warm Standby (RPO: segundos, RTO: minutos)
- Versão reduzida do sistema rodando na região secundária
- Scale-out após failover
- Adequado para: sistemas críticos de negócio

### Multi-Region Active-Active (RPO: zero, RTO: zero)
- Tráfego distribuído entre regiões via Route53 latency/geolocation routing
- DynamoDB Global Tables, Aurora Global Database
- Custo alto — justificado para sistemas mission-critical
- Adequado para: fintech, saúde, e-commerce de grande escala

---

## Well-Architected Framework — 6 Pilares

### 1. Excelência Operacional
- Automatize tudo: IaC (CloudFormation/Terraform), CI/CD, rollbacks
- Observe: CloudWatch métricas, logs, X-Ray traces
- Falhe com segurança: blue/green deployments, canary releases

### 2. Segurança
- IAM least privilege: cada serviço tem apenas as permissões que precisa
- Encriptação: KMS para dados em repouso, TLS para dados em trânsito
- Rede: VPC privada, security groups restritivos, WAF na borda
- Auditoria: CloudTrail para todas as chamadas de API, Config para drift

### 3. Confiabilidade
- Multi-AZ: sempre para produção (RDS, ElastiCache, ALB)
- Health checks: ALB + Route53 health checks
- Idempotência: operações que podem ser reenviadas sem efeito colateral
- Backup e teste de restore: automatize e teste periodicamente

### 4. Eficiência de Performance
- Caching: CloudFront, ElastiCache, DAX (DynamoDB)
- Tipo certo para o workload: Spot para batch, Reserved para baseline, On-demand para burst
- Auto Scaling: EC2 Auto Scaling, ECS Service Auto Scaling, DynamoDB on-demand

### 5. Otimização de Custos
- Reserved Instances / Savings Plans: 30–72% de desconto para workloads previsíveis
- Spot Instances: até 90% de desconto para workloads tolerantes a interrupção
- Right-sizing: use Compute Optimizer para recomendações de tipo de instância
- Lifecycle S3: mova dados antigos para Glacier/Deep Archive automaticamente
- Elimine recursos ociosos: snapshots, EIPs, volumes EBS não anexados

### 6. Sustentabilidade
- Use regiões com maior percentual de energia renovável
- Prefira Fargate/Lambda (densidade maior, menos servidores físicos)
- Reduza transferência de dados cross-region desnecessária

---

## Padrões de Segurança

### VPC Design Segura
```
Subnet Pública: ALB, NAT Gateway, Bastion Host
Subnet Privada: EC2/ECS (App), RDS, ElastiCache
Subnet Isolada: RDS sem acesso à internet (sem NAT)
```

Regras:
- Nunca coloque RDS/ElastiCache em subnet pública
- Lambda que acessa RDS deve estar na mesma VPC
- Use Security Groups, não NACLs, para controle granular
- VPC Flow Logs: habilite sempre para auditoria de tráfego

### Secrets Management
- Nunca armazene secrets em variáveis de ambiente de EC2 ou em código
- Use Secrets Manager: rotação automática, integração com RDS
- Parameter Store: configs não-sensíveis (gratuito), secrets sensíveis (Standard tier)
- Para Lambda: busque secrets em init com cache de 5 minutos

### IAM Best Practices
- Nunca use credenciais de root para operações normais
- MFA obrigatório para usuários IAM humanos
- Use roles para serviços (não access keys)
- Revise permissions boundary para contas de serviço
- AWS Organizations + SCPs para guardrails de conta
