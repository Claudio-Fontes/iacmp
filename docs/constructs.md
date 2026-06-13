# Constructs

Constructs são os blocos de construção do iacmp. Cada construct representa um recurso de infraestrutura de forma agnóstica ao provider — o mesmo código funciona em AWS, Azure ou GCP.

---

## Importando

```typescript
import { Stack, Compute, Storage, Network, Database, Fn } from '@iacmp/core';
```

> **Nota:** `Function` é palavra reservada em JavaScript, por isso o construct de funções serverless é exportado como `Fn`.

---

## Stack

Toda infraestrutura vive dentro de uma `Stack`. Ela é o container que agrupa os recursos e carrega metadados como nome, provider e região.

```typescript
const stack = new Stack('nome-da-stack', {
  provider: 'aws',   // opcional — usa o do iacmp.json por padrão
  region: 'us-east-1',
});
```

### Parâmetros

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `name` | `string` | sim | Nome único da stack |
| `options.provider` | `string` | não | Provider alvo (`aws`, `azure`, `gcp`, `terraform`) |
| `options.region` | `string` | não | Região do provider |

---

## Compute.Instance

Máquina virtual. Mapeada para EC2 (AWS), Azure VM (Azure) ou Compute Engine (GCP).

```typescript
const servidor = new Compute.Instance(stack, 'Servidor', {
  instanceType: 'small',
  image: 'ubuntu-22.04',
  region: 'us-east-1',
});
```

### Parâmetros

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `instanceType` | `'small' \| 'medium' \| 'large'` | sim | — | Tamanho da instância |
| `image` | `string` | sim | — | Imagem do sistema operacional |
| `region` | `string` | não | região da stack | Região de deploy |

### Mapeamento de instanceType

| Valor | AWS | Azure | GCP |
|---|---|---|---|
| `small` | t3.small | B1s | e2-small |
| `medium` | t3.medium | B2s | e2-medium |
| `large` | t3.large | B4s | e2-standard-4 |

---

## Storage.Bucket

Object storage. Mapeado para S3 (AWS), Blob Storage (Azure) ou Cloud Storage (GCP).

```typescript
const bucket = new Storage.Bucket(stack, 'Assets', {
  versioning: true,
  publicAccess: false,
});
```

### Parâmetros

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `versioning` | `boolean` | não | `false` | Habilita versionamento de objetos |
| `publicAccess` | `boolean` | não | `false` | Permite acesso público aos objetos |

---

## Network.VPC

Rede privada virtual. Mapeada para VPC (AWS), Virtual Network (Azure) ou VPC Network (GCP).

```typescript
const rede = new Network.VPC(stack, 'Rede', {
  cidr: '10.0.0.0/16',
  maxAzs: 2,
});
```

### Parâmetros

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `cidr` | `string` | não | `'10.0.0.0/16'` | Bloco CIDR da rede |
| `maxAzs` | `number` | não | `2` | Número máximo de zonas de disponibilidade |

---

## Database.SQL

Banco de dados relacional gerenciado. Mapeado para RDS (AWS), Azure SQL (Azure) ou Cloud SQL (GCP).

```typescript
const banco = new Database.SQL(stack, 'Principal', {
  engine: 'postgres',
  instanceType: 'small',
  multiAz: true,
});
```

### Parâmetros

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `engine` | `'mysql' \| 'postgres'` | sim | — | Engine do banco de dados |
| `instanceType` | `string` | não | `'small'` | Tamanho da instância |
| `multiAz` | `boolean` | não | `false` | Alta disponibilidade em múltiplas zonas |

---

## Fn.Lambda

Função serverless. Mapeada para Lambda (AWS), Azure Functions (Azure) ou Cloud Functions (GCP).

```typescript
const handler = new Fn.Lambda(stack, 'Handler', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 512,
  timeout: 30,
});
```

### Parâmetros

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `runtime` | `'nodejs20'` | sim | — | Runtime de execução |
| `handler` | `string` | sim | — | Entry point no formato `arquivo.função` |
| `code` | `string` | sim | — | Caminho para o código compilado |
| `memory` | `number` | não | `128` | Memória em MB |
| `timeout` | `number` | não | `3` | Timeout em segundos |

---

## Exemplo completo

Stack de uma API serverless com banco de dados:

```typescript
import { Stack, Network, Database, Fn, Storage } from '@iacmp/core';

const stack = new Stack('api-producao', {
  provider: 'aws',
  region: 'sa-east-1',
});

const rede = new Network.VPC(stack, 'Rede', {
  cidr: '10.0.0.0/16',
  maxAzs: 3,
});

const banco = new Database.SQL(stack, 'Banco', {
  engine: 'postgres',
  instanceType: 'medium',
  multiAz: true,
});

const uploads = new Storage.Bucket(stack, 'Uploads', {
  versioning: true,
});

const api = new Fn.Lambda(stack, 'API', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 1024,
  timeout: 30,
});

export default stack;
```
