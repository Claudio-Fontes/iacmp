# Padrões de Arquitetura Cloud-Agnósticos

## Padrões de Resiliência

### Circuit Breaker
Evita cascata de falhas quando um serviço downstream está lento ou falhando.

Funcionamento:
- Closed: chamadas normais
- Open: após N falhas consecutivas, para de chamar o serviço downstream por T segundos
- Half-Open: testa uma chamada — se suceder, fecha; se falhar, volta para Open

Implementação:
- AWS: AWS App Mesh com Envoy proxy, ou bibliotecas como Resilience4j
- Azure: Azure Service Fabric com políticas de retry, ou Polly library
- GCP: Cloud Service Mesh (Istio), ou Traffic Director
- Código: use sempre uma biblioteca (Opossum para Node.js, Resilience4j para Java)

Quando usar: chamadas síncronas entre microserviços, integrações com APIs de terceiros

---

### Retry com Exponential Backoff e Jitter
Retentar falhas transitórias com intervalo crescente para evitar thundering herd.

Fórmula: `delay = min(cap, base * 2^attempt) + random(0, jitter)`

Exemplo (base=100ms, cap=10s, jitter=±20%):
- Tentativa 1: 100ms ± 20ms
- Tentativa 2: 200ms ± 40ms
- Tentativa 3: 400ms ± 80ms
- ...
- Tentativa 7+: ~10s ± 2s

O que retornar antes de retornar: erros 5xx, timeouts de rede, throttling (429)
O que NÃO retornar: erros 4xx (exceto 429), erros de validação, autenticação

Implementação nos SDKs AWS:
- SDK v3 tem retry automático com backoff (configurável via `maxRetries`)
- Padrão: 3 retries com exponential backoff

---

### Bulkhead (Isolamento de Recursos)
Divide recursos em pools separados para falhas em uma área não afetar outras.

Exemplo: pool separado de threads para chamadas a serviço A vs serviço B
Se serviço A trava, as threads do serviço B continuam disponíveis.

Implementação cloud:
- Lambda: concorrência reservada por função (não consome pool geral)
- ECS: tasks separadas por serviço, sem partilha de resources
- DynamoDB: tabelas separadas por workload (não misture transacional com analytics)

---

### Idempotência
Operações que podem ser reenviadas múltiplas vezes sem efeitos colaterais.

Implementação:
- HTTP: use idempotency keys no header (Stripe, PayPal usam este padrão)
- SQS: processe com base em message ID — guarde IDs processados no DynamoDB com TTL
- Lambda: sempre projete como se a função pudesse ser invocada duas vezes
- DynamoDB: use `ConditionExpression` para operações condicionais (ex: só insere se não existir)

---

## Padrões de Dados

### CQRS (Command Query Responsibility Segregation)
Separa operações de escrita (commands) e leitura (queries) em modelos distintos.

Quando usar: quando leituras e escritas têm padrões de acesso muito diferentes, ou quando o modelo de leitura precisa ser desnormalizado para performance.

Implementação típica:
```
Write side: API → Command Handler → Aggregate → Event Store (DynamoDB/EventBridge)
Read side:  Event Handler → Read Model (ElastiCache/RDS read replica) → Query API
```

---

### Event Sourcing
Armazena o histórico de eventos em vez do estado atual. O estado é derivado reproduzindo os eventos.

Benefícios: audit trail completo, replay de eventos, temporal queries, debug facilitado
Desafios: complexidade, eventual consistency, snapshots necessários para performance

Implementação na AWS:
- Event store: DynamoDB (partitionKey=aggregateId, sortKey=eventId/timestamp)
- Projections: Lambda consumindo DynamoDB Streams
- Snapshots: DynamoDB com versão do snapshot para evitar replay completo

---

### Saga Pattern
Coordena transações distribuídas entre múltiplos serviços sem 2-phase commit.

Dois tipos:
1. **Choreography**: cada serviço publica evento ao completar, próximo serviço consome
   - Simples, desacoplado, mas difícil de rastrear
2. **Orchestration**: orquestrador central (Step Functions) coordena os serviços
   - Mais visível e controlável, mas acoplamento ao orquestrador

Compensating transactions: cada step deve ter um rollback (ex: se pagamento falha, cancela reserva)

Implementação na AWS: Step Functions para orchestration, EventBridge + Lambda para choreography

---

### Database per Service
Cada microserviço tem seu próprio banco de dados — nunca compartilhe.

Benefícios: independência de schema, tecnologia adequada por serviço, deploy independente
Desafios: consistência eventual entre serviços, queries cross-service via API

Exemplo por tipo de serviço:
- Carrinho de compras: Redis (TTL, rapidez)
- Catálogo de produtos: Elasticsearch ou DynamoDB (busca, leitura intensiva)
- Pedidos: PostgreSQL (transações ACID, auditoria)
- Histórico de eventos: Kinesis + S3 (volume, analytics)

