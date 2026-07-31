# iacmp — User Guide

Unified CLI for provisioning infrastructure on AWS, Azure, and GCP — with Terraform as an alternative output format (`--format tf`).

---

## Installation

**Requirements:** Node.js 20+, npm 10+

```bash
npm install -g iacmp
```

Verify it works:

```bash
iacmp --version
iacmp doctor
```

---

## Basic workflow

```
1. iacmp init          → creates the project
2. Write your stack    → file in stacks/
3. iacmp synth         → generates the native template (CloudFormation, Bicep, etc.)
4. iacmp deploy        → deploys to the provider
```

---

## Commands

Running `iacmp` by itself (or `iacmp --help`) already lists every command with a
usage example below each one — you don't need to run `iacmp <command> --help`
just to discover the basic syntax. Per-command `--help` is still available to
see all flags and all examples.

### `iacmp init [nome]`

With a name: creates the project folder and initializes inside it.  
Without a name: initializes in the current directory.

```bash
# Creates the 'meu-projeto' folder and initializes inside it
iacmp init meu-projeto
cd meu-projeto

# Or initialize in the current directory
mkdir meu-projeto && cd meu-projeto
iacmp init
```

Creates:
- `iacmp.json` — project configuration (provider, region, language)
- `stacks/` — directory where stacks live

Generated `iacmp.json`:
```json
{
  "name": "meu-projeto",
  "provider": "aws",
  "region": "us-east-1",
  "language": "typescript"
}
```

---

### `iacmp synth [--provider aws]`

Synthesizes the stacks into the configured provider's native format.

```bash
iacmp synth
iacmp synth --provider aws
```

Reads the stacks in `stacks/` (`.ts` directly via tsx or compiled `.js`) and
generates the templates in `synth-out/<provider>/`. Examples:
`synth-out/aws/minha-stack.json` (CloudFormation),
`synth-out/azure/minha-stack.bicep` + `_main.bicep` (Bicep, single deployment),
`synth-out/gcp/minha-stack.tf.json` + `_providers.tf.json` (Terraform). With
`--format tf`, AWS and Azure are emitted as Terraform in `synth-out/aws-tf/`
and `synth-out/azure-tf/`.

> `tsx` is installed as a devDependency by `iacmp init`. If you created the
> project manually, run `npm i -D tsx` before the first synth.

---

### `iacmp deploy [--provider aws] [--stack nome] [--dry-run]`

Actually deploys the infrastructure — it invokes each cloud's native CLI under
the hood (`aws`, `az`, or `terraform`, depending on the configured provider and
format). You don't need to know which tool is used underneath: the command is
always `iacmp deploy`.

```bash
iacmp deploy                              # uses the provider from iacmp.json
iacmp deploy --provider aws
iacmp deploy --stack minha-stack
iacmp deploy --dry-run                    # shows the commands without executing anything
```

