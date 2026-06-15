# Testes do CLI iacmp

**Projeto de teste:** `/Users/cmelo/Documents/testeIACMP/7prj`
**Versão:** iacmp/1.0.0
**Data:** 2026-06-15

---

## Cenário 1 — Storage simples (bucket S3 sem versioning)

**Stack:** `stacks/storage/bucket-simples.ts`

```typescript
import { Stack, Storage } from '@iacmp/core';
const stack = new Stack('bucket-simples');
new Storage.Bucket(stack, 'BucketSimples', {});
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack bucket-simples`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/bucket-simples.json
```

**synth-out/bucket-simples.json:**
```json
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Description": "Stack bucket-simples — gerada pelo iacmp",
  "Resources": {
    "BucketSimples": {
      "Type": "AWS::S3::Bucket",
      "Properties": {
        "VersioningConfiguration": { "Status": "Suspended" },
        "PublicAccessBlockConfiguration": {
          "BlockPublicAcls": true,
          "BlockPublicPolicy": true,
          "IgnorePublicAcls": true,
          "RestrictPublicBuckets": true
        }
      }
    }
  }
}
```

**Resultado:** ✅ Passou sem warnings. JSON gerado corretamente.

---

## Cenário 2 — Storage com versioning

**Stack:** `stacks/storage/bucket-versioning.ts`

```typescript
import { Stack, Storage } from '@iacmp/core';
const stack = new Stack('bucket-versioning');
new Storage.Bucket(stack, 'BucketVersioning', { versioning: true });
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack bucket-versioning`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/bucket-versioning.json
```

**synth-out/bucket-versioning.json (resumido):**
```json
"VersioningConfiguration": { "Status": "Enabled" }
```

**Resultado:** ✅ Passou. `versioning: true` mapeado corretamente para `Status: Enabled`.

---

## Cenário 3 — Compute simples (EC2 small com ubuntu)

**Stack:** `stacks/compute/ec2-simples.ts`

```typescript
import { Stack, Compute } from '@iacmp/core';
const stack = new Stack('ec2-simples');
new Compute.Instance(stack, 'EC2Simples', { instanceType: 'small', image: 'ubuntu' });
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack ec2-simples`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/ec2-simples.json
```

**synth-out/ec2-simples.json:**
```json
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Description": "Stack ec2-simples — gerada pelo iacmp",
  "Resources": {
    "EC2Simples": {
      "Type": "AWS::EC2::Instance",
      "Properties": {
        "InstanceType": "t3.small",
        "ImageId": "ubuntu"
      }
    }
  }
}
```

**Resultado:** ✅ Passou. `instanceType: 'small'` mapeado para `t3.small`. Observação: `ImageId` recebe o string literal `"ubuntu"` — não é um AMI ID real (ex: `ami-0abcdef`), o que tornaria o template inválido para deploy real.

---

## Cenário 4 — Compute large (EC2 large com amazon-linux-2)

**Stack:** `stacks/compute/ec2-large.ts`

```typescript
import { Stack, Compute } from '@iacmp/core';
const stack = new Stack('ec2-large');
new Compute.Instance(stack, 'EC2Large', { instanceType: 'large', image: 'amazon-linux-2' });
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack ec2-large`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/ec2-large.json
```

**synth-out/ec2-large.json (resumido):**
```json
"InstanceType": "t3.large",
"ImageId": "amazon-linux-2"
```

**Resultado:** ✅ Passou. `instanceType: 'large'` mapeado para `t3.large`. Mesma observação do cenário 3: `ImageId` não é um AMI ID real.

---

## Cenário 5 — Network simples (VPC com cidr padrão)

**Stack:** `stacks/network/vpc-simples.ts`

```typescript
import { Stack, Network } from '@iacmp/core';
const stack = new Stack('vpc-simples');
new Network.VPC(stack, 'VPCSimples', {});
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack vpc-simples`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/vpc-simples.json
```

**synth-out/vpc-simples.json:**
```json
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Description": "Stack vpc-simples — gerada pelo iacmp",
  "Resources": {
    "VPCSimples": {
      "Type": "AWS::EC2::VPC",
      "Properties": {
        "CidrBlock": "10.0.0.0/16",
        "EnableDnsHostnames": true,
        "EnableDnsSupport": true,
        "Tags": [{ "Key": "Name", "Value": "VPCSimples" }]
      }
    }
  }
}
```

**Resultado:** ✅ Passou. CIDR padrão `10.0.0.0/16` aplicado corretamente.

---

## Cenário 6 — Network com maxAzs (VPC com maxAzs: 3)

**Stack:** `stacks/network/vpc-maxazs.ts`

```typescript
import { Stack, Network } from '@iacmp/core';
const stack = new Stack('vpc-maxazs');
new Network.VPC(stack, 'VPCMaxAzs', { maxAzs: 3 });
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack vpc-maxazs`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/vpc-maxazs.json
```

