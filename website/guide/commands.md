# Commands

Running `iacmp` on its own (or `iacmp --help`) lists every command with a usage example. `iacmp <command> --help` shows all flags.

| Command | Description |
|---|---|
| `init` | Creates a project (templates: blank, hello, rds, webapp, network, serverless, fullstack) |
| `synth` | Synthesizes stacks to the provider's format (+ validation via the cloud CLI) |
| `deploy` / `destroy` | Real deploy and destroy, dependency-ordered, with confirmations |
| `diff` | Difference between the current synth and what is deployed |
| `diagram` | C4 diagrams (Structurizr DSL or Mermaid) from the stacks |
| `audit` / `audit-all` | Security, high-availability and DR audits |
| `doctor` | Environment diagnostics (CLIs, credentials, versions) |
| `registry` | Catalog of constructs and examples |
| `setup` | Registers the embedded MCP server in Claude Code and Claude Desktop |
| `ai` / `from-diagram` | AI generation (part of **iacmp Pro**) |

## Providers and formats

```bash
iacmp synth --provider aws              # CloudFormation
iacmp synth --provider azure            # Bicep (single deployment via _main.bicep)
iacmp synth --provider gcp              # Terraform (tf.json)
iacmp synth --provider aws --format tf  # AWS via Terraform
```

| Provider | Format | Coverage |
|---|---|---|
| `aws` | CloudFormation | 20/20 e2e battery scenarios |
| `azure` | Bicep (Deployment Stacks) | 20/20 scenarios |
| `gcp` | Terraform (tf.json) | 20/20 scenarios |
| `aws --format tf` / `azure --format tf` | Terraform | validated by real deploys |

## Full reference

The complete manual (every flag, every construct) lives in the repository: [User guide](https://github.com/Claudio-Fontes/iacmp/blob/main/docs/user-guide.md) · [Constructs](https://github.com/Claudio-Fontes/iacmp/blob/main/docs/constructs.md) · [FAQ](https://github.com/Claudio-Fontes/iacmp/blob/main/docs/faq.md)
