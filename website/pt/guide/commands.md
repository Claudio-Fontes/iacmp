# Comandos

Rodar `iacmp` sozinho (ou `iacmp --help`) lista todos os comandos com um exemplo de uso. `iacmp <comando> --help` mostra todas as flags.

| Comando | Descrição |
|---|---|
| `init` | Cria um projeto (templates: blank, hello, rds, webapp, network, serverless, fullstack) |
| `synth` | Sintetiza as stacks para o formato do provider (+ validação via CLI da nuvem) |
| `deploy` / `destroy` | Deploy e destroy reais, em ordem de dependência, com confirmações |
| `diff` | Diferença entre o synth atual e o que está deployado |
| `diagram` | Diagramas C4 (Structurizr DSL ou Mermaid) a partir das stacks |
| `audit` / `audit-all` | Auditorias de segurança, alta disponibilidade e DR |
| `doctor` | Diagnóstico do ambiente (CLIs, credenciais, versões) |
| `registry` | Catálogo de constructs e exemplos |
| `setup` | Registra o servidor MCP embutido no Claude Code e Claude Desktop |
| `ai` / `from-diagram` | Geração via IA (parte do **iacmp Pro**) |

## Providers e formatos

```bash
iacmp synth --provider aws              # CloudFormation
iacmp synth --provider azure            # Bicep (deployment único via _main.bicep)
iacmp synth --provider gcp              # Terraform (tf.json)
iacmp synth --provider aws --format tf  # AWS via Terraform
```

| Provider | Formato | Cobertura |
|---|---|---|
| `aws` | CloudFormation | 20/20 cenários da bateria e2e |
| `azure` | Bicep (Deployment Stacks) | 20/20 cenários |
| `gcp` | Terraform (tf.json) | 20/20 cenários |
| `aws --format tf` / `azure --format tf` | Terraform | validado por deploys reais |

## Referência completa

O manual completo (todas as flags, todos os constructs) está no repositório, em inglês: [User guide](https://github.com/Claudio-Fontes/iacmp/blob/main/docs/user-guide.md) · [Constructs](https://github.com/Claudio-Fontes/iacmp/blob/main/docs/constructs.md) · [FAQ](https://github.com/Claudio-Fontes/iacmp/blob/main/docs/faq.md)
