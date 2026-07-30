# Providers

iacmp supports three clouds. The provider determines which native format the
constructs are synthesized to — and how `iacmp deploy` actually applies them.

| Provider | Synth format | Deploy via | e2e coverage |
|---|---|---|---|
| `aws` | CloudFormation JSON | `aws cloudformation package` + `deploy` | 20/20 scenarios |
| `azure` | Bicep (Deployment Stacks) | `az stack group create` | 20/20 scenarios |
| `gcp` | Terraform (tf.json) | `terraform apply` | 20/20 scenarios |
| `aws --format tf` | Terraform (tf.json) | `terraform apply` | validated with real deploys |
| `azure --format tf` | Terraform (azurerm) | `terraform apply` | validated with real deploys |

---

## Configuring the provider

In the project's `iacmp.json`:

```json
{
  "provider": "aws",
  "region": "us-east-1"
}
```

Or via a flag on each command:

```bash
iacmp synth --provider aws
iacmp deploy --provider azure
```

Cloud-specific fields in `iacmp.json`: `resourceGroup` and `azureRegion`
(Azure), `projectId` and `gcpRegion` (GCP), `drRegion` (AWS, DR stacks),
`accountTier` (`free`/`standard` — adjusts SKUs and emits tier warnings).

## Where synthesized artifacts live

`iacmp synth` writes to `synth-out/<provider>/`. Each provider has its own
subfolder — synthesizing the same stack for multiple providers never overwrites
results. Consumers (`deploy`, `destroy`, `diff`, `dashboard`) read from the
same subfolder.

| Provider | Path | Contents |
|---|---|---|
| AWS | `synth-out/aws/<stack>.json` | CloudFormation per stack |
| Azure | `synth-out/azure/<stack>.bicep` + `_main.bicep` | Bicep modules + single deployment |
| GCP | `synth-out/gcp/<stack>.tf.json` + `_providers.tf.json` | single Terraform root module |
| AWS via Terraform | `synth-out/aws-tf/` | tf.json + `_providers.tf.json` |
| Azure via Terraform | `synth-out/azure-tf/` | tf.json (azurerm) + `_providers.tf.json` |

---

## AWS

Synthesizes **CloudFormation JSON**, one stack per file, with Export/ImportValue
for cross-stack references. Deploy orders stacks by dependency, packages
handlers (`aws cloudformation package`), and guards against orphaned resources
with `DeletionPolicy: Retain` (pre-deploy detection with confirmation).

```bash
brew install awscli   # or winget install Amazon.AWSCLI
aws configure
```

Any valid AWS region (`us-east-1`, `sa-east-1`, …). Stacks marked for DR
deploy to the `drRegion` from `iacmp.json`.

## Azure

Synthesizes **Bicep** — one stack per module, tied together by a single-deployment
`_main.bicep`: ARM resolves ordering and references symbolically, and destroy
removes the entire deployment stack (`az stack group`). Deploy also builds the
handlers (esbuild), publishes them via `config-zip` to the Function Apps, and
enables static websites (data-plane) when the synth declares them.

```bash
brew install azure-cli
az login
```

Particulars covered by synth/deploy: shared Consumption plan for Functions,
APIM (including shared across projects via `azure.sharedApim`), Container Apps
with image build (local Docker or ACR Tasks), Cosmos DB serverless, Key Vault,
Event Grid with an automatic second pass for reference cycles.

## GCP

Synthesizes **Terraform (tf.json)** — the native format of the GCP provider. All
the project's `<stack>.tf.json` files form ONE root module (single state); the
`terraform`/`provider`/`variable` blocks live in `_providers.tf.json`, once per
directory. Deploy runs a pre-flight (enables required APIs and grants roles to
the default compute service account), builds and uploads the handlers to the
artifacts bucket (objects versioned by content hash), and runs `terraform apply`.

```bash
brew install google-cloud-sdk terraform
gcloud auth login && gcloud auth application-default login
```

Particulars covered: Cloud Functions gen2 with HTTP/CloudEvent adapter,
API Gateway with OpenAPI + SA invoker, private Cloud SQL (private service
access), Memorystore with TLS/auth, Cloud Armor, serverless NEG behind a global
LB, Firestore `(default)` imported automatically when it already exists.

## Terraform (`--format tf`)

Terraform is not a standalone provider — it is an **alternative output format**
for AWS and Azure:

```bash
iacmp synth  --provider aws   --format tf   # → synth-out/aws-tf/
iacmp deploy --provider aws   --format tf   # terraform init/apply
iacmp synth  --provider azure --format tf   # → synth-out/azure-tf/ (azurerm)
iacmp deploy --provider azure --format tf
```

The entire directory is a single state (no `--stack` on deploy/destroy);
cross-stack references become direct resource references. Requires the
`terraform` binary on PATH (`iacmp doctor` checks for it).

---

## Construct mapping

The complete AWS ↔ Azure ↔ GCP table, construct by construct, is in
[constructs.md](constructs.md).

## Custom providers

Providers beyond the native ones plug in via `@iacmp/plugin-sdk` — see
[architecture.md](architecture.md#como-o-plugin-system-funciona).