---

## Padrões de Integração

### Strangler Fig
Migra um sistema legado incrementalmente substituindo partes por novos serviços.

Implementação:
1. Coloca um proxy (ALB/API Gateway) na frente do sistema legado
2. Redireciona rotas específicas para novos microserviços conforme ficam prontos
3. Quando todo o tráfego foi migrado, descomissiona o legado

Riscos a gerenciar: sincronização de dados entre legado e novo serviço durante a transição

---

### Anti-Corruption Layer (ACL)
Camada de tradução entre dois sistemas com modelos de domínio diferentes.

Uso comum: integração com APIs de terceiros (Stripe, Shopify, TOTVS) — não exponha o modelo externo direto no seu domínio.

---

### Sidecar
Funcionalidade auxiliar roda em container/processo separado ao lado do container principal.

Exemplos: proxy de service mesh (Envoy), coleta de logs (Fluent Bit), coleta de métricas (CloudWatch agent)

Implementação:
- ECS: task com múltiplos containers (main + sidecar)
- EKS: pods com múltiplos containers
- Lambda: Lambda Extensions para funcionalidades auxiliares

---

## Padrões de Deployment

### Blue/Green Deployment
Mantém dois ambientes idênticos, alterna o tráfego entre eles.

Implementação:
- ECS: deployment controller Blue/Green com CodeDeploy
- Lambda: alias com pesos (10% para nova versão → 100%)
- API Gateway: canary deployments com pesos por stage
- Route53: weighted routing entre dois endpoints

Vantagem: rollback instantâneo (redireciona tráfego de volta)
Desvantagem: custo de manter dois ambientes completos

---

### Canary Release
Libera nova versão para pequeno percentual de usuários antes do rollout completo.

Percentuais típicos: 1% → 5% → 20% → 50% → 100%
Métricas para monitorar: error rate, latência p99, métricas de negócio

Implementação AWS:
- Lambda weighted aliases
- API Gateway canary settings
- CodeDeploy com bake time e CloudWatch alarms

---

## Observabilidade

### Os Três Pilares

**Métricas**: valores numéricos agregados no tempo
- O que: latência (p50/p95/p99), taxa de erros (%), throughput (req/s), saturação (CPU/memory %)
- Quando alertar: use p95 ou p99, não p50 — median esconde degradação para parte dos usuários
- AWS: CloudWatch Metrics, Embedded Metrics Format (EMF) para métricas de Lambda

**Logs**: eventos discretos e contextualizados
- Estruture em JSON: facilita busca e correlação
- Inclua sempre: request ID, user ID (anonimizado), trace ID, duration, error
- Nível: ERROR para problemas, WARN para situações inesperadas mas recuperáveis, INFO para fluxo normal
- AWS: CloudWatch Logs, Insights para queries, Contributor Insights para top N

**Traces**: rastreamento de uma request através de múltiplos serviços
- Propagação: passe sempre o trace ID via header (X-Amzn-Trace-Id, W3C traceparent)
- AWS: X-Ray para Lambda, ECS, API Gateway
- Ferramentas: Jaeger, Zipkin, OpenTelemetry (padrão aberto, compatível com AWS/Azure/GCP)

### RED Method (para serviços)
- **R**ate: quantas requests por segundo
- **E**rrors: quantas requests falhando
- **D**uration: quanto tempo levam

### USE Method (para recursos)
- **U**tilization: % do recurso em uso
- **S**aturation: fila de trabalho pendente
- **E**rrors: contagem de erros do recurso

---

## FinOps — Otimização de Custo

### Dimensionamento Correto
- Lambda: memória mais alta = CPU mais alta = execução mais rápida = custo total pode cair
- Ferramenta: AWS Lambda Power Tuning (encontra melhor relação memória×custo)
- EC2: use Compute Optimizer, revise mensalmente
- RDS: comece pequeno (db.t3.micro) e monitore — é fácil escalar, difícil desescalar sem downtime

### Instâncias Reservadas e Savings Plans
- Reserved Instances: 1 ou 3 anos, 30–60% de desconto, compromisso por tipo de instância
- Savings Plans: mais flexível (por vCPU/hora independente de tipo), 20–66% de desconto
- Regra: use On-Demand para burst, Reserved/Savings Plans para baseline previsível, Spot para batch

### Transferência de Dados (o custo escondido)
- Ingress: gratuito
- Egress para internet: ~$0.08/GB (AWS), varia por região
- Cross-AZ: ~$0.01/GB por cada lado (source + destination)
- Cross-region: ~$0.02–0.09/GB
- VPC Endpoints: elimina custo de NAT Gateway + custo de egress para S3/DynamoDB

### Tags de Custo
- Tague todos os recursos: `Environment`, `Team`, `Project`, `CostCenter`
- AWS Cost Explorer: agrupe por tag para ver custo por time/projeto
- Budget Alerts: configure para alertar quando custo ultrapassa threshold
