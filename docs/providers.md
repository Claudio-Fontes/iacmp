# Providers

O iacmp suporta três nuvens. O provider define para qual formato nativo os
constructs são sintetizados — e como o `iacmp deploy` os aplica de verdade.

| Provider | Formato de synth | Deploy via | Cobertura e2e |
|---|---|---|---|
| `aws` | CloudFormation JSON | `aws cloudformation package` + `deploy` | 20/20 cenários |
| `azure` | Bicep (Deployment Stacks) | `az stack group create` | 20/20 cenários |
| `gcp` | Terraform (tf.json) | `terraform apply` | 20/20 cenários |
| `aws --format tf` | Terraform (tf.json) | `terraform apply` | deploy real validado |
| `azure --format tf` | Terraform (azurerm) | `terraform apply` | deploy real validado |

---

## Configurando o provider

No `iacmp.json` do projeto:

```json
{
  "provider": "aws",
  "region": "us-east-1"
}
```

Ou via flag em cada comando:

```bash
iacmp synth --provider aws
iacmp deploy --provider azure
```

Campos específicos por nuvem no `iacmp.json`: `resourceGroup` e `azureRegion`
(Azure), `projectId` e `gcpRegion` (GCP), `drRegion` (AWS, stacks de DR),
`accountTier` (`free`/`standard` — ajusta SKUs e emite avisos de tier).

## Onde ficam os artefatos sintetizados

`iacmp synth` escreve em `synth-out/<provider>/`. Cada provider tem sua
subpasta — sintetizar a mesma stack para múltiplos providers nunca sobrescreve
resultados. Os consumidores (`deploy`, `destroy`, `diff`, `dashboard`) leem da
mesma subpasta.

| Provider | Path | Conteúdo |
|---|---|---|
| AWS | `synth-out/aws/<stack>.json` | CloudFormation por stack |
| Azure | `synth-out/azure/<stack>.bicep` + `_main.bicep` | módulos Bicep + deployment único |
| GCP | `synth-out/gcp/<stack>.tf.json` + `_providers.tf.json` | root module Terraform único |
| AWS via Terraform | `synth-out/aws-tf/` | tf.json + `_providers.tf.json` |
| Azure via Terraform | `synth-out/azure-tf/` | tf.json (azurerm) + `_providers.tf.json` |

---

## AWS

Sintetiza **CloudFormation JSON**, uma stack por arquivo, com Export/ImportValue
para referências cross-stack. O deploy ordena as stacks por dependência,
empacota handlers (`aws cloudformation package`) e protege contra recursos
órfãos com `DeletionPolicy: Retain` (detecção pré-deploy com confirmação).

```bash
brew install awscli   # ou winget install Amazon.AWSCLI
aws configure
```

Qualquer região AWS válida (`us-east-1`, `sa-east-1`, …). Stacks marcadas para
DR deployam na `drRegion` do `iacmp.json`.

## Azure

Sintetiza **Bicep** — uma stack por módulo, amarradas por um `_main.bicep` de
deployment único: o ARM resolve ordem e referências simbolicamente, e o destroy
remove a deployment stack inteira (`az stack group`). O deploy também builda os
handlers (esbuild), publica via `config-zip` nas Function Apps e ativa static
websites (data-plane) quando o synth os declara.

```bash
brew install azure-cli
az login
```

Particularidades cobertas pelo synth/deploy: plano Consumption compartilhado
para Functions, APIM (inclusive compartilhado entre projetos via
`azure.sharedApim`), Container Apps com build de imagem (Docker local ou ACR
Tasks), Cosmos DB serverless, Key Vault, Event Grid com 2º passo automático
para ciclos de referência.

## GCP

Sintetiza **Terraform (tf.json)** — o formato nativo do provider GCP. Todos os
`<stack>.tf.json` do projeto formam UM root module (state único); os blocos
`terraform`/`provider`/`variable` ficam em `_providers.tf.json`, uma vez por
diretório. O deploy faz pré-flight (habilita APIs necessárias e concede roles à
default compute service account), builda e sobe os handlers para o bucket de
artefatos (objetos versionados por hash de conteúdo) e roda `terraform apply`.

```bash
brew install google-cloud-sdk terraform
gcloud auth login && gcloud auth application-default login
```

Particularidades cobertas: Cloud Functions gen2 com adapter HTTP/CloudEvent,
API Gateway com OpenAPI + SA invoker, Cloud SQL privado (private service
access), Memorystore com TLS/auth, Cloud Armor, serverless NEG atrás de LB
global, Firestore `(default)` importado automaticamente quando já existe.

## Terraform (`--format tf`)

Terraform não é um provider isolado — é um **formato alternativo de saída** para
AWS e Azure:

```bash
iacmp synth  --provider aws   --format tf   # → synth-out/aws-tf/
iacmp deploy --provider aws   --format tf   # terraform init/apply
iacmp synth  --provider azure --format tf   # → synth-out/azure-tf/ (azurerm)
iacmp deploy --provider azure --format tf
```

O diretório inteiro é um state único (sem `--stack` no deploy/destroy);
referências cross-stack viram referências diretas de recurso. Requer o binário
`terraform` no PATH (`iacmp doctor` confere).

---

## Mapeamento de constructs

A tabela completa AWS ↔ Azure ↔ GCP, construct por construct, está em
[constructs.md](constructs.md).

## Providers customizados

Providers fora dos nativos entram via `@iacmp/plugin-sdk` — veja
[arquitetura.md](arquitetura.md#como-o-plugin-system-funciona).