Prerequisite: the stack must be synthesized first (`iacmp synth --provider <provider>`)
and the chosen provider's native CLI must be installed and authenticated — run
`iacmp doctor` to check (`--fix` installs what's missing).

What each provider actually does:

| Provider | What runs under the hood | Notes |
|---|---|---|
| `aws` | `aws cloudformation package` + `aws cloudformation deploy` | `package` zips and uploads Lambda code automatically. iacmp creates (once) and uses its own S3 bucket, `iacmp-deploy-artifacts-<conta>-<região>` — no manual configuration needed. |
| `azure` | `az stack group create` (Deployment Stacks) | Requires `resourceGroup` in `iacmp.json`. If the resource group does not exist, the command asks before creating it. |
| `gcp` | pre-flight (APIs + roles) + handler build/upload + `terraform init` + `apply` | All the project's stacks form a single Terraform root module (shared state). Uses `projectId` from `iacmp.json`, or the default `gcloud` project if omitted. |
| `--format tf` (aws/azure) | `terraform init` + `terraform apply -auto-approve` | Operates on the entire `synth-out/aws-tf/` or `synth-out/azure-tf/` directory (single state) — `--stack` does not apply. Requires `iacmp synth --format tf` first. |

With `--dry-run`, no command is actually executed — iacmp still performs the
read-only checks it needs (e.g. whether the deployment already exists on GCP)
to show the real plan, but it never asks for confirmation nor calls the cloud.

**Stacks in different files (AWS):** it is common (and the recommended default)
to have the `Function.Lambda` in `stacks/compute/` and the
`Function.ApiGateway` that references it in `stacks/network/`, in separate
files/stacks. `iacmp synth`/`deploy`/`destroy` handle this automatically: the
Lambda exports its ARN and the API Gateway imports it via `Fn::ImportValue`,
and `deploy` always brings up the Lambda stack before the API Gateway one
(`destroy` tears them down in reverse order). You don't have to do anything
manual for this to work.

> Function code packaging (`Fn.Lambda`) happens at deploy time on **all
> three** clouds: the handler is bundled (esbuild) with the `@iacmp/runtime`
> facade resolved to the target cloud's adapter — automatic zip + upload
> (S3/`config-zip`/GCP artifacts bucket). No manual step.

**How packaging works** (important so you don't add a needless build step):

- The Lambda's `code` (e.g. `code: 'dist/handlers/itens'`) is the bundle's
  **destination**, not something you have to generate. The deploy derives the
  **source** by swapping `dist/` for `src/` and looking up the handler module —
  for `handler: 'index.handler'`, the source is `src/handlers/itens/index.ts`
  (or `.js`). You never run `tsc`/build manually.
- The bundle is **self-contained**: the project's npm dependencies (e.g.
  `ioredis`, `zod`) are inlined — you can use them in the handler. Shared code
  in `src/lib/` is also bundled into whoever imports it.
- On AWS, `@aws-sdk/*` is deliberately **excluded** from the bundle: the
  Lambda Node runtime already provides SDK v3. Don't add it to your
  dependencies because of this.
- `import { table, blob, ... } from '@iacmp/runtime'` is resolved at build
  time to the target cloud's adapter (Lambda/Azure Functions/Cloud
  Functions) — the same handler runs on all three clouds without changes.

---

### `iacmp destroy [--provider aws] [--stack nome] [--dry-run]`

Destroys the provisioned infrastructure for real. Asks for confirmation before
executing (unless you use `--force`) — the prompt happens before any call to
the native CLI, so canceling never depends on having the tool installed.

```bash
iacmp destroy
iacmp destroy --stack minha-stack
iacmp destroy --force                     # skips the confirmation
iacmp destroy --dry-run                   # shows the commands without executing anything
```

Same native-command logic as `iacmp deploy` (CloudFormation delete-stack,
Azure Deployment Stacks delete, `terraform destroy` on GCP and on the
`--format tf` paths). Where state is shared (GCP and `--format tf`), `--stack`
is not supported — destroy operates on the whole directory. After the destroy,
iacmp offers to clean up leftovers with confirmation: empty resource group
(Azure), buckets with `DeletionPolicy: Retain` (AWS), and purging soft-deleted
APIM.

---

### `iacmp ls`

Lists the stacks available in the current project.

```bash
iacmp ls
```

---

### `iacmp ai [prompt]` — iacmp Pro

Generates infrastructure stacks in TypeScript via AI, with RAG over a corpus of
examples validated in real deploys. **Claude (Anthropic) is the tested and
supported provider.** OpenAI and GitHub Copilot providers exist in the codebase
but are experimental — not validated end to end.

> **iacmp Pro.** This command (and `from-diagram`) is part of iacmp Pro. On the
> open installation it shows a message indicating the module is absent — the
> rest of the CLI works normally without it.

