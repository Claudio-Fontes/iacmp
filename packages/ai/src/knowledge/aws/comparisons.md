# Quando Usar Qual Serviço AWS

## Filas e Mensageria: SQS vs SNS vs EventBridge vs Kinesis

### SQS (Simple Queue Service)
Use quando: processamento assíncrono ponto-a-ponto, workers que consomem tarefas
- Modelo: pull (consumer busca mensagens)
- Garantia: pelo menos uma entrega (Standard), exatamente uma (FIFO)
- Casos de uso: jobs em background, desacoplamento de microserviços, processamento de pedidos
- FIFO: quando a ordem importa (ex: transações financeiras)
- Standard: quando volume alto importa mais que ordem (ex: notificações, logs)

### SNS (Simple Notification Service)
Use quando: fan-out (um evento → múltiplos consumidores)
- Modelo: push (SNS entrega para subscribers)
- Casos de uso: notificações por email/SMS, fan-out para múltiplas filas SQS, alertas
- Padrão comum: SNS → múltiplas SQS (fan-out + durabilidade)

### EventBridge
Use quando: roteamento de eventos com filtros complexos, integração entre serviços AWS, eventos externos (SaaS)
- Modelo: event bus com regras de roteamento
- Diferencial: schema registry, integração nativa com 100+ serviços AWS e parceiros SaaS (Shopify, Zendesk, etc.)
- Casos de uso: arquitetura event-driven, orquestração entre serviços, auditoria
- Preferir sobre SNS quando: filtros por conteúdo do evento (não só por tipo), múltiplos targets com regras diferentes

### Kinesis Data Streams
Use quando: streaming de dados em tempo real, alta vazão, replay de eventos
- Modelo: streaming particionado (shards)
- Diferencial: retenção de até 365 dias, replay, múltiplos consumers simultâneos, ordering por partition key
- Casos de uso: analytics em tempo real, ingestão de logs, streaming de eventos de IoT
- Custo: por shard-hora (sempre ativo), mais caro que SQS para volumes baixos

### Resumo rápido
| Precisa de... | Use |
|---|---|
| Fila simples entre dois serviços | SQS Standard |
| Fila com ordem garantida | SQS FIFO |
| Notificar múltiplos serviços de uma vez | SNS |
| Roteamento por conteúdo do evento | EventBridge |
| Streaming de alta vazão com replay | Kinesis |

---

## Banco de Dados: RDS vs Aurora vs DynamoDB vs ElastiCache

### RDS (MySQL / PostgreSQL)
Use quando: dados relacionais, queries SQL complexas, aplicações existentes
- Instâncias gerenciadas: você escolhe o tipo, AWS gerencia OS e patches
- Multi-AZ: failover automático para replica síncrona em outra AZ
- Read replicas: até 5 assíncronas para escalar leituras
- Limite: vertical (escala o tipo de instância), não horizontal

### Aurora
Use quando: precisa de MySQL/PostgreSQL com maior performance e disponibilidade
- 5x mais rápido que MySQL RDS, 3x mais que PostgreSQL RDS (benchmark AWS)
- Storage: auto-scaling até 128 TB, replicado 6 vezes em 3 AZs automaticamente
- Aurora Serverless v2: escala de 0.5 a 128 ACUs automaticamente — bom para carga variável
- Aurora Global Database: replicação cross-region com latência <1 segundo
- Custo: mais caro que RDS, justificado para alta disponibilidade e volume

### DynamoDB
Use quando: escala massiva, latência <10ms, padrão de acesso previsível
- NoSQL chave-valor / documento
- Escala horizontal automaticamente (on-demand)
- Acesso por chave primária é O(1) e consistente
- Ruim para: queries ad-hoc, JOINs, agregações complexas
- GSI: permite acesso por outros atributos, mas adiciona custo e latência
- Ideal para: carrinhos de compra, sessões, perfis de usuário, IoT, leaderboards

### ElastiCache Redis
Use quando: cache de dados lidos com frequência, sessões, leaderboards, pub/sub
- Sub-milissegundo de latência
- Estruturas de dados ricas: strings, hashes, lists, sets, sorted sets, streams
- Persistence: RDB (snapshots) e AOF (append-only file)
- Cluster Mode: sharding para datasets maiores que um nó
- Casos de uso: cache de queries SQL lentas, sessões de usuário, rate limiting, filas

### ElastiCache Memcached
Use quando: cache simples, sem necessidade de persistence ou estruturas complexas
- Mais simples que Redis: só key-value strings
- Multi-threaded: melhor uso de múltiplos cores
- Sem persistence, sem replicação
- Use Redis se tiver dúvida — é mais completo

---

## Compute: EC2 vs Lambda vs ECS vs EKS

### EC2
Use quando: controle total do ambiente, apps stateful, necessidade de GPU, licenças por socket/core
- Você gerencia: OS, patches, capacidade, configuração
- Ideal para: bancos de dados self-managed, apps legadas, HPC, ML training

### Lambda
Use quando: funções curtas, event-driven, carga variável ou esporádica
- Zero administração de servidor
- Paga por invocação e duração (sem custo em idle)
- Ruim para: processos longos (>15min), conexões persistentes de banco, cold start sensível
- Ideal para: APIs, processamento de eventos, scheduled tasks, webhooks

### ECS com Fargate
Use quando: containers sem gerenciar servidores, microserviços, APIs de alta disponibilidade
- Fargate: sem nodes para gerenciar, paga por task
- EC2 launch type: mais controle, melhor custo em uso constante
- Ideal para: APIs containerizadas, microserviços, workers de longa duração

### EKS (Kubernetes)
Use quando: times com expertise em Kubernetes, portabilidade multi-cloud, ecossistema K8s
- Mais complexo para operar que ECS
- Vantagem: padrão da indústria, ecossistema massivo (Helm, Argo, Istio)
- Ideal para: organizações grandes, apps que rodam em múltiplos clouds

---

## Storage: S3 vs EFS vs EBS

### S3 (Object Storage)
- Objetos imutáveis, acesso via HTTP
- Ideal para: backups, assets estáticos, data lake, logs, imagens
- Não é um filesystem — não monte em EC2 (use EFS para isso)
- Custo mais baixo por GB entre os três

### EFS (Elastic File System)
- Filesystem NFS compartilhado, montável em múltiplas instâncias
- Ideal para: dados compartilhados entre múltiplas tasks/instâncias (uploads, cache compartilhado)
- Integra com Lambda, ECS, EKS
- Custo: mais caro que S3, mais barato que manter NFS próprio

### EBS (Elastic Block Store)
- Block storage, montável em uma única instância EC2
- Ideal para: volume de boot, banco de dados em EC2, apps que precisam de filesystem local
- Alta IOPS com io2 Block Express (até 256.000 IOPS)
- Não compartilhável entre instâncias (exceto multi-attach, limitado)

---

## Load Balancer: ALB vs NLB vs CLB

### ALB (Application Load Balancer)
- Layer 7 (HTTP/HTTPS/WebSocket)
- Roteamento por path (/api/* → serviço A, /static/* → serviço B), host, headers, query string
- Integração nativa com ECS, Lambda, Cognito, WAF
- Use para: APIs HTTP, microserviços, WebSockets

### NLB (Network Load Balancer)
- Layer 4 (TCP/UDP/TLS)
- Latência ultra-baixa (<1ms), preserva IP de origem
- Suporta IPs estáticos e Elastic IPs por AZ
- Use para: protocolos não-HTTP, VoIP, gaming, alta performance, VPN endpoints

### CLB (Classic Load Balancer)
- Legado — não use para novas arquiteturas
- Prefira sempre ALB ou NLB