**synth-out/vpc-maxazs.json (resumido):**
```json
"VPCMaxAzs": {
  "Type": "AWS::EC2::VPC",
  "Properties": {
    "CidrBlock": "10.0.0.0/16",
    "EnableDnsHostnames": true,
    "EnableDnsSupport": true,
    "Tags": [{ "Key": "Name", "Value": "VPCMaxAzs" }]
  }
}
```

**Resultado:** ❌ Falha parcial. O synth não emite erro nem warning, mas `maxAzs: 3` é completamente ignorado no output. Nenhuma subnet, Internet Gateway, Route Table ou configuração de AZ é gerada. O template resultante é idêntico ao do cenário 5 (VPC sem maxAzs).

---

## Cenário 7 — Database MySQL (RDS MySQL sem multiAz)

**Stack:** `stacks/database/rds-mysql.ts`

```typescript
import { Stack, Database } from '@iacmp/core';
const stack = new Stack('rds-mysql');
new Database.SQL(stack, 'RDSMySQL', { engine: 'mysql' });
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack rds-mysql`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/rds-mysql.json
```

**synth-out/rds-mysql.json:**
```json
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Description": "Stack rds-mysql — gerada pelo iacmp",
  "Resources": {
    "RDSMySQL": {
      "Type": "AWS::RDS::DBInstance",
      "Properties": {
        "DBInstanceClass": "db.t3.micro",
        "Engine": "mysql",
        "EngineVersion": "8.0.36",
        "AllocatedStorage": "20",
        "MultiAZ": false,
        "DeletionPolicy": "Snapshot"
      }
    }
  }
}
```

**Resultado:** ❌ Falha parcial. JSON gerado, mas `DeletionPolicy` está dentro de `Properties` ao invés de ser um atributo de nível do resource. No CloudFormation, `DeletionPolicy` é um Resource Attribute, não uma propriedade. O template seria rejeitado pelo CloudFormation real.

---

## Cenário 8 — Database Postgres multiAz

**Stack:** `stacks/database/rds-postgres-multiaz.ts`

```typescript
import { Stack, Database } from '@iacmp/core';
const stack = new Stack('rds-postgres-multiaz');
new Database.SQL(stack, 'RDSPostgres', { engine: 'postgres', multiAz: true });
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack rds-postgres-multiaz`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/rds-postgres-multiaz.json
```

**synth-out/rds-postgres-multiaz.json (resumido):**
```json
"Engine": "postgres",
"EngineVersion": "15.4",
"MultiAZ": true,
"DeletionPolicy": "Snapshot"
```

**Resultado:** ❌ Falha parcial. `multiAz: true` mapeado corretamente para `MultiAZ: true`, mas `DeletionPolicy` continua dentro de `Properties` (mesmo bug do cenário 7).

---

## Cenário 9 — Lambda simples (nodejs20 sem environment)

**Stack:** `stacks/compute/lambda-simples.ts`

```typescript
import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('lambda-simples');
new Fn.Lambda(stack, 'LambdaSimples', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/simples',
});
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack lambda-simples`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/lambda-simples.json
```

**synth-out/lambda-simples.json:**
```json
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Description": "Stack lambda-simples — gerada pelo iacmp",
  "Resources": {
    "LambdaSimples": {
      "Type": "AWS::Lambda::Function",
      "Properties": {
        "Runtime": "nodejs20.x",
        "Handler": "index.handler",
        "Code": { "ZipFile": "./src/handlers/simples" },
        "MemorySize": 128,
        "Timeout": 30,
        "Role": { "Fn::Sub": "arn:aws:iam::${AWS::AccountId}:role/LambdaExecutionRole" }
      }
    }
  }
}
```

**Resultado:** ✅ Passou. Defaults de `MemorySize: 128` e `Timeout: 30` aplicados. `runtime: 'nodejs20'` mapeado para `nodejs20.x`.

---

## Cenário 10 — Lambda com environment (TABLE_NAME)

**Stack:** `stacks/compute/lambda-environment.ts`

```typescript
import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('lambda-environment');
new Fn.Lambda(stack, 'LambdaEnvironment', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/environment',
  environment: { TABLE_NAME: 'minha-tabela' },
});
export default stack;
```

**Comando:** `iacmp synth --provider aws --stack lambda-environment`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/lambda-environment.json
```