**Prerequisite (besides Pro):** set one of these environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # Anthropic Claude (tested and supported)
# or, experimental (not validated end to end):
export GITHUB_TOKEN=ghp_...           # GitHub Copilot
```

#### Single-command mode

```bash
iacmp ai "cria uma Lambda com API Gateway e DynamoDB"
iacmp ai "cria uma VPC com subnets públicas e privadas"
iacmp ai "documenta a stack ecommerce-stack em português"
iacmp ai "migra a stack para azure" --provider azure
iacmp ai "otimiza a stack para reduzir custos"
```

Flow:
1. Reads the project context (`iacmp.json` + existing stacks)
2. Sends the prompt to the AI with streaming
3. Extracts the JSON from the response
4. Validates the generated TypeScript (`tsc --noEmit`)
5. Shows a colored diff of the files to be created/modified
6. Asks for approval before saving (`[y/n]`)
7. Asks whether to run `iacmp synth` right away

#### Interactive chat mode

```bash
iacmp ai --chat
```

Interactive loop that keeps the conversation history:

```
iacmp ai — Modo Chat Interativo

> Você: preciso de uma arquitetura serverless para e-commerce
> (IA gera e exibe a stack)
> Você: adiciona SQS para processamento de pedidos
> (IA modifica a stack mantendo o contexto)
> Você: /sair
```

Special commands in chat mode:
- `/sair` or `/quit` — exits the chat
- `/limpar` — clears the conversation history
- `/lang pt|en|es` — switches the interface and Claude response language in real time (default: `pt`, or the value of `IACMP_LANG` in `.env`)
- `/voz` — records audio and transcribes it to text (see "Voice input" below)

#### Voice input

The `/voz` command records audio from the microphone and automatically transcribes it in Portuguese, English, or Spanish, without replacing typing — you can keep typing normally at any time.

Prerequisites:
- `sox` binary on the PATH — used to record the audio.
- A [whisper.cpp](https://github.com/ggerganov/whisper.cpp) binary (`whisper-cli` or `main`) on the PATH, or pointed to by `IACMP_WHISPER_BIN`.
- A whisper.cpp `ggml` model downloaded locally, with its path configured in `IACMP_WHISPER_MODEL` in `.env`.

Run `iacmp doctor --fix` to check and automatically install what's missing (sox via brew/apt/winget/choco depending on the system, whisper.cpp via brew on macOS, and the `ggml-base` model downloaded and configured in `IACMP_WHISPER_MODEL`) — it asks for confirmation before each action and never installs anything without your approval. On platforms with no known automatic install (e.g. whisper.cpp on Linux/Windows), `doctor` shows the link and the manual path. Run just `iacmp doctor` (without `--fix`) to only check what's missing.

Flow:
```
> Você: /voz
gravando... pressione Enter para parar
[Enter]
Você disse (pt): cria uma fila SQS para processar pedidos
[Enter] usar, /voz regravar, ou digite para corrigir:
```

Press Enter to accept the transcription, type `/voz` to record again, or type text to fix/replace it before sending. Claude's reply comes back in the same language detected in the speech (pt/en/es); if detection fails, it uses the current interface language.

If `sox` or whisper.cpp are not configured, `/voz` shows a clear error message and the chat keeps working normally via text.

#### Dry-run mode

```bash
iacmp ai --dry-run "cria uma stack com RDS e EC2"
```

Shows the files that would be generated without saving anything to disk. Useful for a preview.

#### Flags

| Flag | Description | Default |
|------|-----------|--------|
| `--chat` | Interactive chat mode | `false` |
| `--dry-run` | Show without saving | `false` |
| `--provider` | Target provider | Read from `iacmp.json` |

---

### `iacmp setup` — Claude integration (MCP)

Registers iacmp's built-in MCP server with **Claude Code** (`~/.claude.json`)
and **Claude Desktop** (per-OS configuration file). Idempotent — running it
again updates without duplicating. `--dry-run` shows what would be written.

```bash
iacmp setup
iacmp setup --dry-run
```

After restarting Claude, the agent gains the iacmp tools:

- **Always available:** `write_stack`, `synth_project`, `deploy_project`,
  `destroy_project`, `validate_stack`, `read_synth_output`, `from_diagram` —
  all mechanical (they write files and call the local CLI), with no embedded AI.
- **With iacmp Pro:** `search_examples` and `list_examples` (search over the
  corpus of examples validated in real deploys).

You don't need to run the server yourself — Claude runs it on its own. For
debugging: `iacmp mcp serve` runs the server in the terminal.

---

### `iacmp watch [--provider aws]`

Watches `stacks/` and runs `iacmp synth` automatically when changes are detected.

```bash
iacmp watch
iacmp watch --provider azure
```

On start, it prints `Monitorando stacks/ — pressione Ctrl+C para parar`. For each detected change it prints the timestamp, the changed file, and whether the synth succeeded.

| Flag | Description | Default |
|------|-----------|--------|
| `--provider`, `-p` | Provider to synthesize for | Read from `iacmp.json` |

---

### `iacmp dashboard`

Starts a local HTTP server with a view of the synthesized stacks.

```bash
iacmp dashboard
iacmp dashboard --port 3000
iacmp dashboard --open
```

Reads the files in `synth-out/` and displays a dark-themed dashboard in the browser. Each stack appears in a card with its resource list (type and logical ID).

| Flag | Description | Default |
|------|-----------|--------|
| `--port`, `-p` | Server port | `4000` |
| `--open` | Opens the browser automatically | `false` |

---

### `iacmp registry`

Accesses the community constructs registry.

```bash
iacmp registry list                 # lists all constructs
iacmp registry search cognito       # filters by name or description
```

Prints a table with: Name | Package | Providers | Description.

---

### `iacmp diagram`

Generates architecture diagrams from the project's stacks.

```bash
iacmp diagram                              # Structurizr DSL (default)
iacmp diagram --format mermaid             # Mermaid in Markdown
iacmp diagram --stack database             # a single stack only
iacmp diagram --format mermaid --out docs/diagrams
```

Generates a single file with all stacks in `diagrams/`:

| Formato | Arquivo gerado | Onde abrir |
|---|---|---|
| `structurizr` | `diagrams/workspace.dsl` | https://structurizr.com/dsl |
| `mermaid` | `diagrams/workspace.md` | GitHub, GitLab, Notion (rendered automatically) |

The Structurizr DSL includes styles per construct type (Compute, Storage, Network, Database, Function) and `autoLayout`. The Mermaid output includes emojis per type and a resource legend.

Relationships between constructs are **inferred** from the stack topology (e.g. a single VPC → dashed arrow to the others) and are explicitly marked as inferred. No functional arrow is ever invented.

| Flag | Description | Default |
|------|-----------|--------|
| `--format`, `-f` | Output format (`structurizr`, `mermaid`) | `structurizr` |
| `--stack`, `-s` | Name of a specific stack | all |
| `--out`, `-o` | Output directory | `diagrams` |

---

### `iacmp doctor`

Checks whether the environment has everything iacmp needs.

```bash
iacmp doctor
```

Checks:
- Node.js 20+
- iacmp installed
- AWS CLI, Azure CLI, gcloud CLI, and Terraform CLI (required for real `iacmp deploy`/`destroy` on each provider)
- ANTHROPIC_API_KEY (required for `iacmp ai`)
- sox, whisper.cpp, and a ggml model (required for `/voz` in the chat — see "Voice input")

Use `--fix` to try to automatically fix missing items (asks for confirmation before each action — including installing the cloud CLIs via brew/apt/winget, depending on the system):

```bash
iacmp doctor --fix
```

---

## Writing a stack

Stacks live in `stacks/` and use the constructs from `@iacmp/core`.

### Example: simple web server

```typescript
// stacks/web-server.ts
import { Stack, Compute, Storage } from '@iacmp/core';

