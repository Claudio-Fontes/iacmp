# Mensageria — SQS/SNS, Service Bus, Pub/Sub

### SQS: Standard vs FIFO, visibility timeout, DLQ, long polling

**SQS Standard**
- Entrega at-least-once: a mesma mensagem pode ser entregida mais de uma vez (deduplicação responsabilidade do consumidor)
- Ordering best-effort: sem garantia de ordem
- Throughput ilimitado (virtualmente)
- Caso de uso: workloads tolerantes a duplicatas e sem requisito de ordem (processamento de imagens, envio de email, logs)

**SQS FIFO**
- Entrega exactly-once: deduplicação por `MessageDeduplicationId` (5 minutos de janela) ou hash do corpo
- Ordering garantida por `MessageGroupId`. Mensagens com mesmo group ID processadas em ordem, grupos diferentes processados em paralelo
- Throughput: 3.000 msg/s com batching (300 sem batching), por fila. Pode ser aumentado com múltiplos `MessageGroupId`
- Sufixo obrigatório no nome: `.fifo`

**Visibility Timeout**
Período em que uma mensagem consumida fica invisível para outros consumidores. Default: 30s. Range: 0s a 12 horas. Se o processamento não deletar a mensagem dentro do timeout, ela reaparece na fila (retry automático). Chame `ChangeMessageVisibility` para estender o timeout durante processamentos longos.

**Dead-Letter Queue (DLQ)**
Fila separada para mensagens que excederam `maxReceiveCount` (número de vezes que foram recebidas sem ser deletadas). Configurar `RedrivePolicy` com `deadLetterTargetArn` e `maxReceiveCount`. DLQ deve ser do mesmo tipo que a fila de origem (Standard → Standard DLQ, FIFO → FIFO DLQ). Use CloudWatch Alarm em `ApproximateNumberOfMessagesVisible` na DLQ para alertas.

**Long Polling**
`ReceiveMessage` com `WaitTimeSeconds` até 20 segundos. Elimina polling vazio (sem mensagens disponíveis), reduz custo e latência. Short polling (WaitTimeSeconds=0) é o padrão mas desperdiça requests. Configurar `ReceiveMessageWaitTimeSeconds` na fila para forçar long polling para todos os consumers.

**Retenção de mensagens**
- Default: 4 dias
- Mínimo: 1 minuto
- Máximo: 14 dias
- Configurado via `MessageRetentionPeriod` em segundos

**Batch**
- `SendMessageBatch`: até 10 mensagens por chamada
- `ReceiveMessage`: até 10 mensagens por chamada
- `DeleteMessageBatch`: até 10 mensagens por chamada
- Payload máximo por mensagem: 256 KB

**Large Messages (S3 Extended Client)**
Para mensagens > 256 KB, use a biblioteca `amazon-sqs-extended-client` (Java/Python). O payload real é armazenado no S3, e a mensagem SQS contém a referência ao objeto S3. O consumer baixa do S3 automaticamente via SDK. Tamanho máximo limitado pelo S3 (5 TB por objeto).

### SNS: fan-out, filtros, delivery retry, DLQ, FIFO topics

**Fan-out**
SNS topic com múltiplas subscriptions (SQS, Lambda, HTTP/HTTPS, Email, SMS, mobile push). Publicação única no topic entrega para todos os subscribers simultaneamente. Desacopla produtores de consumidores — adicionar novos consumidores não requer mudança no produtor.

**Message Filter Policy**
Filtro JSON aplicado na subscription, não no topic. Reduz custo (subscriber só recebe mensagens que passam no filtro) e processamento. Exemplo: `{"type": ["order_placed", "order_cancelled"]}`. Suporta operadores `exists`, `anything-but`, ranges numéricos, prefixos de string. Filtros aplicados a atributos da mensagem (`MessageAttributes`) ou ao corpo (filter policy scope `MessageBody`).

