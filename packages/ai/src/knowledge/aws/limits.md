# Limites de Serviço AWS

## Lambda
- Timeout máximo: 15 minutos (900 segundos)
- Memória: 128 MB a 10.240 MB (10 GB)
- Payload de request/response síncrono: 6 MB
- Payload assíncrono: 256 KB
- Concorrência padrão por conta: 1.000 execuções simultâneas (pode ser aumentado via suporte)
- Concorrência reservada: pode ser definida por função, desconta do pool da conta
- Tamanho do pacote de deployment: 50 MB (zip), 250 MB descomprimido, 10 GB via container
- Variáveis de ambiente: 4 KB total
- Layers: máximo 5 por função, 250 MB total descomprimido
- Tempo de cold start típico: 100–500ms (Node.js/Python), 1–5s (Java/dotnet)

## EC2
- Limite padrão de instâncias On-Demand por família por região: varia (geralmente 5–32 vCPUs)
- Instâncias Spot: sem garantia de disponibilidade, podem ser interrompidas com 2 minutos de aviso
- EBS volume máximo: 64 TB (io2 Block Express)
- EBS IOPS máximo: 256.000 IOPS (io2 Block Express)
- Snapshots: sem limite de quantidade, cobrados por GB armazenado

## RDS
- Instâncias máximas por região: 40 (padrão), aumentável via suporte
- Máximo de conexões simultâneas: depende da instância (db.t3.micro ≈ 60–100 conexões)
- Storage máximo: 64 TB (MySQL, PostgreSQL, Oracle, SQL Server)
- Read replicas: até 5 por instância (MySQL), até 5 (PostgreSQL), até 15 (Aurora)
- Multi-AZ: failover automático em 1–2 minutos
- Backup retention: máximo 35 dias
- Automated backups: armazenados na mesma região
- Conexões recomendadas: usar RDS Proxy para Lambda (evita esgotamento de conexões)

## DynamoDB
- Tamanho máximo de item: 400 KB
- Tamanho máximo de resultado de query/scan: 1 MB por operação (paginar com LastEvaluatedKey)
- Throughput provisionado máximo por tabela: sem limite hard, mas WCU/RCU têm limites de conta
- On-demand: escala automático, custo por operação
- GSI: até 20 por tabela (padrão), até 5 LSI por tabela (definidos na criação, imutáveis)
- Atributos por item: sem limite teórico, limitado pelo tamanho de 400 KB
- Streams: retêm dados por 24 horas
- Transações: até 100 itens ou 4 MB por transação
- TTL: processamento assíncrono, deleção ocorre dentro de 48h após expiração

## S3
- Tamanho máximo de objeto: 5 TB
- Multipart upload: obrigatório para objetos >5 GB, recomendado para >100 MB
- Nome do bucket: globalmente único, 3–63 caracteres, lowercase, sem underscore
- Buckets por conta: 100 (padrão), até 1.000 via suporte
- Objetos por bucket: sem limite
- Prefixos: sem limite de profundidade, use prefixos para paralelismo de requests
- Requests por prefixo: 3.500 PUT/COPY/POST/DELETE e 5.500 GET/HEAD por segundo
- Lifecycle rules: máximo 1.000 por bucket

## API Gateway (V2 HTTP API)
- Timeout de integração: máximo 29 segundos
- Payload máximo: 10 MB
- Rate limit padrão: 10.000 requests/segundo por conta por região
- Burst limit: 5.000 requests
- Stages por API: 10
- Routes por API: 300

## SQS
- Tamanho máximo de mensagem: 256 KB (mensagens maiores usam S3 Extended Client)
- Retention máxima: 14 dias
- Visibility timeout: 0 a 12 horas (padrão: 30 segundos)
- Long polling: até 20 segundos
- Batch size: até 10 mensagens por ReceiveMessage
- FIFO: 3.000 mensagens/segundo com batching, 300 sem batching
- Standard: sem limite de throughput, pelo menos uma entrega (duplicatas possíveis)
- DLQ: configurar sempre para mensagens que falham após maxReceiveCount

## SNS
- Tamanho máximo de mensagem: 256 KB
- Subscriptions por tópico: 12.500.000
- Tópicos por conta: 100.000
- Filtros por subscription: até 200 atributos por política

## ElastiCache Redis
- Nós por cluster: até 250 (Redis Cluster Mode Enabled)
- Shards por cluster: 500
- Memória máxima por nó: depende do tipo (cache.r6g.16xlarge = 209 GB)
- Conexões por nó: depende do tipo, geralmente 65.000
- Cluster Mode Disabled: replicação, sem sharding, dados em único shard
- Cluster Mode Enabled: sharding automático, até 500 shards

## ECS / Fargate
- Tasks por serviço: sem limite hard
- CPU Fargate: 256 (.25 vCPU) a 16.384 (16 vCPU) unidades
- Memória Fargate: 512 MB a 120 GB (proporcional ao CPU)
- Timeout de health check: 300 segundos para nova task ficar healthy

## EKS
- Nodes por cluster: 5.000 (padrão)
- Pods por node: depende do tipo de instância e CNI (geralmente 29–737)
- Namespaces por cluster: sem limite hard
- Versões Kubernetes suportadas: geralmente N, N-1, N-2 versões minor

## CloudFront
- Distributions por conta: 200 (padrão)
- Origins por distribution: 25
- Behaviors por distribution: 25 (padrão), até 50 via suporte
- Cache invalidation: 3.000 paths por distribuição, primeiras 1.000/mês gratuitas
- Tamanho máximo de response: sem limite
- Timeout de origem: 30 segundos (padrão), configurável até 60s

## VPC
- VPCs por região: 5 (padrão), até 100 via suporte
- Subnets por VPC: 200
- Security groups por VPC: 500
- Regras por security group: 60 inbound + 60 outbound (padrão)
- Peering connections: transitivo não funciona — usar Transit Gateway para malhas complexas
- NAT Gateway: 45 Gbps de bandwidth por gateway
- Internet Gateway: sem limite de bandwidth, mas tem custo por transferência