const stack = new Stack('web-server');

const servidor = new Compute.Instance(stack, 'Servidor', {
  instanceType: 'small',   // small = t3.small on AWS
  image: 'ubuntu-22.04',
  region: 'us-east-1',
});

const assets = new Storage.Bucket(stack, 'Assets', {
  versioning: true,
  publicAccess: false,
});

export default stack;
```

### Example: serverless API

```typescript
// stacks/api-serverless.ts
import { Stack, Fn, Network } from '@iacmp/core';

const stack = new Stack('api-serverless');

const vpc = new Network.VPC(stack, 'Rede', {
  cidr: '10.0.0.0/16',
  maxAzs: 2,
});

const api = new Fn.Lambda(stack, 'Handler', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 512,
  timeout: 30,
});

export default stack;
```

---

## Available constructs

All constructs are provider-agnostic — the same code works on AWS, Azure, or GCP.

| Construct | O que cria | AWS | Azure | GCP |
|---|---|---|---|---|
| `Compute.Instance` | Virtual machine | EC2 | Azure VM | Compute Engine |
| `Storage.Bucket` | Object storage | S3 | Blob Storage | Cloud Storage |
| `Network.VPC` | Virtual private network | VPC | Virtual Network | VPC Network |
| `Database.SQL` | Relational database | RDS | Azure SQL | Cloud SQL |
| `Fn.Lambda` | Serverless function | Lambda | Azure Functions | Cloud Functions |

### Instance sizes

The `instanceType` is automatically mapped per provider:

| Valor | AWS | Azure | GCP |
|---|---|---|---|
| `small` | t3.small | B1s | e2-small |
| `medium` | t3.medium | B2s | e2-medium |
| `large` | t3.large | B4s | e2-standard-4 |

---

## Configuration

The `iacmp.json` at the project root controls the default behavior:

```json
{
  "name": "meu-projeto",
  "provider": "aws",
  "region": "us-east-1",
  "language": "typescript"
}
```

| Campo | Valores aceitos | Padrão |
|---|---|---|
| `provider` | `aws`, `azure`, `gcp` | `aws` |
| `region` | any valid region for the provider | `us-east-1` |
| `language` | `typescript`, `python` | `typescript` |
| `resourceGroup` | name of an Azure resource group | — (required for `iacmp deploy`/`destroy --provider azure`) |
| `projectId` | ID of a GCP project | — (optional for `iacmp deploy`/`destroy --provider gcp`; uses the default `gcloud` project if omitted) |

---

## Plugin system

iacmp supports custom providers via npm plugins. To use a plugin:

1. Install the package: `npm install iacmp-plugin-digitalocean`
2. Add it to `iacmp.json`:
   ```json
   {
     "plugins": ["iacmp-plugin-digitalocean"]
   }
   ```
3. Use the provider as usual: `iacmp synth --provider digitalocean`

To create a plugin, use `@iacmp/plugin-sdk`:

```javascript
const { definePlugin } = require('@iacmp/plugin-sdk');

