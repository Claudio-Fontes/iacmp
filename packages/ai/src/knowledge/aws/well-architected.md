# AWS Well-Architected Framework

O AWS Well-Architected Framework fornece um conjunto de princípios e práticas para avaliar e melhorar arquiteturas em nuvem. Composto de 6 pilares desde 2021 (Sustainability adicionado na re:Invent 2021).

---

## Pilar 1: Operational Excellence

**Objetivo**: Executar e monitorar sistemas para entregar valor de negócio e melhorar continuamente processos e procedimentos.

### Princípios de design
- Executar operações como código (runbooks e playbooks em código versionado)
- Fazer mudanças frequentes, pequenas e reversíveis
- Refinar procedimentos operacionais com frequência
- Antecipar falhas (pre-mortem, chaos engineering)
- Aprender com todos os eventos operacionais e falhas

### Práticas concretas
- **Infrastructure as Code**: CloudFormation, CDK, Terraform — sem mudanças manuais no console
- **Observability pipeline**: CloudWatch Logs → Log Groups → Metric Filters → Alarms → SNS
- **Runbooks automatizados**: AWS Systems Manager Automation Documents (SSM Automation) para tarefas repetitivas
- **CI/CD**: CodePipeline + CodeBuild + CodeDeploy para deployments consistentes e auditáveis
- **Tagging obrigatório**: Environment, Owner, CostCenter, Application em todos os recursos
- **Config Rules**: AWS Config para detectar desvios de conformidade em tempo real
- **EventBridge**: para reagir a eventos de mudança de estado de recursos automaticamente

### Perguntas de revisão (OPS)
- OPS 1: Como você determina quais são suas prioridades?
- OPS 2: Como você estrutura sua organização para suportar seus objetivos de negócio?
- OPS 3: Como você usa o design de nuvem para suportar as operações?
- OPS 4: Como você implementa mudanças?
- OPS 5: Como você evolui operações?
- OPS 6: Como você entende a saúde de suas workloads?
- OPS 7: Como você entende a saúde de suas operações?
- OPS 8: Como você gerencia eventos (problemas ou mudanças que requerem mais de uma tarefa)?
- OPS 9: Como você evolui suas operações?

---

## Pilar 2: Security

**Objetivo**: Proteger dados, sistemas e ativos, aproveitando as tecnologias de nuvem para melhorar sua postura de segurança.

### Princípios de design
- Implementar uma base de identidade forte (least privilege, separação de duties)
- Habilitar rastreabilidade (todos os logs, todas as ações)
- Aplicar segurança em todas as camadas (defense in depth)
- Automatizar as melhores práticas de segurança
- Proteger dados em trânsito e em repouso
- Manter as pessoas longe dos dados (automação sobre acesso humano direto)
- Preparar-se para eventos de segurança

### Práticas concretas
- **IAM**: Roles sobre users, políticas de least privilege, SCP em AWS Organizations
- **MFA**: Obrigatório para root e usuários privilegiados
- **CloudTrail**: Habilitado em todas as regiões, logs enviados para S3 com Object Lock
- **Security Hub**: Agrega findings do GuardDuty, Inspector, Macie, Config
- **GuardDuty**: Detecção de ameaças com ML — habilitar em todas as regiões
- **KMS**: Customer-managed keys (CMK) para dados sensíveis; rotation anual automático
- **Secrets Manager**: Rotação automática de credenciais de banco; nunca secrets em env vars de Lambda
- **VPC**: Subnets privadas para workloads, public subnets apenas para load balancers
- **WAF**: Na frente de CloudFront e ALB para proteção OWASP Top 10
- **Shield Advanced**: Para workloads críticas com proteção DDoS avançada

### Perguntas de revisão (SEC)
- SEC 1: Como você protege sua conta AWS?
- SEC 2: Como você gerencia identidades para pessoas e máquinas?
- SEC 3: Como você gerencia permissões para pessoas e máquinas?
- SEC 4: Como você detecta e investiga eventos de segurança?
- SEC 5: Como você protege seus recursos de rede?
- SEC 6: Como você protege seus recursos de computação?
- SEC 7: Como você classificar seus dados?
- SEC 8: Como você protege seus dados em repouso?
- SEC 9: Como você protege seus dados em trânsito?
- SEC 10: Como você antecipa, responde e se recupera de incidentes?