**Delivery Retry Policy**
Para subscriptions HTTP/HTTPS: 3 tentativas imediatas → 2 com backoff de 1s → N vezes com backoff exponencial até 20s → fase linear até esgotar o total de retries. Configurável por subscription. Total de tentativas: até 100.000 com período máximo de 23 dias.

**DLQ para Subscriptions**
Configura `RedrivePolicy` na subscription (não no topic). Mensagens não entregues após todos os retries vão para a DLQ da subscription. Suportado para subscriptions SQS e Lambda.

**SNS FIFO Topics**
Ordering garantida por `MessageGroupId`. Throughput: 300 msg/s (3.000 com batching). Apenas SQS FIFO como subscriber. Deduplicação idêntica ao SQS FIFO. Sufixo `.fifo` obrigatório.

**SNS vs EventBridge**
- SNS: fan-out simples, alta throughput, subscribers limitados a SQS/Lambda/HTTP/Email/SMS/Mobile
- EventBridge: roteamento baseado em regras complexas (JSONPath), integração com +200 serviços AWS e parceiros como destino, schema registry, replay de eventos

### Service Bus Queue vs Topic: sessions, DLQ, lock duration, tiers

**Queue**
Entrega ponto-a-ponto (competing consumers). Mensagens distribuídas entre consumidores — apenas um consumer processa cada mensagem. FIFO garantido com sessions habilitadas.

**Topic + Subscription**
Entrega pub/sub: cada subscription recebe uma cópia independente das mensagens. Até 2.000 subscriptions por topic. Filtros SQL ou correlação por propriedades. Equivalente ao SNS com SQS subscribers.

**Sessions**
`SessionId` agrupa mensagens relacionadas. Apenas um consumer por vez processa mensagens de uma session (lock exclusivo). Garante FIFO por grupo de mensagens. Equivalente ao `MessageGroupId` do SQS FIFO. Habilitado via `requiresSession: true` na queue/subscription.

**Dead-Letter Queue**
Automática para cada queue/subscription. Mensagens vão para DLQ quando: `maxDeliveryCount` excedido (default: 10), TTL expirado, filtro de subscription com erro, ou explicitamente via `deadLetter()`. Acesse via path `<queue>/$DeadLetterQueue`.

**Lock Duration**
Equivalente ao visibility timeout do SQS. Range: 5s a 5 minutos (Standard tier) / até 5 minutos (Premium). Renovável via `renewMessageLock()`. Mensagem reaparece se não for completada ou abandonada dentro do lock.

**Max Delivery Count**
Número máximo de vezes que uma mensagem pode ser recebida antes de ir para DLQ. Default: 10. Configurável por queue/subscription.

**Tiers**

| Parâmetro | Basic | Standard | Premium |
|---|---|---|---|
| Queues | Sim | Sim | Sim |
| Topics/Subscriptions | Não | Sim | Sim |
| Tamanho máx mensagem | 256 KB | 256 KB | 100 MB |
| Tamanho máx fila | 1 GB | 80 GB | 1 TB |
| Sessões | Não | Sim | Sim |
| Geo-recovery | Não | Não | Sim (Geo-DR) |
| VNet integration | Não | Não | Sim (Private Endpoint) |
| Dedicated capacity | Não | Não | Sim (Messaging Units) |
| Throughput | Compartilhado | Compartilhado | Dedicado por MU |

**Messaging Units (Premium)**: unidade de capacidade dedicada. 1 MU ≈ 1 CPU + memória proporcional. Escala horizontal adicionando MUs. Necessário para SLA de latência previsível e isolamento de tenants.

### Service Bus vs Event Grid vs Event Hubs