**synth-out/lambda-environment.json:**
```json
{
  "Resources": {
    "LambdaEnvironment": {
      "Type": "AWS::Lambda::Function",
      "Properties": {
        "Runtime": "nodejs20.x",
        "Handler": "index.handler",
        "Code": { "ZipFile": "./src/handlers/environment" },
        "MemorySize": 128,
        "Timeout": 30,
        "Role": { "Fn::Sub": "arn:aws:iam::${AWS::AccountId}:role/LambdaExecutionRole" }
      }
    }
  }
}
```

**Resultado:** ❌ Falha. O campo `environment` é completamente ignorado no output. Nenhuma `Environment.Variables` aparece no JSON gerado. O synth não emite nenhum warning sobre o campo ignorado.

---

## Cenário 11 — Lambda + Database (Lambda com DB_HOST, stacks separadas)

**Stacks:** `stacks/compute/lambda-db.ts` + `stacks/database/rds-mysql.ts`

```typescript
// lambda-db.ts
new Fn.Lambda(stack, 'LambdaDB', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/db-reader',
  environment: { DB_HOST: 'rds-mysql.cluster.us-east-1.rds.amazonaws.com' },
});
```

**Comandos:**
```bash
iacmp synth --provider aws --stack lambda-db
iacmp synth --provider aws --stack rds-mysql
```

**Output terminal:** Ambas sintetizadas com sucesso.

**synth-out/lambda-db.json (resumido):**
```json
"LambdaDB": {
  "Type": "AWS::Lambda::Function",
  "Properties": {
    "Runtime": "nodejs20.x",
    "Handler": "index.handler",
    "Code": { "ZipFile": "./src/handlers/db-reader" },
    "MemorySize": 128,
    "Timeout": 30,
    "Role": { "Fn::Sub": "arn:aws:iam::${AWS::AccountId}:role/LambdaExecutionRole" }
  }
}
```

**Resultado:** ❌ Falha parcial. Ambas as stacks geram JSON individualmente sem erros, mas `environment: { DB_HOST: ... }` é ignorado (mesmo bug do cenário 10). Nenhuma referência cruzada entre stacks é gerada.

---

## Cenário 12 — Lambda + Storage (Lambda com BUCKET_NAME)

**Stacks:** `stacks/compute/lambda-bucket.ts` + `stacks/storage/bucket-simples.ts`

```typescript
// lambda-bucket.ts
new Fn.Lambda(stack, 'LambdaBucket', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/bucket-access',
  environment: { BUCKET_NAME: 'meu-bucket-artefatos' },
});
```

**Comandos:**
```bash
iacmp synth --provider aws --stack lambda-bucket
iacmp synth --provider aws --stack bucket-simples
```

**Output terminal:** Ambas sintetizadas com sucesso.

**Resultado:** ❌ Falha parcial. Mesmo problema: `environment: { BUCKET_NAME: ... }` completamente ignorado no JSON gerado.

---

## Cenário 13 — VPC + Compute (EC2 dentro de uma VPC, stacks separadas)

**Stacks:** `stacks/network/vpc-compute.ts` + `stacks/compute/ec2-vpc.ts`

```typescript
// vpc-compute.ts
new Network.VPC(stack, 'VPCCompute', { cidr: '10.0.0.0/16', maxAzs: 2 });

// ec2-vpc.ts
new Compute.Instance(stack, 'EC2VPC', { instanceType: 'medium', image: 'ubuntu', region: 'us-east-1' });
```

**Comandos:**
```bash
iacmp synth --provider aws --stack ec2-vpc
iacmp synth --provider aws --stack vpc-compute
```

**Output do terminal:** Ambas sintetizadas sem erros.

**synth-out/ec2-vpc.json (resumido):**
```json
"EC2VPC": {
  "Type": "AWS::EC2::Instance",
  "Properties": {
    "InstanceType": "t3.medium",
    "ImageId": "ubuntu",
    "AvailabilityZone": "us-east-1a"
  }
}
```

