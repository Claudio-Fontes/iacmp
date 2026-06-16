# iacmp — IaC Multi Plataforma

CLI unificado e inteligente para provisionamento de infraestrutura em AWS, Azure, GCP e Terraform, com geração de stacks via IA.

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

## Uso rápido

```bash
# Inicializa com template pronto
iacmp init meu-projeto --template rds
iacmp init meu-projeto --template serverless
iacmp init --list                           # ver todos os templates

# Sintetiza as stacks para CloudFormation
cd meu-projeto && iacmp synth

# Sintetiza para outro provider
iacmp synth --provider terraform

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

| Provider | Output |
|---|---|
| `aws` | CloudFormation JSON |
| `azure` | ARM Template JSON |
| `gcp` | GCP Deployment Manager JSON |
| `terraform` | HCL (`.tf`) |

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

## Estrutura do monorepo

```
packages/
├── cli/                  # CLI (oclif v4) — pacote publicado como `iacmp`
├── core/                 # Constructs agnósticos de provider
├── ai/                   # Geração de stacks via IA (Claude/Copilot)
├── providers/
│   ├── aws/              # CloudFormation
│   ├── azure/            # ARM Template
│   ├── gcp/              # Deployment Manager
│   └── terraform/        # HCL
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
