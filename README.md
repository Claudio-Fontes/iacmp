# iacmp — IaC Multi Plataforma

CLI unificado e inteligente para provisionamento de infraestrutura em nuvem com geração de stacks via IA.

**Esta versão suporta AWS e Azure.** As duas nuvens estão em paridade de síntese — 19 dos 20 cenários da bateria em cada uma, com o mesmo código de construct gerando CloudFormation na AWS e Bicep no Azure. A AWS é o provider de referência, validado por uma bateria completa de deploy real cobrindo ECS/ALB, Lambda em VPC, RDS, ElastiCache Redis, DynamoDB, Step Functions, WAF, WebSocket API Gateway, Kinesis e SNS. O Azure tem deploy real validado e está concluindo a mesma bateria ponta a ponta.

**Terraform e GCP são versões futuras** e não fazem parte desta release.

## Status dos providers

| Provider | Status | Observação |
|---|---|---|
| `aws` | **Suportado** — bateria e2e completa | Provider de referência; 20 ciclos de deploy real com correções aplicadas. 19/20 cenários |
| `azure` | **Suportado** — deploy real validado, bateria e2e em conclusão | Synth em Bicep + Deployment Stacks. Cobre APIM (inclusive compartilhado), Container Apps, Cosmos, Key Vault, Event Hubs, Logic Apps, WAF (App Gateway / Front Door) e Monitor. 19/20 cenários |
| `terraform` | **Versão futura** | O emissor existe (`emitTerraform(buildGraph(...))`) e 2 cenários foram validados em deploy real, mas o provider não é suportado nesta release |
| `gcp` | **Versão futura** | O Deployment Manager foi descontinuado pela Google; o suporte será reconstruído sobre Terraform |

> O único cenário ausente é o WebSocket, e ele falta nas duas nuvens — o construct ainda não existe no core.

## Instalação

```bash
npm install -g iacmp
```

Ou para rodar localmente (desenvolvimento):

```bash
npm install
npm run build
node packages/cli/bin/run.js --help
```

**Requisitos:** Node.js 20+, npm 10+

## Integração com o Claude (MCP)

O iacmp já vem com o servidor MCP (`@iacmp/mcp`) como dependência. Um único comando
registra as ferramentas do iacmp (`write_stack`, `synth_project`, `deploy_project`…)
no Claude Code e no Claude Desktop:

```bash
npm install -g iacmp
iacmp setup            # registra o MCP no Claude Code + Desktop (idempotente)
```

Reinicie o Claude e as ferramentas do iacmp aparecem. `iacmp setup --dry-run` mostra o
que seria escrito sem alterar nada. Você não precisa rodar o servidor à mão — o Claude
o executa sozinho; para depurar, `iacmp mcp serve` roda o servidor no terminal.

## Uso rápido

```bash
# Inicializa com template pronto
iacmp init meu-projeto --template rds
iacmp init meu-projeto --template serverless
iacmp init --list                           # ver todos os templates

# Sintetiza as stacks para CloudFormation (AWS)
cd meu-projeto && iacmp synth

# Sintetiza para Azure (Bicep)
iacmp synth --provider azure

# Gera diagrama de arquitetura
iacmp diagram                              # Structurizr DSL
iacmp diagram --format mermaid            # Mermaid (GitHub/GitLab)

# Audita a infraestrutura
iacmp audit-all                            # segurança, HA, DR e melhorias

# Gera stack via IA
iacmp ai "cria uma API serverless com DynamoDB"
iacmp ai --chat
```

## Comandos