| Critério | Service Bus | Event Grid | Event Hubs |
|---|---|---|---|
| Modelo | Mensagem (command) | Evento (notification) | Stream de dados |
| Semântica | At-least-once, exactly-once (sessions) | At-least-once | At-least-once |
| Retenção | Até 14 dias | 24 horas (retry) | 1-90 dias |
| Throughput | Milhares/s por MU | 10 milhões eventos/s | Millions/s |
| Tamanho máx payload | 100 MB (Premium) | 1 MB | 1 MB |
| Ordering | Por session | Nenhuma | Por partition |
| Caso de uso principal | Integração enterprise, workflows | Notificação de mudanças de estado (Azure resource events) | Telemetria, IoT, clickstream |
| Pull vs Push | Pull (consumer ativo) | Push (webhook/EventGrid trigger) | Pull (consumer group) |

**Quando usar Service Bus**: mensagens de comando (pedido de processamento, RPC assíncrono), integração entre sistemas heterogêneos, requisito de sessão/FIFO, dead-lettering sofisticado.

**Quando usar Event Grid**: reação a eventos de recursos Azure (blob criado, VM deletada), webhooks, fan-out leve para múltiplos handlers, baixo volume e alta variedade de eventos.

**Quando usar Event Hubs**: ingestão de alta throughput (IoT, logs, métricas, clickstream), processamento com Spark/Stream Analytics/Flink, replay de dados históricos por partition.

### GCP Pub/Sub: push vs pull, ack deadline, ordering, DLQ, seek, BigQuery subscription

**Push vs Pull**

| | Push | Pull |
|---|---|---|
| Quem inicia | Pub/Sub envia para endpoint | Consumer chama `pull` |
| Latência | Baixa (push imediato) | Depende do polling interval |
| Autenticação | Bearer token no header | SA com roles/pubsub.subscriber |
| Casos de uso | Cloud Functions, webhooks, Cloud Run | Processamento batch, múltiplos consumers, controle de rate |
| Retry automático | Sim (backoff exponencial) | Não (consumer controla retry) |

**Ack Deadline**
Tempo para o consumer fazer ack antes da mensagem ser re-entregue. Default: 10s. Range: 10s a 600s. Estenda via `modifyAckDeadline()` para processamentos longos. Subscribers pull controlam o deadline; subscribers push recebem re-entrega automática se o endpoint retornar status != 2xx.

**Ordering Keys**
`orderingKey` no PubsubMessage garante entrega em ordem para mensagens com a mesma key dentro de uma região. Requer `enableMessageOrdering: true` na subscription. Sem ordering key, sem garantia de ordem (mesmo que publicadas em sequência). Gargalo: todas mensagens com mesma key vão para o mesmo servidor de armazenamento.

**Dead-Letter Topic**
Configurado como `deadLetterPolicy` na subscription com `deadLetterTopic` e `maxDeliveryAttempts` (5 a 100). Mensagens que excedem o limite vão para o DLT. Pub/Sub cria automaticamente uma subscription no DLT para inspeção.

**Seek (Replay)**
Permite avançar ou retroceder o offset de uma subscription para um timestamp ou snapshot. Útil para reprocessar eventos após deploy com bug. `Seek(timestamp)` descarta mensagens antes do timestamp ou re-entrega mensagens após ele. Snapshots preservam o estado atual do offset.

**Snapshots**
Captura o ponto atual de uma subscription. Pode ser usado para criar nova subscription a partir de um ponto no tempo. Retém mensagens não-acked por até 7 dias.

**BigQuery Subscription**
Entrega mensagens diretamente em tabela BigQuery sem consumer intermediário. Schema Pub/Sub → BigQuery mapeado via configuração. Suporta `write_metadata` (adiciona colunas subscription_name, message_id, etc.) e `use_table_schema` (schema da tabela como contrato).

**Retenção de mensagens**
- Default: 7 dias
- Máximo: 7 dias (limite do serviço, diferente do Service Bus)
- Configurado em `messageRetentionDuration` na subscription, não no topic

### Comparativo geral entre serviços

