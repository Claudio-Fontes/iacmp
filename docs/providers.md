# Providers

O iacmp suporta múltiplos providers de cloud. O provider define como os constructs abstratos são sintetizados para o formato nativo de cada plataforma.

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

---

## AWS

**Status:** Disponível (Fase 1)

Sintetiza stacks para **CloudFormation JSON**.

### Pré-requisitos

```bash
# Instalar AWS CLI
brew install awscli        # macOS
winget install Amazon.AWSCLI  # Windows

# Configurar credenciais
aws configure
```

### Regiões suportadas

Qualquer região AWS válida. Exemplos: `us-east-1`, `us-west-2`, `sa-east-1` (São Paulo), `eu-west-1`.

### Mapeamento de constructs

| Construct | Recurso CloudFormation |
|---|---|
| `Compute.Instance` | `AWS::EC2::Instance` |
| `Storage.Bucket` | `AWS::S3::Bucket` |
| `Network.VPC` | `AWS::EC2::VPC` |
| `Database.SQL` | `AWS::RDS::DBInstance` |
| `Fn.Lambda` | `AWS::Lambda::Function` |

### Mapeamento de instanceType

| Valor | Instância AWS |
|---|---|
| `small` | t3.small |
| `medium` | t3.medium |
| `large` | t3.large |

### Exemplo de output (CloudFormation)

```json
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Description": "Stack: minha-stack",
  "Resources": {
    "Servidor": {
      "Type": "AWS::EC2::Instance",
      "Properties": {
        "InstanceType": "t3.small",
        "ImageId": "ubuntu-22.04",
        "AvailabilityZone": "us-east-1a"
      }
    }
  }
}
```

---

## Azure

**Status:** Disponível (Fase 2)

Sintetiza stacks para **ARM Template JSON**.

### Pré-requisitos

```bash
brew install azure-cli
az login
```

### Mapeamento de constructs

| Construct | Recurso Azure |
|---|---|
| `Compute.Instance` | `Microsoft.Compute/virtualMachines` |
| `Storage.Bucket` | `Microsoft.Storage/storageAccounts` |
| `Network.VPC` | `Microsoft.Network/virtualNetworks` |
| `Database.SQL` | `Microsoft.Sql/servers` |
| `Fn.Lambda` | `Microsoft.Web/sites` (Functions) |

---

## GCP

**Status:** Disponível (Fase 2)

Sintetiza stacks para **Deployment Manager JSON**.

### Pré-requisitos

```bash
brew install google-cloud-sdk
gcloud auth login
```

### Mapeamento de constructs

| Construct | Recurso GCP |
|---|---|
| `Compute.Instance` | `compute.v1.instance` |
| `Storage.Bucket` | `storage.v1.bucket` |
| `Network.VPC` | `compute.v1.network` |
| `Database.SQL` | `sqladmin.v1beta4.instance` |
| `Fn.Lambda` | `cloudfunctions.v2.function` |

---

## Terraform

**Status:** Disponível (Fase 2)

Sintetiza stacks para **arquivos HCL (`.tf`)**.

### Pré-requisitos

```bash
brew install terraform
```

### Mapeamento de constructs

| Construct | Recurso Terraform |
|---|---|
| `Compute.Instance` | `aws_instance` / `azurerm_linux_virtual_machine` |
| `Storage.Bucket` | `aws_s3_bucket` / `azurerm_storage_account` |
| `Network.VPC` | `aws_vpc` / `azurerm_virtual_network` |
| `Database.SQL` | `aws_db_instance` / `azurerm_sql_server` |
| `Fn.Lambda` | `aws_lambda_function` / `azurerm_linux_function_app` |