---

## Pilar 3: Reliability

**Objetivo**: Garantir que uma workload execute sua função pretendida corretamente e de forma consistente quando esperado.

### Princípios de design
- Recuperar-se automaticamente de falhas
- Testar procedimentos de recuperação
- Escalar horizontalmente para aumentar disponibilidade
- Parar de adivinhar a capacidade (auto scaling)
- Gerenciar mudanças com automação

### Práticas concretas
- **Multi-AZ**: RDS Multi-AZ, ElastiCache Multi-AZ, ALB distribuído em ≥2 AZs
- **Multi-Region**: Route 53 health checks + failover routing para aplicações críticas
- **Circuit Breaker**: Implementado na aplicação (bibliotecas como resilience4j) ou via App Mesh
- **Retries com exponential backoff**: SDK AWS já implementa por padrão — verificar customização
- **Health Checks**: ALB target group health checks, Route 53 health checks
- **Auto Scaling**: EC2 Auto Scaling Groups, Application Auto Scaling para ECS/DynamoDB/Aurora
- **SQS como buffer**: Desacopla produtores de consumidores; DLQ para mensagens com falha
- **Backups automatizados**: AWS Backup com políticas por tipo de recurso e retenção definida
- **Chaos Engineering**: AWS Fault Injection Simulator (FIS) para testar resiliência
- **Quotas**: AWS Service Quotas — monitorar e solicitar aumentos proativamente

### Definições de disponibilidade
- 99.9% = ~8.7h downtime/ano
- 99.95% = ~4.4h downtime/ano
- 99.99% = ~52min downtime/ano
- 99.999% = ~5min downtime/ano

### Perguntas de revisão (REL)
- REL 1: Como você gerencia limites de serviço?
- REL 2: Como você planeja sua topologia de rede?
- REL 3: Como você projeta sua workload para adaptar à mudanças de demanda?
- REL 4: Como você implementa fault isolation?
- REL 5: Como você projeta interações em sistemas distribuídos para prevenir falhas?
- REL 6: Como você fazes backup de dados?
- REL 7: Como você usa fault isolation para proteger sua workload?
- REL 8: Como você testa confiabilidade?
- REL 9: Como você planeja disaster recovery?

---

## Pilar 4: Performance Efficiency

**Objetivo**: Usar recursos de computação eficientemente para atender requisitos do sistema e manter essa eficiência à medida que a demanda muda e as tecnologias evoluem.

### Princípios de design
- Democratizar tecnologias avançadas (usar serviços gerenciados)
- Tornar-se global em minutos (multi-region)
- Usar arquiteturas serverless
- Experimentar com mais frequência
- Considerar afinidade mecânica (escolher o serviço certo para o trabalho)

### Práticas concretas
- **Compute**: Lambda para workloads event-driven, Fargate para containers sem gerenciamento de EC2, EC2 com Graviton3 para custo-performance (até 40% melhor que x86)
- **Memory**: ElastiCache (Redis/Memcached) para caching de dados frequentes; DAX para DynamoDB
- **Network**: CloudFront CDN para conteúdo estático; VPC endpoints para tráfego privado; Enhanced Networking (ENA) para EC2 de alta largura de banda
- **Database**: escolher o banco certo: DynamoDB para low-latency key-value, Aurora Serverless para workloads intermitentes, Redshift para analytics, OpenSearch para busca full-text
- **Benchmarking**: Load testing com Artillery/k6 antes de produção; usar AWS X-Ray para identificar gargalos
- **Instance sizing**: AWS Compute Optimizer analisa utilização e recomenda tipo correto de instância

### Perguntas de revisão (PERF)
- PERF 1: Como você seleciona as melhores soluções de computação para sua workload?
- PERF 2: Como você seleciona as melhores soluções de armazenamento para sua workload?
- PERF 3: Como você seleciona as melhores soluções de banco de dados para sua workload?
- PERF 4: Como você seleciona as melhores soluções de rede para sua workload?
- PERF 5: Como você usa tradeoffs para melhorar performance?

---

## Pilar 5: Cost Optimization

**Objetivo**: Executar sistemas para entregar valor de negócio ao menor preço possível.

### Princípios de design
- Implementar Cloud Financial Management
- Adotar um modelo de consumo (pague pelo que usa)
- Medir eficiência geral
- Parar de gastar dinheiro em trabalho pesado indiferenciado
- Analisar e atribuir despesas