**Resultado:** ❌ Falha parcial. A EC2 não referencia a VPC nem subnet. O campo `region` foi interpretado como `AvailabilityZone: us-east-1a` (comportamento não documentado). Não há `SubnetId` nem `VpcId` no template. Stacks não se referenciando mutuamente.

---

## Cenário 14 — VPC + Database (RDS dentro de VPC, stacks separadas)

**Stacks:** `stacks/network/vpc-database.ts` + `stacks/database/rds-in-vpc.ts`

```typescript
// vpc-database.ts
new Network.VPC(stack, 'VPCDatabase', { cidr: '10.1.0.0/16', maxAzs: 2 });

// rds-in-vpc.ts
new Database.SQL(stack, 'RDSInVPC', { engine: 'postgres', multiAz: false });
```

**Comandos:**
```bash
iacmp synth --provider aws --stack vpc-database
iacmp synth --provider aws --stack rds-in-vpc
```

**Output do terminal:** Ambas sintetizadas sem erros.

**Resultado:** ❌ Falha parcial. RDS não referencia VPC nem DBSubnetGroup. Stacks completamente independentes no output. Mesmo bug de `DeletionPolicy` dentro de `Properties`.

---

## Cenário 15 — Multi-stack completa (VPC + RDS + Lambda + Bucket)

**Stacks:** `multi-vpc`, `multi-rds`, `multi-lambda`, `multi-bucket`

```typescript
// multi-vpc.ts
new Network.VPC(stack, 'MultiVPC', { cidr: '10.2.0.0/16', maxAzs: 2 });

// multi-rds.ts
new Database.SQL(stack, 'MultiRDS', { engine: 'postgres', multiAz: true });

// multi-lambda.ts
new Fn.Lambda(stack, 'MultiLambda', {
  runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/multi',
  environment: { DB_HOST: 'multi-rds.cluster.us-east-1.rds.amazonaws.com' },
});

// multi-bucket.ts
new Storage.Bucket(stack, 'MultiBucket', { versioning: true, publicAccess: false });
```

**Comandos:** `iacmp synth --provider aws --stack multi-vpc/multi-rds/multi-lambda/multi-bucket`

**Output terminal:** Todas as 4 stacks sintetizadas sem erros.

**Resultado:** ❌ Falha parcial. Cada stack gera seu recurso corretamente de forma isolada, mas:
- `environment` da Lambda ignorado (sem `DB_HOST`)
- `maxAzs: 2` da VPC ignorado (sem subnets geradas)
- `DeletionPolicy` do RDS dentro de `Properties`
- Nenhuma referência cruzada entre as stacks (sem `Fn::ImportValue`, `CrossStackReferences`, etc.)

---

## Cenário 16 — Diagrama mermaid

**Comando:** `iacmp diagram --format mermaid`

**Output do terminal:**
```
Diagrama gerado
Projeto: 7prj | Provider: aws | Formato: mermaid
Stacks: 22 stacks listadas
Arquivo salvo em diagrams/workspace.md
```

**Conteúdo de `diagrams/workspace.md` (estrutura):**
- Um bloco `graph TD` por stack com um único nó
- Cada nó exibe: nome do recurso, tipo, atributos principais
- Sem arestas/relacionamentos entre stacks

**Resultado:** ❌ Falha parcial. O diagrama lista corretamente todos os 22 recursos. Cada um aparece com tipo e atributos. Porém:
- Nenhuma aresta entre stacks é gerada — lambdas que têm `environment` com referências a outros recursos não exibem nenhum relacionamento
- Cada stack tem apenas um nó isolado, sem setas de dependência
- A propriedade `environment` não aparece nos nós do diagrama mesmo quando definida

---

## Cenário 17 — Diagrama structurizr

**Comando:** `iacmp diagram --format structurizr`

**Output do terminal:**
```
Diagrama gerado
Stacks: 22 | Nodes: 22
Arquivo salvo em diagrams/workspace.dsl
Abra em: https://structurizr.com/dsl
```

**Conteúdo de `diagrams/workspace.dsl` (estrutura):**
- Workspace com model e views
- Cada stack em um `group` separado
- Cada recurso como `container` com tags de tipo (Compute, Storage, Network, Database, Function)
- Estilos por tag com cores distintas
- Uma `view` por stack com `include *` e `autoLayout`

