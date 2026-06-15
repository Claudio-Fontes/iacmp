# Cache Gerenciado — ElastiCache, Azure Cache for Redis, Cloud Memorystore

### Redis vs Memcached: quando usar cada um

**Redis** é a escolha padrão para a maioria dos casos de cache gerenciado. Suporta persistência (RDB snapshots + AOF), estruturas de dados ricas (strings, hashes, lists, sets, sorted sets, streams, bitmaps, HyperLogLog, geospatial), pub/sub nativo, transações (MULTI/EXEC), Lua scripting e replicação master-replica com failover automático.

**Memcached** é adequado quando: o workload é puramente cache de objetos simples (string key → blob value), a distribuição horizontal via sharding puro é preferida (sem replicação), e persistência não é necessária. Multi-threading nativo (Redis era single-threaded até 6.0 para comandos de dados). Sem suporte a cluster failover automático.

| Critério | Redis | Memcached |
|---|---|---|
| Persistência | RDB + AOF | Nenhuma |
| Estruturas de dados | Ricas (sorted sets, streams, etc.) | Apenas strings/blobs |
| Pub/Sub | Nativo | Ausente |
| Clustering | Cluster Mode com hash slots | Sharding client-side |
| Replicação | Master-replica automática | Ausente |
| Failover automático | Sim (Sentinel / Cluster) | Não |
| Multi-threading | I/O threads (v6+), comandos ainda single-thread | Multi-thread nativo |
| Casos de uso | Sessions, leaderboards, rate limiting, filas, cache complexo | Cache de objetos simples de alta escala |

**Escolha Memcached quando**: você precisa escalar horizontalmente com sharding simples, não precisa de persistência ou replicação, e o workload é cache de objetos grandes (até 1 MB por item vs 512 MB no Redis).

### ElastiCache Redis: cluster mode, replication group, Multi-AZ, Global Datastore

**Replication Group (Cluster Mode Disabled)**
- 1 primary + até 5 replicas na mesma região
- Shard único — todo o keyspace em um nó
- Escala vertical (resize do nó) ou adição de replicas para leitura
- Failover automático promove replica a primary em ~30-60s com Multi-AZ habilitado

**Cluster Mode Enabled**
- Até 500 shards, cada shard com 1 primary + até 5 replicas
- Hash slots distribuídos entre shards (16.384 slots totais)
- Escala horizontal: adicionar shards redistribui slots online (online resharding)
- Comandos cross-slot (ex: `MGET` com keys em shards diferentes) não são suportados sem hash tags `{tag}`
- Requisita client com suporte a cluster (ioredis, redis-py com cluster=True)

**Multi-AZ**: replicas em AZs diferentes. Failover automático (AutomaticFailoverEnabled) promove a replica com menor lag. Sem Multi-AZ, failover requer intervenção manual.

**Global Datastore**: replicação assíncrona entre regiões (até 2 secondary clusters). RPO de segundos. Permite leituras locais em cada região. Failover regional manual (promote secondary). Suporte apenas para Cluster Mode Disabled ou Cluster Mode Enabled com engine >= 6.2.

**Engine versions relevantes**:
- 6.x: RBAC (usuários e ACLs em vez de senha única), I/O threads, lazy freeing
- 7.0: Redis Functions (substitui Lua eval), sharded pub/sub, multi-part AOF
- 7.1/7.2: ACL logging melhorado, client-no-touch

### Azure Cache for Redis: tiers, Active Geo-Replication, Private Link

| Tier | Memória máx | Clustering | Geo-replication | SLA |
|---|---|---|---|---|
| Basic | 53 GB | Não | Não | Sem SLA |
| Standard | 53 GB | Não | Passive (replicação regional passiva) | 99,9% |
| Premium | 1,2 TB | Sim (10 shards) | Active (Enterprise only na verdade é passive no Premium) | 99,9% |
| Enterprise | 2 TB+ | Sim | Active Geo-Replication | 99,9% |
| Enterprise Flash | 13 TB+ (NVMe) | Sim | Active Geo-Replication | 99,9% |

**Active Geo-Replication (Enterprise tier)**: replicação multi-write entre até 5 regiões. Conflitos resolvidos por last-write-wins (baseado em timestamp do cliente). Latência de replicação em dezenas de milissegundos. Requer Redis Enterprise (não Redis OSS).

**Passive Geo-Replication (Premium tier)**: replica de leitura em outra região. Replicação assíncrona unidirecional. Failover manual via promote.

**Private Link**: acesso ao cache via endpoint privado na VNet, sem exposição à internet. Recomendado para produção. Bloqueia acesso público com `publicNetworkAccess: Disabled`.

**VNet Injection (Premium)**: instância implantada dentro da VNet do cliente. Alternativa ao Private Link — mais isolamento mas menos flexível para conexões entre VNets.

