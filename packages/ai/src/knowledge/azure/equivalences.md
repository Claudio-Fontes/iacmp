# Equivalências Azure ↔ AWS

## Compute

| AWS | Azure | Observações |
|---|---|---|
| EC2 | Azure Virtual Machines | Famílias similares: B-series (burstable), D-series (general purpose), F-series (compute optimized) |
| EC2 Auto Scaling | Virtual Machine Scale Sets (VMSS) | VMSS tem Flexible e Uniform orchestration modes |
| Lambda | Azure Functions | Functions tem planos: Consumption (serverless), Premium, Dedicated |
| ECS / Fargate | Azure Container Instances (ACI) | ACI é mais simples; para orchestração use AKS |
| EKS | AKS (Azure Kubernetes Service) | AKS tem integração nativa com Azure AD, ACR, Monitor |
| Elastic Beanstalk | Azure App Service | App Service suporta Docker, .NET, Node.js, Python, Java |
| AWS Batch | Azure Batch | Processamento em batch de alta performance |
| EC2 Spot | Azure Spot VMs | Mesma ideia: desconto alto com risco de preempção |

---

## Storage

| AWS | Azure | Observações |
|---|---|---|
| S3 | Azure Blob Storage | Tiers: Hot, Cool, Cold, Archive (similar ao Glacier) |
| S3 Glacier | Azure Blob Archive | Retrieval: horas |
| EFS | Azure Files | SMB e NFS; pode ser montado em VMs e AKS |
| EBS | Azure Managed Disks | Premium SSD = io1/io2, Standard SSD = gp3, Standard HDD = sc1 |
| S3 Transfer Acceleration | Azure CDN + Blob | Não é exatamente equivalente |
| AWS Backup | Azure Backup | Backup centralizado para VMs, bancos, files |

---

## Banco de Dados

| AWS | Azure | Observações |
|---|---|---|
| RDS MySQL | Azure Database for MySQL - Flexible Server | Recomendado sobre o Single Server (deprecated) |
| RDS PostgreSQL | Azure Database for PostgreSQL - Flexible Server | Idem |
| Aurora | Não tem equivalente direto | Mais próximo: Azure SQL Hyperscale |
| RDS SQL Server | Azure SQL Database / SQL Managed Instance | SQL MI para lift-and-shift de SQL Server on-prem |
| DynamoDB | Azure Cosmos DB (Core API / Table API) | Cosmos DB é multi-modelo: SQL, MongoDB, Cassandra, Gremlin, Table |
| DocumentDB | Azure Cosmos DB (MongoDB API) | Compatibilidade com MongoDB 4.0+ |
| ElastiCache Redis | Azure Cache for Redis | Enterprise tier usa Redis Enterprise (módulos, maior performance) |
| ElastiCache Memcached | Azure Cache for Redis (Basic tier) | Azure não tem Memcached nativo |
| Neptune | Azure Cosmos DB (Gremlin API) | Banco de grafos |
| Redshift | Azure Synapse Analytics | Data warehouse + analytics |

---

## Rede

| AWS | Azure | Observações |
|---|---|---|
| VPC | Azure Virtual Network (VNet) | VNet não tem CIDR automático — você define explicitamente |
| Subnet | Subnet | Azure subnets delimitam grupos de recursos dentro da VNet |
| Security Group | Network Security Group (NSG) | NSGs podem ser associados a subnets (não só a VMs) |
| Internet Gateway | Não precisa — VMs com IP público têm acesso automático | Diferença importante do modelo AWS |
| NAT Gateway | NAT Gateway | Similar ao AWS, mas configuração diferente |
| VPC Peering | VNet Peering | Transitivo não funciona — use Azure Virtual WAN |
| Transit Gateway | Azure Virtual WAN | Hub and spoke para múltiplas VNets e on-premises |
| Direct Connect | Azure ExpressRoute | Conectividade dedicada com on-premises |
| VPN Gateway | Azure VPN Gateway | Site-to-site e point-to-site VPN |
| Route53 | Azure DNS + Traffic Manager | DNS: Azure DNS. Roteamento global: Traffic Manager |
| CloudFront | Azure CDN / Azure Front Door | Front Door: CDN + WAF + global load balancing em um |
| ALB | Azure Application Gateway | Layer 7 + WAF integrado |
| NLB | Azure Load Balancer (Standard) | Layer 4 |
| WAF | Azure WAF | Associado a Application Gateway ou Front Door |
| AWS PrivateLink | Azure Private Link | Acesso privado a serviços PaaS |