| Parâmetro | SQS Standard | SQS FIFO | Service Bus Standard | Pub/Sub |
|---|---|---|---|---|
| Entrega | At-least-once | Exactly-once | At-least-once | At-least-once |
| Ordering | Best-effort | Por MessageGroupId | Por Session | Por OrderingKey |
| Throughput máximo | Ilimitado | 3.000/s (30.000 batching) | Compartilhado | Ilimitado |
| Retenção máxima | 14 dias | 14 dias | 14 dias | 7 dias |
| Tamanho máximo msg | 256 KB (2 GB com S3) | 256 KB | 100 MB (Premium) | 10 MB |
| DLQ nativo | Sim | Sim | Sim | Sim (Dead Letter Topic) |
| Latência | <10ms (p99) | <10ms (p99) | <10ms (p99) | <100ms |
| Replay | Não | Não | Não | Sim (Seek) |

### Padrões de mensageria

**Competing Consumers**
Múltiplos consumers lendo da mesma fila. Escala horizontal natural — adicione consumers para aumentar throughput. Cada mensagem processada por exatamente um consumer. Implementado com SQS + Auto Scaling Group de workers, Service Bus Queue com múltiplos consumers ou Pub/Sub pull subscription com múltiplas instâncias.

**Priority Queue**
Múltiplas filas com prioridades diferentes. Workers verificam fila de alta prioridade primeiro, depois média e baixa. SQS não tem prioridade nativa — use 3 filas + lógica de polling no consumer. Service Bus não tem prioridade nativa — mesma abordagem. Pub/Sub: sem suporte nativo.

**Claim-Check (Large Payload)**
Payload > limite da fila armazenado em blob storage (S3, Azure Blob, GCS). Mensagem na fila contém apenas a referência (URL ou chave). Consumer baixa o payload do storage. Evita o overhead de mensagens grandes na fila e habilita payloads até o limite do storage (5 TB). Padrão implementado nativamente pelo amazon-sqs-extended-client.

**Transactional Outbox**
Problema: gravar no banco e publicar na fila como operação atômica sem two-phase commit. Solução: gravar o evento em tabela `outbox` no mesmo banco (mesma transação que o dado de negócio). Um processo separado (poller ou CDC via Debezium) lê a tabela `outbox` e publica na fila, marcando como publicado. Garante consistência entre estado do banco e eventos publicados. Custo: latência adicional do polling (tipicamente <1s com CDC).

### Custo

**SQS**
- Standard: $0,40 por 1 milhão de requests. Cada request = até 256 KB (ou 64 KB para faturamento — mensagens maiores cobradas em chunks de 64 KB)
- FIFO: $0,50 por 1 milhão de requests (25% mais caro que Standard)
- Free tier: 1 milhão de requests/mês (permanente)
- Extended Client (S3): custo adicional de S3 GET/PUT por mensagem grande

**SNS**
- Publicação: $0,50 por 1 milhão de requests
- Entrega para SQS: gratuito (mesma conta/região)
- Entrega para Lambda: $0,20 por 1 milhão de notificações
- Entrega HTTP/HTTPS: $0,60 por 1 milhão de notificações
- SMS: $0,00645 por mensagem (EUA) — variável por país
- Email: $2,00 por 100.000 emails

**Service Bus**
- Basic: $0,05 por 1 milhão de operações
- Standard: $0,0135 por 1 milhão de operações + $10/mês por namespace
- Premium: $0,668/hora por Messaging Unit (us-east) — custo fixo independente de volume
- Operação = 1 envio ou 1 recebimento de até 64 KB (chunks de 64 KB para mensagens maiores)

**GCP Pub/Sub**
- $0,04 por GB de dados trafegados (publish + subscribe + storage)
- Free tier: 10 GB/mês
- Snapshot storage: $0,04/GB
- BigQuery subscription: custo de ingestão do BigQuery separado ($0,01/GB a partir de 1 TB/mês)
- Sem custo por mensagem — cobrança exclusivamente por volume de dados