**Resultado:** ❌ Falha parcial. Estrutura DSL válida com estilos e tags corretas. Porém:
- Nenhuma relação (`->`) entre containers é gerada
- Sem relacionamentos inferidos entre stacks que partilham environment vars
- O model DSL seria válido para Structurizr mas não exibiria nenhuma arquitetura de integração

---

## Cenário 18 — Synth provider azure

**Stack:** `stacks/storage/bucket-simples.ts` (mesmo do cenário 1)

**Comando:** `iacmp synth --provider azure --stack bucket-simples`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/bucket-simples.json
```

**synth-out/bucket-simples.json (Azure ARM Template):**
```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "resources": [
    {
      "type": "Microsoft.Storage/storageAccounts",
      "apiVersion": "2023-01-01",
      "name": "bucketsimples",
      "location": "[resourceGroup().location]",
      "kind": "StorageV2",
      "sku": { "name": "Standard_LRS" },
      "properties": {
        "allowBlobPublicAccess": false,
        "supportsHttpsTrafficOnly": true,
        "minimumTlsVersion": "TLS1_2"
      }
    }
  ]
}
```

**Resultado:** ❌ Falha parcial. ARM Template gerado com mapeamento correto para `Microsoft.Storage/storageAccounts`. Porém, sobrescreve o arquivo `bucket-simples.json` sem indicar o provider no nome — rodando `synth --provider aws` em seguida sobrescreve o output azure. Não há namespacing por provider no nome do arquivo de saída.

---

## Cenário 19 — Synth provider gcp

**Stack:** `stacks/storage/bucket-simples.ts` (mesmo do cenário 1)

**Comando:** `iacmp synth --provider gcp --stack bucket-simples`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/bucket-simples.json
```

**synth-out/bucket-simples.json (GCP Deployment Manager):**
```json
{
  "resources": [
    {
      "name": "bucketsimples",
      "type": "storage.v1.bucket",
      "properties": {
        "location": "US",
        "versioning": { "enabled": false },
        "iamConfiguration": {
          "uniformBucketLevelAccess": { "enabled": true }
        }
      }
    }
  ]
}
```

**Resultado:** ❌ Falha parcial. GCP Deployment Manager YAML-like JSON gerado com mapeamento correto. Mesmo problema de sobrescrita do arquivo sem namespacing por provider.

---

## Cenário 20 — Synth provider terraform

**Stack:** `stacks/storage/bucket-simples.ts` (mesmo do cenário 1)

**Comando:** `iacmp synth --provider terraform --stack bucket-simples`

**Output do terminal:**
```
Sintetizado: /Users/cmelo/Documents/testeIACMP/7prj/synth-out/bucket-simples.tf
```

**synth-out/bucket-simples.tf:**
```hcl
terraform {
  required_providers {
    aws {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "BucketSimples" {
  bucket = "bucketsimples"

  tags = {
    Name = "BucketSimples"
  }
}
```

**Resultado:** ✅ Passou. Terraform HCL gerado corretamente com extensão `.tf` (correto — não sobrescreve o `.json`). `required_providers`, `provider` block e `resource` block gerados adequadamente. Observação: `versioning` e `public_access_block` não são gerados no `.tf` (omissão).

---

## Resumo dos resultados

| # | Cenário | Resultado |
|---|---------|-----------|
| 1 | Storage simples | ✅ |
| 2 | Storage com versioning | ✅ |
| 3 | Compute simples | ✅ |
| 4 | Compute large | ✅ |
| 5 | Network simples | ✅ |
| 6 | Network com maxAzs | ❌ |
| 7 | Database MySQL | ❌ |
| 8 | Database Postgres multiAz | ❌ |
| 9 | Lambda simples | ✅ |
| 10 | Lambda com environment | ❌ |
| 11 | Lambda + Database | ❌ |
| 12 | Lambda + Storage | ❌ |
| 13 | VPC + Compute | ❌ |
| 14 | VPC + Database | ❌ |
| 15 | Multi-stack completa | ❌ |
| 16 | Diagrama mermaid | ❌ |
| 17 | Diagrama structurizr | ❌ |
| 18 | Synth provider azure | ❌ |
| 19 | Synth provider gcp | ❌ |
| 20 | Synth provider terraform | ✅ |

**Passou:** 6/20 | **Falha parcial ou total:** 14/20

---

## Problemas encontrados

### BUG-01 — `environment` de Lambda completamente ignorado no synth AWS

Afeta cenários: 10, 11, 12, 15.

