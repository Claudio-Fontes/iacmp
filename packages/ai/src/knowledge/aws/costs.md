# Modelos de Custo AWS

## Modelos de Pricing

### On-Demand
- Paga pelo que usa, sem compromisso
- Mais caro por hora — use para picos, testes, workloads imprevisíveis
- Nunca precisa de aprovação antecipada
- Cobrado por segundo (EC2, Fargate) ou por hora (RDS)

### Reserved Instances / Savings Plans
- **1 ano**: ~30–40% de desconto
- **3 anos**: ~50–60% de desconto
- **All Upfront**: maior desconto (você paga tudo na frente)
- **Partial Upfront**: pagamento dividido
- **No Upfront**: menor desconto, sem pagamento inicial

**Savings Plans** (mais flexível que Reserved Instances):
- Compute Savings Plans: se aplica a Lambda, Fargate e EC2 (qualquer tipo, região, OS)
- EC2 Instance Savings Plans: desconto maior, mas fixado a família de instância e região
- Machine Learning Savings Plans: SageMaker

Regra prática: compre Savings Plans para 70–80% do baseline, deixe o restante On-Demand.

### Spot Instances
- Até 90% de desconto
- Interrompíveis com 2 minutos de aviso
- Use para: batch processing, renderização, ML training, CI/CD runners
- Não use para: databases, APIs, qualquer workload stateful que não tolera interrupção
- Spot Fleet: mix de tipos de instância aumenta disponibilidade

---

## Custo por Serviço (referência, verifique sempre o pricing atual da AWS)

### Lambda
- Invocações: $0.20 por 1 milhão (primeiros 1M/mês gratuitos)
- Duração: $0.0000166667 por GB-segundo (primeiros 400.000 GB-segundo/mês gratuitos)
- Exemplo: função 512MB, 100ms, 1 milhão de invocações/mês = ~$0.83
- Dica: aumentar memória de 512MB para 1GB pode reduzir duração e custo total

### EC2 (referência us-east-1)
- t3.micro: ~$0.0104/hora (~$7.50/mês)
- t3.small: ~$0.0208/hora (~$15/mês)
- t3.medium: ~$0.0416/hora (~$30/mês)
- m6i.large: ~$0.096/hora (~$69/mês)
- c6i.2xlarge: ~$0.34/hora (~$245/mês)

### RDS (us-east-1, Multi-AZ dobra o custo)
- db.t3.micro MySQL/PostgreSQL Single-AZ: ~$0.017/hora (~$12/mês) + storage
- db.t3.small Single-AZ: ~$0.034/hora (~$24/mês)
- db.r6g.large Single-AZ: ~$0.21/hora (~$150/mês)
- Storage: $0.115/GB/mês (gp2), $0.125/GB/mês (gp3)
- Backups: gratuito até o tamanho do banco, depois $0.095/GB/mês

### DynamoDB
- On-Demand: $1.25 por 1M write request units, $0.25 por 1M read request units
- Provisioned: $0.00065/WCU/hora, $0.00013/RCU/hora
- Storage: $0.25/GB/mês (standard), $0.10/GB/mês (standard-IA)
- Streams: $0.02 por 100.000 read requests
- DAX (cache): db.t3.small ~$0.054/hora

### S3
- Standard storage: $0.023/GB/mês
- Standard-IA: $0.0125/GB/mês (retrieval: $0.01/GB)
- Glacier Instant: $0.004/GB/mês
- Glacier Deep Archive: $0.00099/GB/mês
- PUT/COPY/POST/LIST requests: $0.005 por 1.000
- GET/SELECT: $0.0004 por 1.000
- Data transfer out: $0.09/GB (primeiros 100GB gratuitos/mês)

### ElastiCache Redis
- cache.t3.micro: ~$0.017/hora (~$12/mês)
- cache.t3.medium: ~$0.068/hora (~$49/mês)
- cache.r6g.large: ~$0.166/hora (~$120/mês)
- Multi-AZ (replica): +50% do custo do nó primário

### API Gateway (HTTP API — mais barato que REST API)
- $1.00 por 1 milhão de requests
- REST API: $3.50 por 1 milhão de requests
- WebSocket: $1.00 por 1M de mensagens + $0.25 por 1M de minutos de conexão

### CloudFront
- Primeiros 10 TB/mês: $0.0085/GB (origens HTTP) a $0.085/GB (origens custom)
- HTTPS requests: $0.0100 por 10.000
- HTTP requests: $0.0075 por 10.000
- Free tier: 1 TB de transfer out e 10M de requests/mês

### SQS
- Standard: $0.40 por 1 milhão de requests (primeiros 1M gratuitos)
- FIFO: $0.50 por 1 milhão de requests
- Mensagem = 64KB; mensagem de 256KB cobra como 4 requests

### ECS Fargate
- vCPU: $0.04048/hora
- GB de memória: $0.004445/hora
- Exemplo: 0.5 vCPU + 1GB = $0.02024 + $0.004445 = ~$0.025/hora (~$18/mês)

### EKS
- Cluster: $0.10/hora (~$73/mês) por cluster
- Nodes: custo dos EC2/Fargate mais custo do cluster
- Fargate profile: mesmo pricing do ECS Fargate

---

## Calculadora e Ferramentas

### AWS Pricing Calculator
- calculator.aws — estime custo antes de criar recursos
- Exporte como CSV para compartilhar com times

### Cost Explorer
- Visualize custo por serviço, região, tag
- Forecasting: projeta custo dos próximos 12 meses
- Anomaly Detection: alerta em picos inesperados de custo

### Compute Optimizer
- Recomendações de right-sizing para EC2, Lambda, ECS, RDS
- Compara custo atual vs recomendado
- Gratuito (Enhanced: $0.0003360/hora por recurso analisado)

### AWS Budgets
- Budget de custo: alerta quando custo mensal supera threshold
- Budget de uso: alerta quando uso supera threshold (ex: horas EC2)
- Budget de RI/SP: coverage e utilization
- Custo: 2 budgets gratuitos, depois $0.02/budget/dia