| Comando | Descrição |
|---|---|
| `iacmp setup` | Integra o iacmp ao Claude (registra o MCP no Claude Code/Desktop) |
| `iacmp mcp serve` | Roda o servidor MCP (o Claude chama sozinho; use só p/ depurar) |
| `iacmp init [nome]` | Inicializa novo projeto |
| `iacmp synth` | Gera template nativo do provider |
| `iacmp deploy` | Faz deploy no provider |
| `iacmp destroy` | Destrói a infraestrutura |
| `iacmp diff` | Mostra diferenças desde o último synth |
| `iacmp ls` | Lista stacks disponíveis |
| `iacmp doctor` | Verifica ambiente e dependências |
| `iacmp watch` | Synth automático ao detectar mudanças |
| `iacmp ai [prompt]` | Gera stack via IA |
| `iacmp ai --chat` | Modo chat interativo |
| `iacmp dashboard` | Dashboard web de visualização |
| `iacmp registry list` | Lista constructs da comunidade |
| `iacmp audit-security` | Auditoria de segurança |
| `iacmp audit-ha` | Auditoria de alta disponibilidade |
| `iacmp audit-dr` | Auditoria de disaster recovery |
| `iacmp audit-improvements` | Sugestões de melhorias |
| `iacmp audit-all` | Todas as auditorias de uma vez |
| `iacmp diagram` | Diagrama de arquitetura (Structurizr/Mermaid) |

## Templates

O `iacmp init --template` cria projetos prontos para usar:

| Template | Constructs |
|---|---|
| `default` | Compute.Instance + Storage.Bucket |
| `rds` | Network.VPC + Database.SQL Multi-AZ + réplica |
| `webapp` | Network.VPC + bucket público + bucket privado |
| `network` | Network.VPC + bastion + app server |
| `serverless` | Network.VPC + Function.Lambda |
| `fullstack` | Network.VPC + Compute + Database.SQL + Storage.Bucket |

```bash
iacmp init --list                        # lista todos com descrição
iacmp init meu-projeto --template rds
```

## Providers suportados

| Provider | Output | Status |
|---|---|---|
| `aws` | CloudFormation JSON | **Suportado** |
| `azure` | Bicep + Deployment Stacks | **Suportado** |
| `terraform` | Terraform JSON (`.tf.json`) | Versão futura |
| `gcp` | — | Versão futura |

## Configuração de deploy por provider

### AWS

```bash
# Instala e configura o AWS CLI
brew install awscli        # macOS
aws configure              # pede Access Key ID, Secret, região e formato
```

Ou com múltiplos perfis:

```bash
aws configure --profile meu-perfil
export AWS_PROFILE=meu-perfil
```

### Azure

```bash
# Instala o Azure CLI
brew install azure-cli     # macOS

# Login interativo (abre o browser)
az login

# Confirma as subscriptions disponíveis
az account list --output table

# Seleciona a subscription correta (se houver mais de uma)
az account set --subscription "Nome ou ID da subscription"
```

Para CI/CD com service principal:

```bash
az ad sp create-for-rbac --name iacmp-deploy --role Contributor \
  --scopes /subscriptions/<subscription-id>
```

Adicione as credenciais retornadas no `.env` do projeto:

```
AZURE_CLIENT_ID=<appId>
AZURE_CLIENT_SECRET=<password>
AZURE_TENANT_ID=<tenant>
AZURE_SUBSCRIPTION_ID=<subscription-id>
```

## Constructs disponíveis

```typescript
import { Stack, Compute, Storage, Network, Database, Fn } from '@iacmp/core';

const stack = new Stack('minha-stack');

new Compute.Instance(stack, 'Web', { instanceType: 'medium', image: 'ubuntu-22.04' });
new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
new Network.VPC(stack, 'Rede', { cidr: '10.0.0.0/16', maxAzs: 3 });
new Database.SQL(stack, 'DB', { engine: 'postgres', multiAz: true });
new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });

export default stack;
```

## Teste API CRUD
API CRUD de itens deployada em AWS e Azure via iacmp.

## Endpoints

### AWS

```bash
curl -X POST https://qhxe8c9dq1.execute-api.us-east-1.amazonaws.com/itens \
  -H "Content-Type: application/json" \
  -d '{"nome": "Produto A", "preco": 99.90}'
```

### Azure