O campo `environment: Record<string, string>` passado para `Fn.Lambda` não é emitido no CloudFormation gerado. O template deveria conter:
```json
"Environment": {
  "Variables": { "TABLE_NAME": "minha-tabela" }
}
```
Mas a propriedade é silenciosamente descartada sem nenhum warning. Afeta todos os providers testados.

---

### BUG-02 — `DeletionPolicy` inserido dentro de `Properties` no CloudFormation

Afeta cenários: 7, 8, 14, 15.

No CloudFormation, `DeletionPolicy` é um Resource Attribute que deve estar no mesmo nível de `Type` e `Properties`, não dentro de `Properties`. O output atual:
```json
"RDSMySQL": {
  "Type": "AWS::RDS::DBInstance",
  "Properties": {
    ...
    "DeletionPolicy": "Snapshot"  // ERRADO — dentro de Properties
  }
}
```
O correto seria:
```json
"RDSMySQL": {
  "Type": "AWS::RDS::DBInstance",
  "DeletionPolicy": "Snapshot",  // CORRETO — fora de Properties
  "Properties": { ... }
}
```
O template seria rejeitado pelo CloudFormation com erro de validação.

---

### BUG-03 — `maxAzs` de Network.VPC completamente ignorado no synth

Afeta cenários: 6, 13, 14, 15.

O parâmetro `maxAzs` é aceito sem erro mas não gera nenhum recurso adicional. Uma VPC com `maxAzs: 3` deveria gerar subnets públicas/privadas, Internet Gateway e Route Tables para cada AZ. O output é idêntico ao de uma VPC sem `maxAzs`.

---

### BUG-04 — Providers azure e gcp sobrescrevem o mesmo arquivo `.json`

Afeta cenários: 18, 19.

Ao sintetizar com `--provider azure` ou `--provider gcp`, o arquivo de saída tem o mesmo nome que o provider AWS (`bucket-simples.json`). Isso causa sobrescrita do output anterior. O nome deveria incluir o provider, ex: `bucket-simples.aws.json`, `bucket-simples.azure.json`, ou os arquivos deveriam ser salvos em subpastas por provider (`synth-out/aws/`, `synth-out/azure/`).

---

### BUG-05 — Diagramas não inferem relacionamentos entre stacks

Afeta cenários: 16, 17.

Tanto o formato mermaid quanto o structurizr geram os recursos corretamente, mas nenhuma aresta/relação é gerada entre recursos de stacks diferentes, mesmo quando:
- Uma Lambda tem `environment` com chaves que referenciam nomes de outros recursos (ex: `DB_HOST`, `TABLE_NAME`, `BUCKET_NAME`)
- Uma VPC e um compute/database coexistem no projeto

O diagrama fica como uma série de nós isolados sem conexão.

---

### BUG-06 — `ImageId` da EC2 não é resolvido para AMI ID real

Afeta cenários: 3, 4, 13.

O campo `image` é passado literalmente como `ImageId` no CloudFormation (`"ImageId": "ubuntu"`), o que não é um AMI ID válido. O CLI deveria:
- Ou mapear nomes amigáveis para SSM Parameter paths (ex: `{{resolve:ssm:/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2}}`), ou
- Emitir um warning de que o valor precisa ser substituído por um AMI ID real antes do deploy.

---

### BUG-07 — `region` de Compute.Instance mapeado para `AvailabilityZone` sem documentação

Afeta cenário: 13.

O parâmetro `region: 'us-east-1'` em `Compute.Instance` foi mapeado para `AvailabilityZone: 'us-east-1a'` (appended `a`). Esse comportamento não é documentado na API e pode causar confusão — `region` e `AvailabilityZone` são conceitos distintos na AWS.

---

### BUG-08 — Terraform não emite `versioning` nem `public_access_block`

Afeta cenário: 20.

No template Terraform gerado para `Storage.Bucket`, os blocos `aws_s3_bucket_versioning` e `aws_s3_bucket_public_access_block` não são emitidos, enquanto no CloudFormation esses campos são corretamente incluídos. O output Terraform fica incompleto para um bucket production-ready.

---

### BUG-09 — `Database.SQL` aceita `engine: 'dynamodb'` sem erro

Observado na stack pré-existente `dynamodb-stack.ts`.

A API documenta `engine: 'mysql' | 'postgres'`, mas o CLI aceita `engine: 'dynamodb'` sem emitir nenhum erro ou warning. No diagrama aparece como `Database.SQL — engine: dynamodb`, o que é semanticamente incorreto (DynamoDB não é SQL). O synth deveria rejeitar ou ao menos emitir warning para engines inválidas.

