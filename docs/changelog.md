# Changelog

---

## [1.0.0] — 2026-06-13

Fase 5 — Produção.

### Adicionado

- **Testes de integração** — suite Jest com ts-jest cobrindo todos os providers nativos
  - `packages/core/test/stack.test.ts` — 7 testes: Stack e todos os constructs (Compute, Storage, Network, Database, Fn)
  - `packages/providers/aws/test/cloudformation.test.ts` — 8 testes: CloudFormation, mapeamento de tipos, versioning, VPC, RDS, Lambda
  - `packages/providers/azure/test/arm.test.ts` — 2 testes: ARM Template, VM e Storage Account
  - `packages/providers/terraform/test/hcl.test.ts` — 3 testes: blocos HCL, aws_instance, aws_s3_bucket
  - Pipeline `test` adicionado ao `turbo.json` e `npm test` à raiz
- **Documentação completa**
  - `docs/arquitetura.md` — arquitetura interna do monorepo, fluxo de `iacmp synth`, fluxo de `iacmp ai`, plugin system e guia de novo provider
  - `docs/faq.md` — 10 perguntas frequentes cobrindo ts-node, API keys, deploy real, synth-out, múltiplas stacks, providers customizados
  - `docs/publicacao-npm.md` — guia de publicação no npm com checklist e comandos
- **Exemplos de projetos reais** em `examples/`
  - `examples/webapp/` — site estático com VPC, bucket público e bucket privado
  - `examples/database/` — banco RDS Multi-AZ com VPC e réplica
  - `examples/network/` — rede completa com VPC, bastion e app server
  - Todos funcionais: `iacmp synth` gera CloudFormation JSON válido
- **Versão 1.0.0** em todos os packages do monorepo
- **`iacmp synth`** — busca `ts-node` em diretórios pai (suporte a monorepo e exemplos sem node_modules local)

---

## [0.4.0] — 2026-06-13

Fase 4 — DX & Ecossistema.

### Adicionado

- **`@iacmp/plugin-sdk`** — SDK para criação de providers customizados por terceiros
  - `plugin.ts` — interfaces `IacmpProvider` e `IacmpPlugin` + função `definePlugin()`
  - `loader.ts` — `loadPlugins()`: lê campo `plugins` do `iacmp.json` e carrega providers via `require()` com debounce de erros
- **`@iacmp/dashboard`** — pacote do dashboard web de visualização de stacks
  - `server.ts` — servidor HTTP nativo (sem dependências externas)
  - `ui.ts` — geração de HTML com tema escuro, cards por stack, tabela de recursos, tudo inline
  - `index.ts` — `startDashboard()` exportável
- **`@iacmp/registry`** — cliente do registry de constructs da comunidade
  - `registry.json` — registry local com 3 constructs de exemplo: `WebApp.Static`, `Queue.SQS`, `Auth.Cognito`
  - `client.ts` — `listConstructs()` e `searchConstructs(term)`
- **`iacmp watch`** — novo comando CLI
  - Monitora `stacks/` recursivamente com `fs.watch()` nativo
  - Debounce de 300ms para evitar synths duplicados em saves rápidos
  - Executa `iacmp synth` automaticamente ao detectar mudanças
  - Imprime timestamp `[HH:MM:SS]`, nome do arquivo alterado e resultado (✓/✗)
- **`iacmp dashboard`** — novo comando CLI
  - Serve dashboard HTTP na porta configurável (padrão: 4000)
  - Lê `synth-out/` e exibe stacks e recursos em tempo real
  - Flag `--open` para abrir o browser automaticamente
- **`iacmp registry`** — novo comando CLI
  - `iacmp registry list` — lista todos os constructs em tabela formatada
  - `iacmp registry search <termo>` — filtra por nome, pacote ou descrição
- **Plugin system no `iacmp synth`** — integração com plugins carregados
  - Se o provider não for nativo, busca em plugins carregados via `loadPlugins()`
  - Plugin de exemplo em `examples/plugin-exemplo/` (Digital Ocean simulado)
- **CI/CD gerado pelo `iacmp init`**
  - `.github/workflows/iacmp.yml` — GitHub Actions: checkout, setup-node, `npm ci`, `iacmp synth`, `npm test`
  - `.gitlab-ci.yml` — GitLab CI: image node:20, script: `npm ci`, `iacmp synth`, `npm test`
- **`iacmp doctor`** — nova verificação de plugins
  - Se `iacmp.json` tiver campo `plugins`, lista cada plugin e indica se foi carregado com sucesso

---

## [0.3.0] — 2026-06-13

Fase 3 — Módulo AI.

### Adicionado

- **`@iacmp/ai`** — pacote com toda a lógica de geração de stacks via IA
  - `providers/base.ts` — interfaces `AIProvider`, `AIMessage`, `AIResponse`
  - `providers/anthropic.ts` — `AnthropicProvider` com suporte a chat e streaming (modelo `claude-sonnet-4-6`)
  - `providers/copilot.ts` — `CopilotProvider` via GitHub Copilot API (`gpt-4o`, SSE streaming)
  - `prompts/system-prompt.ts` — system prompt completo com instruções de geração, migração, documentação e otimização de custo; placeholder `{PROJECT_CONTEXT}` substituído em runtime
  - `parser/code-extractor.ts` — extrai e valida JSON do response da IA (suporte a JSON puro, blocos markdown e heurística `{...}`)
  - `parser/validator.ts` — valida TypeScript gerado com `tsc --noEmit` em diretório temporário
  - `chat/session.ts` — `ChatSession` com histórico de mensagens
  - `chat/renderer.ts` — spinner, explicação, warnings, next steps e streaming chunk-a-chunk
  - `tools/diff-renderer.ts` — diff colorido de arquivos novos/modificados com aprovação via `readline`
  - `tools/file-writer.ts` — escreve arquivos após aprovação do diff; suporte a `--dry-run`
  - `tools/context-reader.ts` — lê `iacmp.json` e stacks existentes para injetar contexto no prompt
  - `tools/synth-runner.ts` — executa `iacmp synth` após geração