**Persistence (Premium)**: RDB (snapshots a cada 15min/30min/1h/6h/12h) ou AOF (cada segundo ou a cada write). AOF dobra IOPS mas garante RPO de 1 segundo.

### Cloud Memorystore: Redis e Memcached, Standard tier

**Memorystore for Redis**
- Basic tier: instância única sem replicação, sem SLA de disponibilidade
- Standard tier: replica em zona diferente, failover automático (~30s), SLA 99,9%
- Versões suportadas: Redis 6.x, 7.x
- Capacidade: 1 GB a 300 GB por instância
- Sem clustering nativo — escala vertical apenas. Para sharding, múltiplas instâncias com client-side routing
- Conectividade exclusivamente via VPC (sem endpoint público) — acesso de fora da VPC requer VPC peering ou Serverless VPC Access

**Memorystore for Memcached**
- Cluster de 1 a 20 nós, cada nó de 1 a 32 GB
- Capacidade total até 640 GB por cluster
- Sharding automático gerenciado pelo serviço
- Sem replicação, sem failover automático

**Memorystore for Redis Cluster (GA 2024)**
- Modo cluster horizontal (até 5 primary shards em preview, mais em GA)
- Hash slots distribuídos como Redis Cluster OSS
- Alta disponibilidade com réplicas por shard

**Limitações Memorystore vs ElastiCache**:
- Sem Global Datastore equivalente (replicação multi-região)
- Sem suporte nativo a RBAC (controle de acesso via IAM, não Redis ACL)
- Rede exclusivamente privada (sem endpoint público disponível)

### Padrões de cache

**Cache-aside (Lazy Loading)**
Aplicação busca no cache → miss → busca no banco → escreve no cache → retorna. Implementação mais comum. Dados no cache são sempre resultado de um miss anterior. Risco: thundering herd no cold start (múltiplos misses simultâneos para mesma chave — use mutex/lock distribuído com `SET key value NX EX`).

**Read-through**
O cliente lê apenas do cache. Em caso de miss, o cache engine busca no banco automaticamente. Requer plugin ou proxy (ex: AWS DAX para DynamoDB). Simplifica o cliente mas adiciona latência na cadeia.

**Write-through**
Escrita simultânea no cache e no banco (sincrona). Garante consistência. Custo: toda escrita passa pelo cache mesmo que a chave nunca seja lida. Combina com TTL para evitar dados obsoletos.

**Write-behind (Write-back)**
Escrita no cache imediata, flush para banco assíncrono em batch. Maximiza throughput de escrita. Risco de perda de dados se o cache falhar antes do flush. Adequado para contadores e métricas onde perda pontual é aceitável.

**TTL Strategy**
- TTL fixo: simples, previsível. Risco de cache stampede quando muitas chaves expiram simultaneamente (use jitter: `TTL = base + random(0, base*0.1)`).
- TTL deslizante: refresh do TTL a cada leitura. Mantém dados quentes indefinidamente. Não protege contra dados stale.
- Refresh-ahead: background job renova cache antes do TTL expirar. Complexidade adicional mas elimina miss latency.

### Eviction policies

| Policy | Comportamento | Quando usar |
|---|---|---|
| `noeviction` | Retorna erro ao tentar escrever com memória cheia | Quando perda de dados é inaceitável; requer monitoramento de uso |
| `allkeys-lru` | Remove a key menos recentemente usada de todas as keys | Cache genérico — o mais comum para cache-aside |
| `volatile-lru` | LRU apenas entre keys com TTL definido | Misto de cache e dados persistentes sem TTL |
| `allkeys-lfu` | Remove a key menos frequentemente usada (Redis 4+) | Workloads com hot keys muito acessadas e cold keys irrelevantes |
| `volatile-lfu` | LFU apenas entre keys com TTL | Similar ao volatile-lru mas por frequência |
| `allkeys-random` | Remove key aleatória | Raramente adequado — preferir LRU |
| `volatile-random` | Random entre keys com TTL | Raramente adequado |
| `volatile-ttl` | Remove keys com menor TTL restante | Quando keys mais antigas devem ser evicted primeiro |

**Recomendação prática**: `allkeys-lru` para cache puro. `noeviction` para filas e dados críticos (Redis como broker). `volatile-lru` quando Redis armazena tanto dados com TTL (cache) quanto dados permanentes (sessions com TTL explícito de logout).

### Segurança

**TLS in-transit**
- ElastiCache: TLS habilitado no parâmetro `transit-encryption-enabled`. Requer certificado no cliente. Porta padrão com TLS: 6380.
- Azure Cache for Redis: TLS 1.2 obrigatório por padrão (TLS 1.0/1.1 desabilitados). Porta 6380 (TLS) vs 6379 (sem TLS, desabilitar em produção).
- Memorystore: TLS configurável, acesso apenas via VPC (sem TLS necessário para tráfego interno mas recomendado).

