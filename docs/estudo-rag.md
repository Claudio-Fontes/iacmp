# RAG no iacmp — Arquitetura (estado atual)

> Este documento descreve a **arquitetura do RAG já existente** no `@iacmp/ai`.
> Os arquivos listados em "Arquivos a criar / modificar" e as "Fases" abaixo
> são preservados como histórico do plano original — boa parte deles já está
> implementada (`packages/ai/src/rag/`, `packages/ai/src/knowledge/`,
> `packages/ai/src/tools/context-reader.ts`). Para o que ainda falta, veja a
> seção [Próximos passos](#proximos-passos) no fim do arquivo.

## O problema concreto

O `context-reader.ts` hoje injeta **todo o conteúdo** das stacks no system prompt a cada mensagem.
Isso funciona para projetos pequenos (5–10 stacks), mas tem três limites claros:

1. **Projeto grande** — 30+ stacks injetam >100 KB de TypeScript em cada chamada. Tokens sobem, latência sobe, custo sobe.
2. **Documentação de constructs** — o `system-prompt.ts` já tem ~8 KB de docs. Vai crescer. Jogar tudo sempre é desperdício.
3. **Conhecimento de plataforma** — hoje o model responde sobre AWS/Azure/GCP só com o que tem no treinamento. Informações desatualizadas, limites de serviço errados, novos recursos que o model não conhece.

O RAG resolve os três via **busca semântica antes de montar o prompt**: em vez de injetar tudo, injeta só o que é relevante para a pergunta atual. Com fontes externas ao vivo, o conhecimento nunca fica desatualizado.

---

## Os quatro corpora

O RAG do iacmp tem fontes de natureza completamente diferente. Cada uma tem ciclo de vida e estratégia de indexação própria.

---

### Corpus 1 — Stacks do projeto (dinâmico, por projeto)

O que o usuário já criou. Contexto imediato da conversa.

- Cada arquivo `.ts` dentro de `stacks/` vira chunks por construct
- Metadados: `{ file, stackName, constructType, constructId }`
- Índice fica em `.iacmp/rag-index.json` (local por projeto)
- Reconstruído quando stacks mudam (usa o `hashProject` do `session-store.ts`)
- Volume típico: 50–500 chunks por projeto

Exemplo de chunk:
```
[construct] Database.DynamoDB "UserTable" em stacks/database/user-stack.ts
partitionKey: userId, sortKey: createdAt, billingMode: PAY_PER_REQUEST,
streamEnabled: true, GSI: EmailIndex
```

---

### Corpus 2 — Documentação de constructs do iacmp (estático, embutido no CLI)

O que o iacmp sabe fazer. A API dos constructs.

- Cada seção do `system-prompt.ts` vira um chunk (um construct por chunk)
- Índice gerado em build-time e empacotado dentro do `@iacmp/ai`
- Nunca muda em runtime — atualiza só quando o CLI atualiza
- Volume: ~50–80 chunks (um por construct)

Responde perguntas como: "quais props aceita o Network.LoadBalancer?" ou "como configuro retenção no Logging.Stream?"

---

### Corpus 3 — Conhecimento de plataforma curado (estático, atualizado periodicamente)

O que AWS, Azure e GCP sabem fazer. Base de conhecimento de infraestrutura indexada localmente.

Este corpus é a fundação de qualidade das respostas — limites de serviço, padrões de arquitetura, comparações, gotchas conhecidos.

**Conteúdo indexado:**

#### AWS
- Limites de serviço por recurso (Lambda: 15min timeout, 10GB memória, 1000 concorrência padrão etc.)
- Arquiteturas de referência (3-tier, serverless, microservices, data lake, event-driven)
- Comparações entre serviços similares (SQS vs SNS vs EventBridge vs Kinesis — quando usar cada)
- Preços e modelos de custo por serviço (on-demand vs reserved vs spot)
- Restrições e gotchas conhecidos (RDS em VPC exige subnet group, S3 bucket name é global, etc.)
- Well-Architected Framework: os 6 pilares com práticas por pilar
- Padrões de segurança: least privilege, VPC design, encryption at rest/transit

#### Azure
- Equivalências com AWS (RDS → Azure SQL / Flexible Server, Lambda → Functions, S3 → Blob Storage)
- Hierarquia de recursos (Subscription → Resource Group → Resource)
- Modelos de rede (VNet, Subnet, NSG, Private Endpoint, Service Endpoint)
- Managed Identity vs Service Principal
- Arquiteturas de referência do Azure Architecture Center

#### GCP
- Equivalências com AWS e Azure
- Modelo de IAM (diferente dos dois outros: roles no projeto, não por recurso)
- Serviços sem equivalente direto (Spanner, BigQuery, Dataflow)
- Arquiteturas de referência do Google Cloud

#### Transversal
- Padrões de arquitetura: CQRS, saga, circuit breaker, strangler fig, sidecar
- IaC: diferenças entre CloudFormation, Terraform, ARM, Deployment Manager
- Observabilidade: métricas, logs, traces — o que monitorar em cada tipo de recurso
- FinOps: como dimensionar corretamente cada tipo de recurso
- Disaster Recovery: RPO/RTO, estratégias de backup por serviço
- Compliance: GDPR, SOC2, HIPAA — quais serviços são certificados

**Volume estimado**: 5.000–15.000 chunks.
**Estratégia de atualização**: script de ingestão trimestral que processa os markdowns curados e regera o índice.

---

### Corpus 4 — Fontes externas ao vivo (dinâmico, consultado por demanda)

O que as plataformas estão publicando agora. Informação que o índice local ainda não tem.

Este corpus não é indexado localmente. É consultado em tempo real quando a query exige informação que pode estar desatualizada — novos serviços, preços atuais, release notes, status de disponibilidade.

**Fontes e quando consultar cada uma:**

#### Documentação oficial (web scraping estruturado)
| Fonte | URL base | Quando consultar |
|---|---|---|
| AWS Docs | docs.aws.amazon.com | limites de serviço, configurações específicas, novos recursos |
| AWS Pricing | aws.amazon.com/pricing | custo estimado de qualquer serviço |
| Azure Docs | learn.microsoft.com/azure | configurações Azure que podem ter mudado |
| Azure Pricing | azure.microsoft.com/pricing | custo estimado Azure |
| GCP Docs | cloud.google.com/docs | configurações GCP |
| GCP Pricing | cloud.google.com/pricing | custo estimado GCP |

#### APIs públicas (sem autenticação)
| API | O que retorna |
|---|---|
| AWS Price List API | preços atuais de todos os serviços AWS em JSON |
| AWS Service Health | status atual de cada serviço por região |
| Azure Retail Prices API | preços atuais Azure |
| GCP Pricing API | preços GCP |

#### Fontes de novidades e releases
| Fonte | Formato | Quando consultar |
|---|---|---|
| AWS What's New | RSS/JSON | "o que lançou recentemente na AWS?" |
| Azure Updates | RSS | "há alguma mudança no Azure Functions?" |
| GCP Release Notes | RSS | novidades GCP |
| AWS Changelog (GitHub) | GitHub API | mudanças em SDKs e providers |
| HashiCorp Terraform Registry | registry.terraform.io API | versão atual do provider, novos recursos |

#### Documentação de terceiros relevantes
| Fonte | Conteúdo |
|---|---|
| Terraform Registry (AWS provider) | recursos disponíveis, argumentos, exemplos |
| Terraform Registry (Azure provider) | idem |
| Terraform Registry (GCP provider) | idem |
| CloudFormation Resource Spec | tipos de recursos, propriedades, atributos |

---

## Arquitetura de implementação

```
packages/ai/src/
  rag/
    chunker.ts          — divide stacks (.ts) e markdowns em chunks
    embedder.ts         — gera embeddings via API configurável
    vector-store.ts     — índice vetorial em memória (Float32Array, coseno)
    bm25.ts             — índice BM25 para MVP sem embedding
    retriever.ts        — busca nos corpora locais (1, 2, 3), retorna top-K
    indexer.ts          — orquestra rebuild por corpus
    live-retriever.ts   — consultas externas ao vivo (corpus 4)
    query-router.ts     — decide quais fontes consultar por tipo de query

packages/ai/src/knowledge/
  aws/
    limits.md
    architectures.md
    comparisons.md
    costs.md
    security.md
    well-architected.md
  azure/
    equivalences.md
    networking.md
    identity.md
    architectures.md
  gcp/
    equivalences.md
    iam.md
    unique-services.md
    architectures.md
  cross-cloud/
    patterns.md
    iac-comparison.md
    observability.md
    finops.md
    disaster-recovery.md
    compliance.md

scripts/
  ingest-knowledge.ts   — processa markdowns e gera índice do corpus 3
```

---

## O query router — peça central

O `query-router.ts` classifica cada pergunta e decide quais corpora consultar, evitando chamadas externas desnecessárias.

```
query: "como configuro minha Lambda existente para usar VPC?"
  → corpus 1: sim (tem a Lambda do projeto)
  → corpus 2: sim (tem a doc do construct Lambda)
  → corpus 3: sim (tem padrões de Lambda em VPC)
  → corpus 4: não (informação estável, não precisa ao vivo)

query: "qual o preço atual do RDS MySQL db.t3.medium em us-east-1?"
  → corpus 1: não
  → corpus 2: não
  → corpus 3: talvez (tem modelo de custo geral)
  → corpus 4: sim → AWS Pricing API

query: "o AWS lançou algum novo serviço de banco de dados recentemente?"
  → corpus 1: não
  → corpus 2: não
  → corpus 3: não (pode estar desatualizado)
  → corpus 4: sim → AWS What's New RSS

query: "quais argumentos o recurso aws_rds_instance aceita no Terraform?"
  → corpus 1: não
  → corpus 2: não
  → corpus 3: talvez
  → corpus 4: sim → Terraform Registry API
```

A classificação pode ser feita com BM25 por palavras-chave sinalizadoras ("preço", "custo", "lançou", "novo", "versão atual", "hoje") ou com uma chamada leve ao modelo antes da resposta principal.

---

## Fluxo por mensagem (completo)

```
pergunta do usuário
  → query-router classifica a query
  → em paralelo:
      retriever.search(corpus 1) — stacks do projeto
      retriever.search(corpus 2) — docs de constructs
      retriever.search(corpus 3) — conhecimento de plataforma
      live-retriever.fetch(fontes selecionadas pelo router) — ao vivo, se necessário
  → reranking por relevância
  → monta contexto com os chunks mais relevantes (~15–20KB)
  → Claude responde
```

As consultas externas rodam com timeout de 3s e cache local de 1h — se a fonte externa estiver fora, o sistema continua funcionando com os corpora locais.

---

## Cache das consultas externas

```typescript
// .iacmp/live-cache.json
{
  "aws-pricing:rds:db.t3.medium:us-east-1": {
    "result": "...",
    "fetchedAt": "2026-06-15T10:00:00Z",
    "ttlHours": 24
  },
  "aws-whats-new:2026-06": {
    "result": "...",
    "fetchedAt": "2026-06-15T10:00:00Z",
    "ttlHours": 6
  }
}
```

TTL varia por tipo de fonte:
- Preços: 24h (mudam raramente)
- Release notes / What's New: 6h
- Documentação técnica: 7 dias (praticamente estável)
- Status de serviço (health): 5min

---

## Escolha de modelo de embedding

Anthropic não tem API de embeddings. As opções:

| Opção | Prós | Contras |
|---|---|---|
| `text-embedding-3-small` (OpenAI) | Barato ($0.02/1M tokens), boa qualidade geral | Exige chave OpenAI além da Anthropic |
| `voyage-code-2` (Voyage AI) | Treinado em código, melhor para TypeScript e IaC | Mais uma chave de API |
| Modelo local (`@xenova/transformers`) | Zero custo, offline, sem chave | +50MB de bundle, lento sem GPU |

**Recomendação para MVP**: BM25 nos corpus 1, 2 e 3, com consultas externas ao vivo para corpus 4. Fase 2 adiciona embedding semântico.

---

## Fases de implementação

### Fase 1 — BM25 + corpus de plataforma + fontes externas básicas
- `chunker.ts` e `bm25.ts` para corpus 1, 2 e 3
- Criar os markdowns em `packages/ai/src/knowledge/` (curação manual inicial)
- `live-retriever.ts` para AWS Pricing API e AWS What's New
- `query-router.ts` com classificação por palavras-chave
- Cache de consultas externas em `.iacmp/live-cache.json`
- Critério: perguntas sobre preço retornam dados reais da API, não estimativas do modelo

### Fase 2 — Embedding semântico nos quatro corpora
- `embedder.ts` configurável (OpenAI ou Voyage)
- `vector-store.ts` com coseno em Float32Array
- Expandir `live-retriever.ts` para Azure Pricing API, GCP Pricing API, Terraform Registry
- Critério: query semântica "qual serviço usar para fila com ordering garantido?" retorna FIFO SQS antes de Kinesis

### Fase 3 — Histórico + atualização contínua
- Histórico do `session-store.ts` indexado como corpus separado
- Script `ingest-knowledge.ts` para atualização trimestral do corpus 3
- Expansão do `live-retriever.ts` para release notes Azure e GCP
- Pipeline automático de refresh do corpus 3

---

## O que não muda

- `session-store.ts` — continua igual, o RAG é uma camada acima
- `response-cache.ts` — continua igual
- `AnthropicProvider` — continua igual, o RAG só muda o que entra no contexto
- Providers Azure/Copilot — beneficiam automaticamente

---

## Arquivos a criar / modificar

| Arquivo | Ação |
|---|---|
| `packages/ai/src/rag/chunker.ts` | criar |
| `packages/ai/src/rag/bm25.ts` | criar (fase 1) |
| `packages/ai/src/rag/vector-store.ts` | criar (fase 2) |
| `packages/ai/src/rag/embedder.ts` | criar (fase 2) |
| `packages/ai/src/rag/retriever.ts` | criar |
| `packages/ai/src/rag/live-retriever.ts` | criar |
| `packages/ai/src/rag/query-router.ts` | criar |
| `packages/ai/src/rag/indexer.ts` | criar |
| `packages/ai/src/knowledge/aws/*.md` | criar (curação manual) |
| `packages/ai/src/knowledge/azure/*.md` | criar (curação manual) |
| `packages/ai/src/knowledge/gcp/*.md` | criar (curação manual) |
| `packages/ai/src/knowledge/cross-cloud/*.md` | criar (curação manual) |
| `scripts/ingest-knowledge.ts` | criar |
| `packages/ai/src/tools/context-reader.ts` | modificar — usar retriever + live-retriever |
| `packages/ai/src/index.ts` | exportar módulo rag |
| `iacmp.json` (schema) | adicionar `rag.embeddingProvider`, `rag.liveSearch` |

---

## O que não precisamos

- Pinecone, Weaviate, Milvus ou qualquer serviço externo para o índice local
- Docker ou servidor dedicado
- GPU (coseno em Float32Array roda em menos de 5ms para 15.000 vetores)
- Dependência pesada nova para fase 1

---

## Próximos passos

Apontados pela auditoria adversarial (ver `docs/report.md`):

- **Religar o vector store ao retriever (RAG-01)** — `vectorStore.search()` já
  existe e o pipeline gera embeddings Voyage, mas o retriever só consulta BM25.
  Fundir resultados via RRF ou remover a metade vetorial se for legado.
- **Plugar o query-router no fluxo real (RAG-03)** — `routeQuery()` é testado
  mas não é chamado em `readProjectContextRAG`; hoje busca-se sempre nos 3
  corpora.
- **Normalização Unicode no tokenizer (RAG-02)** — o regex atual remove acentos
  do português, degradando recuperação em pt-BR.
- **Contextual Retrieval para knowledge corpus (RAG-04)** — hoje só
  project/docs passam pelo Contextualizer; o conhecimento curado vai cru.
- **Carregar `corpus3-index.json` pré-construído (RAG-07)** — o `ingest-knowledge.ts`
  gera o índice no build, mas o runtime re-chunka tudo a cada `buildIndexes`.
- **Cache de índices em memória (RAG-08)** — o `indexCache` é escrito mas
  nunca lido; reindexa a cada mensagem.

Esses itens são incrementais sobre a arquitetura descrita acima — não exigem
redesign.