- **`iacmp ai`** — novo comando CLI
  - Modo comando único: `iacmp ai "descrição"` — gera stack, valida, exibe diff, pede aprovação
  - Modo chat: `iacmp ai --chat` — loop interativo com comandos `/sair` e `/limpar`
  - Flag `--dry-run` — exibe arquivos que seriam gerados sem salvar nada
  - Flag `--provider` — sobrescreve provider do `iacmp.json`
  - Retry automático em caso de erro TypeScript (1 tentativa)
  - Detecção de provider: `ANTHROPIC_API_KEY` tem prioridade sobre `GITHUB_TOKEN`
  - Mensagem de erro clara quando nenhuma API key está configurada

---

## [0.2.0] — 2026-06-13

Fase 2 — Multi-cloud.

### Adicionado

- **`@iacmp/provider-azure`** — síntese de constructs para ARM Template JSON
  - `Compute.Instance` → `Microsoft.Compute/virtualMachines`
  - `Storage.Bucket` → `Microsoft.Storage/storageAccounts` (kind `StorageV2`)
  - `Network.VPC` → `Microsoft.Network/virtualNetworks`
  - `Database.SQL` → `Microsoft.Sql/servers` + `Microsoft.Sql/servers/databases`
  - `Fn.Lambda` → `Microsoft.Web/sites` (kind `functionapp`)
- **`@iacmp/provider-gcp`** — síntese de constructs para GCP Deployment Manager JSON
  - `Compute.Instance` → `compute.v1.instance`
  - `Storage.Bucket` → `storage.v1.bucket`
  - `Network.VPC` → `compute.v1.network`
  - `Database.SQL` → `sqladmin.v1beta4.instance`
  - `Fn.Lambda` → `cloudfunctions.v2.function`
- **`@iacmp/provider-terraform`** — síntese de constructs para HCL (`.tf`)
  - `Compute.Instance` → `resource "aws_instance"`
  - `Storage.Bucket` → `resource "aws_s3_bucket"`
  - `Network.VPC` → `resource "aws_vpc"`
  - `Database.SQL` → `resource "aws_db_instance"`
  - `Fn.Lambda` → `resource "aws_lambda_function"`
- **`iacmp diff`** — compara synth anterior com o atual, exibe diff colorido linha a linha
- **`iacmp synth`** — suporte a providers `azure`, `gcp` e `terraform` (além de `aws`)
- **`iacmp deploy`** — mensagens específicas por provider
- **`iacmp init --language python`** — cria `stacks/exemplo_stack.py` como placeholder para Fase 3
- **`iacmp init --provider`** — flag para definir provider padrão no `iacmp.json`

---

## [0.1.0] — 2026-06-13

Primeira versão do iacmp — MVP da Fase 1.

### Adicionado

- Monorepo com Turborepo (`@iacmp/core`, `@iacmp/provider-aws`, `iacmp`)
- **`@iacmp/core`** — 5 constructs agnósticos ao provider:
  - `Compute.Instance` — máquinas virtuais
  - `Storage.Bucket` — object storage
  - `Network.VPC` — redes privadas virtuais
  - `Database.SQL` — bancos relacionais gerenciados
  - `Fn.Lambda` — funções serverless
- **`@iacmp/provider-aws`** — síntese de constructs para CloudFormation JSON
- **CLI `iacmp`** com 6 comandos:
  - `iacmp init` — inicializa projeto com `iacmp.json` e `stacks/`
  - `iacmp synth` — sintetiza stacks para o formato nativo do provider
  - `iacmp deploy` — faz deploy das stacks no provider
  - `iacmp destroy` — destrói a infraestrutura (com confirmação)
  - `iacmp ls` — lista stacks do projeto
  - `iacmp doctor` — verifica ambiente e dependências
- Documentação inicial: manual de uso, referência de constructs, referência de providers, guia de contribuição

### Limitações desta versão

- `deploy` e `destroy` são simulados — sem chamadas reais à AWS
- Apenas provider AWS disponível
- `iacmp ai` (geração por IA) disponível na Fase 3
- Providers Azure, GCP e Terraform disponíveis na Fase 2

---

## Próximas versões (planejado)

### [0.2.0] — Fase 2 · Multi-cloud

- Provider Azure (Bicep / ARM Template)
- Provider GCP (Deployment Manager)
- Provider Terraform (HCL via CDKTF)
- `iacmp diff` — visualiza diferenças antes do deploy
- `iacmp doctor` com checagem de Azure CLI e gcloud

### [0.3.0] — Fase 3 · Módulo AI

- `iacmp ai "descrição"` — gera stack via IA (Claude / GitHub Copilot)
- `iacmp ai --chat` — modo chat interativo
- `iacmp ai --dry-run` — prévia sem escrever arquivos
- Diff colorido com aprovação obrigatória antes de salvar arquivos gerados
- `ANTHROPIC_API_KEY` obrigatório a partir desta versão para `iacmp ai`

### [0.4.0] — Fase 4 · DX & Ecossistema

- `iacmp watch` — hot deploy ao detectar mudanças
- Plugin system para providers customizados
- Registry de constructs da comunidade
- Integrações com GitHub Actions e GitLab CI