module.exports = definePlugin({
  providers: [{
    name: 'meu-provider',
    synthesize(stack) {
      return { /* native template */ };
    },
  }],
});
```

See the complete example in `examples/plugin-exemplo/`.

---

## CI/CD

`iacmp init` automatically generates:

- `.github/workflows/iacmp.yml` — GitHub Actions pipeline that runs `iacmp synth` on every push/PR
- `.gitlab-ci.yml` — equivalent GitLab CI pipeline

---

## Roadmap

| Fase | O que vem | Status |
|---|---|---|
| Phase 1 | Base CLI + constructs + AWS provider | Available |
| Phase 2 | Azure, GCP, and Terraform providers | Available |
| Phase 3 | `iacmp ai` — AI-generated stacks (Claude; experimental OpenAI/Copilot) | Available |
| Phase 4 | Plugin system, watch, dashboard, registry, CI/CD | Available |
| Phase 5 | Integration tests, documentation, examples, npm publishing | Available |
| Phase 6 | Templates in `init`, audits, architecture diagrams | Available |
| Phase 7 | Real `iacmp deploy`/`destroy` on all three clouds | Available — validated by an e2e battery (20 scenarios per provider) |
| Phase 8 | Function code packaging (`Function.Lambda`) on AWS, Azure, GCP, and Terraform | Available — esbuild at deploy time, all three clouds |
| Phase 9 | Study: supporting stacks written in a language other than TypeScript, without changing the `@iacmp/core` API (would require a parallel SDK emitting an equivalent JSON, consumed by `synth.ts`) | Under study — no implementation decision yet |

---

*iacmp — IaC Multi Platform*

To configure `ANTHROPIC_API_KEY` (and optionally `GITHUB_TOKEN`), copy the
`.env.example` from the root to `.env` and fill it in. `iacmp` reads it from
the environment — you can also export the variable in your shell.