---

## Segurança e Identidade

| AWS | Azure | Observações |
|---|---|---|
| IAM | Azure Active Directory (AAD) + RBAC | AAD gerencia usuários; RBAC gerencia permissões em recursos |
| IAM Role para EC2 | Managed Identity (System ou User Assigned) | Equivalente direto — sem credenciais estáticas |
| Secrets Manager | Azure Key Vault | Key Vault armazena também certificados e chaves de criptografia |
| Parameter Store | Azure App Configuration | App Configuration também para feature flags |
| KMS | Azure Key Vault (HSM-backed keys) | Managed HSM para compliance FIPS 140-2 Level 3 |
| AWS SSO | Azure AD SSO | Federation com SAML 2.0 / OIDC |
| AWS Shield | Azure DDoS Protection | Standard (gratuito e básico) e Network Protection (pago) |
| GuardDuty | Microsoft Defender for Cloud | Threat detection + security posture management |
| Security Hub | Microsoft Defender for Cloud | Agregação de alertas e compliance score |
| CloudTrail | Azure Monitor Activity Log | Log de todas as operações no plano de controle |
| Config | Azure Policy + Azure Resource Graph | Policy: compliance em tempo real. Resource Graph: query de recursos |

---

## Messaging e Eventos

| AWS | Azure | Observações |
|---|---|---|
| SQS | Azure Service Bus (Queues) | Service Bus tem mais features: sessions, dead-letter, scheduled |
| SNS | Azure Service Bus (Topics) | Topics com subscriptions e filtros |
| EventBridge | Azure Event Grid | Event Grid integra com 50+ serviços Azure e suporta CloudEvents |
| Kinesis | Azure Event Hubs | Event Hubs é compatível com protocolo Kafka |
| MSK (Kafka) | Azure HDInsight (Kafka) / Event Hubs | Event Hubs com protocolo Kafka = opção gerenciada mais simples |
| Step Functions | Azure Logic Apps / Durable Functions | Logic Apps: low-code. Durable Functions: código em C#/Node.js |
| SWF | Azure Durable Functions | Workflows stateful em código |

---

## Observabilidade

| AWS | Azure | Observações |
|---|---|---|
| CloudWatch Metrics | Azure Monitor Metrics | |
| CloudWatch Logs | Azure Monitor Logs (Log Analytics) | Log Analytics usa KQL (Kusto Query Language) |
| CloudWatch Alarms | Azure Monitor Alerts | |
| CloudWatch Dashboards | Azure Workbooks / Monitor Dashboards | |
| X-Ray | Azure Application Insights | Application Insights = APM completo com distributed tracing |
| AWS Health | Azure Service Health | Status de serviços por região |

---

## Diferenças Conceituais Importantes

### Hierarquia de recursos
AWS: Account → Region → VPC → Subnet → Resource
Azure: Tenant → Subscription → Resource Group → Resource (sem VNet na hierarquia de billing)

### Identidade
AWS: IAM é separado por conta. Azure: AAD é o diretório central, compartilhado entre subscriptions.

### Rede
AWS: recursos em VPC privada precisam de Internet Gateway + route para sair. 
Azure: VMs com IP público têm acesso à internet automaticamente (mais permissivo por padrão).

### Billing
AWS: por conta (Account). Azure: por subscription. Uma empresa geralmente tem múltiplas subscriptions por ambiente (dev/staging/prod).
