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
# Inicializa um projeto
iacmp init meu-projeto
cd meu-projeto

# Sintetiza as stacks para CloudFormation
iacmp synth

# Sintetiza para outro provider
iacmp synth --provider terraform

# Gera stack via IA
iacmp ai "cria uma API serverless com DynamoDB"

# Modo chat interativo
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

Os comandos de auditoria analisam as stacks do projeto e geram relatórios Markdown em `audit/`:

```bash
cd meu-projeto
iacmp audit-all
# Gera: audit/security-2026-06-13.md
#        audit/ha-2026-06-13.md
#        audit/dr-2026-06-13.md
#        audit/improvements-2026-06-13.md
```

## IA

Requer `ANTHROPIC_API_KEY` (Claude) ou `GITHUB_TOKEN` (Copilot):

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

MIT