**Autenticação**
- Redis AUTH (senha única): legado, sem granularidade de permissões.
- ElastiCache RBAC: usuários, grupos de usuários, ACL por comando e keyspace. Recomendado para ElastiCache >= 6.x.
- IAM Auth (ElastiCache Serverless e clusters com IAM Auth habilitado): token IAM de curta duração como senha Redis. Elimina rotação manual de senha.
- Azure Key Vault: armazene a access key do Azure Cache no Key Vault, nunca hardcoded.
- Memorystore: autenticação via string AUTH, sem RBAC nativo — controle de acesso via IAM para operações de gerenciamento, não para conexões Redis.

**Network isolation**
- ElastiCache: sempre em VPC. Security groups controlam acesso. Sem endpoint público.
- Azure Cache for Redis: Private Endpoint (recomendado) ou VNet Injection (Premium). Desabilitar acesso público.
- Memorystore: exclusivamente via VPC privada. Sem endpoint público disponível.

**Encryption at rest**
- ElastiCache: KMS-managed encryption para dados em disco (snapshots RDB/AOF e swap). Habilitado com `at-rest-encryption-enabled`.
- Azure Cache for Redis: criptografia de dados em disco habilitada por padrão para tiers Premium+.
- Memorystore: criptografia em disco via CMEK (Cloud KMS) para instâncias Standard tier.

### Sizing

**Regra de thumb — hot data**
Em datasets com distribuição Pareto (80/20), 20% das chaves recebem 80% dos acessos. Dimensione o cache para conter os 20% mais acessados do dataset total. Para datasets de 100 GB, cache de 20 GB com `allkeys-lru` captura a maioria dos hits.

**Memory overhead do Redis (~30%)**
Redis não armazena apenas o valor. Cada key consome: 64 bytes de overhead de objeto + tamanho da key + tamanho do valor + encoding específico da estrutura. Para strings pequenas (<44 bytes), Redis usa `embstr` (inline no objeto, mais eficiente). Strings maiores usam `raw` (alocação separada).

Overhead estimado:
- 1 milhão de chaves string de 100 bytes: ~130-140 MB (vs 100 MB de dados brutos)
- Hash com muitos campos pequenos: mais eficiente que keys separadas (Redis usa ziplist/listpack abaixo de 128 campos e 64 bytes/valor)
- Monitore `used_memory` vs `used_memory_rss` — diferença alta indica fragmentação de memória (use `MEMORY PURGE` ou defragmentação ativa no Redis 4+)

**ElastiCache node sizing**
- `cache.r7g.large`: 13.07 GB, 2 vCPUs — ponto de partida para produção
- `cache.r7g.xlarge`: 26.32 GB, 4 vCPUs
- Prefira `r`-family (memory optimized) sobre `m`-family para Redis
- Graviton3 (r7g) tem melhor custo/GB que x86 (r6g → r7g, ~10-15% melhor throughput)

**Métricas para dimensionamento**
- `CacheHitRate` < 95%: dataset maior que cache ou TTLs muito curtos
- `Evictions` > 0 com `allkeys-lru`: cache cheio, considere escalar
- `SwapUsage` > 50 MB: memória física insuficiente, instância maior necessária
- `CPUUtilization` > 70% (ElastiCache): gargalo de CPU — vertical scale ou read replicas

### Custo: ElastiCache vs ElastiCache Serverless

**ElastiCache (instâncias provisionadas)**
- Preço por hora por nó. Ex: `cache.r7g.large` em us-east-1: ~$0,166/hora (~$120/mês)
- Reserved Instances: até 55% de desconto com 1 ano all upfront, até 65% com 3 anos
- Data transfer: intra-AZ gratuito, cross-AZ $0,01/GB (evite cross-AZ entre app e cache)

**ElastiCache Serverless**
- Cobrança por ECU (ElastiCache Compute Unit) e GB de dados armazenados
- ECU: ~$0,034/hora por ECU. 1 ECU ≈ capacidade para ~1.000 req/s simples
- Armazenamento: $0,125/GB-hora
- Custo efetivo para baixo uso: mais alto que instância provisionada pequena
- Custo efetivo para carga variável: elimina over-provisioning. Break-even vs r7g.large ~30-40% de utilização média
- Sem gerenciamento de cluster, shards ou replication groups — escala automática

**Comparativo 10 GB cache**

| Serviço | Config | Custo estimado/mês |
|---|---|---|
| ElastiCache Redis | cache.r7g.large (13GB) On-Demand | ~$120 |
| ElastiCache Redis | cache.r7g.large 1yr Reserved | ~$55 |
| ElastiCache Serverless | 10 GB armazenado + uso moderado | ~$80-150 (variável) |
| Azure Cache for Redis | C2 Standard (6GB) | ~$100 |
| Azure Cache for Redis | P1 Premium (6GB) | ~$300 |
| Memorystore Redis | Standard 10GB (us-central1) | ~$130 |

Preços aproximados, variam por região e data. Consulte calculadoras oficiais para estimativas precisas.