```bash
curl -X POST https://itens-api-nuamz4umy63zu.azure-api.net/api/itens \
  -H "Content-Type: application/json" \
  -d '{"nome": "Produto A", "preco": 99.90}'
```
## Auditoria

Analisa as stacks e gera relatórios Markdown em `audit/`:

```bash
iacmp audit-all
# Gera: audit/security-YYYY-MM-DD.md    — acesso público, versionamento, Multi-AZ
#        audit/ha-YYYY-MM-DD.md          — Single-AZ, redundância de compute
#        audit/dr-YYYY-MM-DD.md          — score /10, checklist de DR
#        audit/improvements-YYYY-MM-DD.md — sugestões com impacto e esforço
```

## Diagramas

Gera diagramas de arquitetura a partir das stacks, sem redesenho manual:

```bash
iacmp diagram                    # → diagrams/workspace.dsl (Structurizr C4)
iacmp diagram --format mermaid   # → diagrams/workspace.md  (GitHub/GitLab/Notion)
iacmp diagram --stack database   # filtra uma stack
```

O Mermaid é renderizado automaticamente no GitHub/GitLab. O Structurizr DSL pode ser aberto em https://structurizr.com/dsl com estilos e layout automático.

## IA

Requer `ANTHROPIC_API_KEY` (Claude) ou `GITHUB_TOKEN` (Copilot). Use o
`.env.example` como base — copie para `.env` na raiz do projeto e preencha as
chaves. O `.env` está no `.gitignore`.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
iacmp ai "cria uma VPC com subnets públicas e privadas na AWS"
```

A geração é apoiada por uma **knowledge base de 126 exemplos** de referência (parte
validada em deploy real). Ela vem **embutida no CLI** — na primeira vez que você roda
`iacmp ai`, o banco `~/.iacmp/knowledge.db` é semeado automaticamente a partir de
`@iacmp/knowledge`. Nenhum setup manual; o mesmo banco é reaproveitado pelo servidor MCP.

### Auto-aprendizado local (opt-in)

Você pode deixar o iacmp **aprender com os seus próprios deploys**. Com

```json
{ "knowledge": { "autolearn": "local" } }
```

no `iacmp.json` (padrão: desligado), sempre que um `iacmp deploy` conclui com sucesso
um padrão de infraestrutura **inédito**, o CLI mostra um preview e pergunta se você quer
guardá-lo na **sua base local**. O padrão passa a reforçar as próximas gerações
(`iacmp ai` e MCP). Fica **só na sua máquina** — nada é enviado para lugar nenhum.

## Estrutura do monorepo

```
packages/
├── cli/                  # CLI (oclif v4) — pacote publicado como `iacmp`
├── core/                 # Constructs agnósticos de provider
├── runtime/              # Facade neutro (table/blob) que os handlers importam
├── knowledge/            # Knowledge base: corpus (126 exemplos) + retrieval + seed
├── ai/                   # Geração de stacks via IA (Claude/Copilot)
├── providers/
│   ├── aws/              # CloudFormation
│   ├── azure/            # Bicep + Deployment Stacks
│   ├── gcp/              # (versão futura)
│   └── terraform/        # (versão futura)
├── plugin-sdk/           # SDK para providers customizados
├── dashboard/            # Dashboard web
└── registry/             # Registry de constructs
examples/
├── webapp/               # Site estático com VPC e buckets
├── database/             # RDS Multi-AZ com VPC
└── network/              # Infraestrutura de rede completa
docs/
├── manual-de-uso.md
├── arquitetura.md
├── providers.md
├── constructs.md
├── contribuindo.md
├── estudo-rag.md
├── plano-diagramas-stacks.md
├── faq.md
├── changelog.md
└── publicacao-npm.md
```

## Desenvolvimento

```bash
npm install
npm run build      # compila todos os packages
npm test           # roda os testes de integração
npm run typecheck  # verifica tipos sem compilar
```

## Licença

MIT — veja [LICENSE](LICENSE).