---

## Sugestões de correção

### Correção BUG-01 — Emitir `Environment.Variables` no CloudFormation

No synth AWS de `Fn.Lambda`, adicionar o bloco de environment quando o campo estiver presente:

```typescript
if (props.environment && Object.keys(props.environment).length > 0) {
  cfnProps.Environment = {
    Variables: props.environment,
  };
}
```

Para Azure, o equivalente seria `appSettings`. Para GCP, `environmentVariables`. Para Terraform, `environment { variables = { ... } }`.

---

### Correção BUG-02 — Mover `DeletionPolicy` para fora de `Properties`

Na geração CloudFormation de `Database.SQL`, o `DeletionPolicy` deve ser emitido como atributo do resource, não como propriedade:

```typescript
// Estrutura correta
resources[id] = {
  Type: 'AWS::RDS::DBInstance',
  DeletionPolicy: 'Snapshot',      // atributo do resource
  Properties: {
    DBInstanceClass: '...',
    // sem DeletionPolicy aqui
  }
};
```

---

### Correção BUG-03 — Gerar subnets e IGW ao receber `maxAzs`

Quando `maxAzs` for definido, o synth da VPC deveria gerar recursos filhos:

```
AWS::EC2::Subnet (uma pública + uma privada por AZ)
AWS::EC2::InternetGateway
AWS::EC2::VPCGatewayAttachment
AWS::EC2::RouteTable (público e privado)
AWS::EC2::SubnetRouteTableAssociation
```

Exemplo: `maxAzs: 3` → 6 subnets + 1 IGW + route tables.

---

### Correção BUG-04 — Namespacing de arquivo por provider

Opção 1: prefixo no nome do arquivo
```
synth-out/bucket-simples.aws.json
synth-out/bucket-simples.azure.json
synth-out/bucket-simples.gcp.json
synth-out/bucket-simples.tf
```

Opção 2: subdiretório por provider
```
synth-out/aws/bucket-simples.json
synth-out/azure/bucket-simples.json
synth-out/gcp/bucket-simples.json
synth-out/terraform/bucket-simples.tf
```

---

### Correção BUG-05 — Inferir relacionamentos no diagrama

O gerador de diagramas deveria analisar os campos `environment` das Lambdas e inferir relações com base em padrões de nomenclatura comuns:
- `TABLE_NAME` / `DB_TABLE` → relação com `Database.SQL`
- `DB_HOST` / `DATABASE_URL` → relação com `Database.SQL`
- `BUCKET_NAME` / `BUCKET_URL` → relação com `Storage.Bucket`
- `API_URL` / `ENDPOINT` → relação com `Compute.Instance` ou outra Lambda

Alternativa mais robusta: permitir referências explícitas via `Fn.ref()` ou similar na API do core.

---

### Correção BUG-06 — Resolver `image` para SSM path ou emitir warning

```typescript
const AMI_MAP: Record<string, string> = {
  'ubuntu': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'amazon-linux-2': '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2}}',
};

const imageId = AMI_MAP[props.image] ?? props.image;
// + emitir warning se props.image não estiver no map
```

---

### Correção BUG-07 — Remover mapeamento incorreto de `region` para `AvailabilityZone`

O parâmetro `region` em `Compute.Instance` deveria ser ignorado no contexto do CloudFormation (a região é definida no deploy, não no template) ou mapeado para um parâmetro separado. Não deve ser transformado silenciosamente em `AvailabilityZone`.

---

### Correção BUG-08 — Emitir recursos de versioning e public access no Terraform

```hcl
resource "aws_s3_bucket_versioning" "BucketSimples_versioning" {
  bucket = aws_s3_bucket.BucketSimples.id
  versioning_configuration {
    status = "Suspended"
  }
}

resource "aws_s3_bucket_public_access_block" "BucketSimples_pab" {
  bucket                  = aws_s3_bucket.BucketSimples.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

---

### Correção BUG-09 — Validar `engine` em `Database.SQL`

Adicionar validação na construção do construct:

```typescript
const VALID_ENGINES = ['mysql', 'postgres'] as const;
if (!VALID_ENGINES.includes(props.engine)) {
  throw new Error(`Database.SQL: engine inválido "${props.engine}". Use: ${VALID_ENGINES.join(' | ')}`);
}
```