### Práticas concretas
- **Savings Plans**: Commit de 1 ou 3 anos para Compute (Lambda, Fargate, EC2) — desconto de 17-66%
- **Reserved Instances**: Para RDS, ElastiCache, Redshift com uso previsível — 1 ou 3 anos
- **Spot Instances**: Para workloads tolerantes a interrupção (batch, CI/CD, ML training) — até 90% desconto
- **Auto Scaling**: Escalar para baixo em horários de baixa demanda; DynamoDB on-demand para tráfego imprevisível
- **S3 Lifecycle**: Mover objetos para S3-IA após 30 dias, Glacier após 90 dias, Glacier Deep Archive após 180 dias
- **AWS Budgets**: Alertas por serviço, tag, conta — notificação por SNS/email ao atingir thresholds
- **Cost Explorer**: Análise de tendências, Rightsizing Recommendations
- **AWS Compute Optimizer**: Identifica instâncias over-provisioned e sugere downsizing
- **Trusted Advisor**: Checa idle resources, unattached EBS volumes, unused Elastic IPs

### Perguntas de revisão (COST)
- COST 1: Como você implementa Cloud Financial Management?
- COST 2: Como você governa o uso da nuvem?
- COST 3: Como você monitora o uso e o custo da nuvem?
- COST 4: Como você descomissiona recursos?
- COST 5: Como você avalia o custo ao selecionar serviços?
- COST 6: Como você atende os requisitos de custo ao selecionar tipo e número de recursos?
- COST 7: Como você usa modelos de precificação para reduzir custos?
- COST 8: Como você planeja futuras despesas?

---

## Pilar 6: Sustainability

**Objetivo**: Minimizar o impacto ambiental das workloads em nuvem, com foco em redução de consumo de energia e aumento de eficiência.

### Princípios de design
- Entender seu impacto (baseline de consumo de energia e carbono)
- Estabelecer metas de sustentabilidade
- Maximizar utilização (consolidar cargas, eliminar idle resources)
- Antecipar e adotar nova tecnologia mais eficiente (Graviton, serverless)
- Usar serviços gerenciados (AWS gerencia a infraestrutura de forma mais eficiente)
- Reduzir o impacto downstream (minimizar dados transferidos, otimizar código)

### Práticas concretas
- **Customer Carbon Footprint Tool**: Disponível no console da AWS; relatórios de emissão por serviço
- **Graviton**: Processadores ARM com até 60% menos energia que x86 equivalente
- **Serverless**: Lambda e Fargate escalam a zero — sem compute idle
- **S3 Intelligent-Tiering**: Move objetos automaticamente entre tiers de acesso — sem armazenar dados frios em tiers quentes
- **Rightsizing**: Compute Optimizer + eliminar instâncias super-provisionadas
- **Regiões com energia renovável**: us-west-2 (Oregon), eu-west-1 (Ireland), eu-north-1 (Stockholm) usam energia 100% renovável
- **Lifecycle policies**: Deletar dados que não são mais necessários

### Perguntas de revisão (SUS)
- SUS 1: Como você seleciona regiões para suportar seus objetivos de sustentabilidade?
- SUS 2: Como você alinha a utilização com a demanda?
- SUS 3: Como você seleciona os recursos de computação mais eficientes?
- SUS 4: Como você seleciona o armazenamento mais eficiente?
- SUS 5: Como você seleciona e usa soluções de rede e data transfer eficientes?
- SUS 6: Como você escolhe e implementa padrões de código e dados eficientes?

---

## Well-Architected Tool

O AWS Well-Architected Tool (console) permite:
1. Definir workloads com informações de tecnologia e ambiente
2. Responder perguntas dos 6 pilares
3. Receber riscos identificados (HRIs - High Risk Items) com recomendações
4. Criar planos de melhoria com milestones
5. Compartilhar revisão com AWS Partner Network (APN)

Frequência recomendada: revisão a cada 6-12 meses ou após mudanças arquiteturais significativas.

## Lenses disponíveis
- Serverless Lens
- SaaS Lens
- IoT Lens
- Machine Learning Lens
- Data Analytics Lens
- Financial Services Industry Lens
- Healthcare Industry Lens
- Government Lens
