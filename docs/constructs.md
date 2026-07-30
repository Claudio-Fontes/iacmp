# Constructs

Constructs are the building blocks of iacmp. Each construct represents an
infrastructure resource in a provider-agnostic way — the same code works on
AWS, Azure, and GCP (and in Terraform format via `--format tf`).

The full API is exported by `@iacmp/core` across 13 namespaces. Each namespace
groups related subtypes (`Compute.Instance`, `Compute.AutoScaling`, etc.).
The construct's `type` is the discriminator each provider uses to synthesize
the native resource (`Compute.Instance` → `AWS::EC2::Instance` on AWS,
`Microsoft.Compute/virtualMachines` on Azure, and so on).

---

## Importing

```typescript
import {
  Stack,
  Compute, Storage, Network, Database, Fn,
  Policy, Events, Workflow, Cache, Messaging,
  Secret, Certificate, Monitoring, Logging,
} from '@iacmp/core';
```

> **Note:** `Function` is a reserved word in JavaScript, so the serverless
> functions namespace is exported as `Fn`.

---

## Stack

All infrastructure lives inside a `Stack`. It groups resources and carries
metadata such as name, provider, and region.

```typescript
const stack = new Stack('nome-da-stack', {
  provider: 'aws',
  region: 'us-east-1',
});
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Unique stack name |
| `options.provider` | `string` | no | Target provider (`aws`, `azure`, `gcp`, `terraform`) |
| `options.region` | `string` | no | Provider region |

---

## Compute — machines, scaling, and containers

### Compute.Instance

Single virtual machine. Maps to EC2 (AWS), VM (Azure), Compute Engine (GCP),
`aws_instance` (Terraform).

```typescript
new Compute.Instance(stack, 'Servidor', {
  instanceType: 'small',
  image: 'ubuntu-22.04',
  region: 'us-east-1',
});
```

| Prop | Type | Description |
|---|---|---|
| `instanceType` | `'small' \| 'medium' \| 'large'` | Logical size |
| `image` | `string` | AMI/OS image |
| `region` | `string?` | Region (default: stack region) |

### Compute.AutoScaling

Auto-scaling instance group. Maps to AutoScalingGroup (AWS),
VMSS (Azure), MIG (GCP).

```typescript
new Compute.AutoScaling(stack, 'Web', {
  instanceType: 'medium',
  image: 'ubuntu-22.04',
  minCapacity: 2,
  maxCapacity: 10,
  targetCpuUtilization: 70,
});
```

Relevant props: `minCapacity`, `maxCapacity`, `desiredCapacity?`,
`targetCpuUtilization?`, `subnetIds?`, `securityGroupIds?`, `healthCheckPath?`,
`healthCheckPort?`.

### Compute.Container

Managed container (ECS Fargate / Container Apps / Cloud Run).

```typescript
new Compute.Container(stack, 'Api', {
  image: 'ghcr.io/acme/api:latest',
  cpu: 512,
  memory: 1024,
  port: 8080,
  environment: { LOG_LEVEL: 'info' },
});
```

### Compute.Kubernetes

Managed Kubernetes cluster (EKS / AKS / GKE).

```typescript
new Compute.Kubernetes(stack, 'K8s', {
  version: '1.30',
  nodeInstanceType: 'medium',
  minNodes: 2,
  maxNodes: 6,
  privateCluster: true,
});
```

---

## Storage — buckets, file systems, and archives

### Storage.Bucket

Object storage (S3 / Blob Storage / Cloud Storage).

```typescript
new Storage.Bucket(stack, 'Assets', {
  versioning: true,
  publicAccess: false,
  lifecycleRules: [{ prefix: 'tmp/', expireAfterDays: 7 }],
});
```

### Storage.FileSystem

Shared file system (EFS / Azure Files / Filestore).

```typescript
new Storage.FileSystem(stack, 'Shared', {
  performanceMode: 'generalPurpose',
  throughputMode: 'bursting',
  encrypted: true,
});
```

### Storage.Archive

Cold storage with retention (Glacier / Archive Storage / Coldline).

```typescript
new Storage.Archive(stack, 'Backups', {
  retrievalTier: 'Standard',
  lockEnabled: true,
  retentionDays: 365,
});
```

---

## Network — VPC, subnets, SG, LB, CDN, DNS, WAF

### Network.VPC

Virtual private network.

```typescript
new Network.VPC(stack, 'Rede', { cidr: '10.0.0.0/16', maxAzs: 3 });
```

### Network.Subnet

Public or private subnet within a VPC.

```typescript
new Network.Subnet(stack, 'Privada1', {
  vpcId: 'vpc-123',
  cidr: '10.0.1.0/24',
  availabilityZone: 'us-east-1a',
  public: false,
});
```

### Network.SecurityGroup

Set of ingress/egress rules.

```typescript
new Network.SecurityGroup(stack, 'WebSg', {
  vpcId: 'vpc-123',
  ingressRules: [
    { protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0' },
  ],
});
```

### Network.WAF

Web Application Firewall (AWS WAF / Azure WAF / Cloud Armor).

```typescript
new Network.WAF(stack, 'Edge', {
  scope: 'CLOUDFRONT',
  defaultAction: 'allow',
  rules: [{ name: 'sql-i', managedGroup: 'AWS-AWSManagedRulesSQLiRuleSet' }],
});
```

### Network.LoadBalancer

ALB/NLB/Application Gateway load balancer.

```typescript
new Network.LoadBalancer(stack, 'Edge', {
  type: 'application',
  scheme: 'internet-facing',
  listeners: [{ port: 443, protocol: 'HTTPS', certificateArn: '...' }],
});
```

### Network.CDN

Edge cache (CloudFront / Azure CDN / Cloud CDN).

```typescript
new Network.CDN(stack, 'Site', {
  origins: [{ id: 'origin1', domainName: 'app.example.com' }],
  priceClass: 'PriceClass_100',
});
```

### Network.Dns

Managed DNS zone (Route 53 / Azure DNS / Cloud DNS).

```typescript
new Network.Dns(stack, 'Zona', {
  zoneName: 'example.com',
  records: [{ name: 'api', type: 'A', ttl: 300, values: ['1.2.3.4'] }],
});
```

---

## Database — SQL, DocumentDB, DynamoDB

### Database.SQL

Managed relational database. Supported engines: `mysql`, `postgres`,
`mariadb`, `oracle`, `sqlserver`.

```typescript
new Database.SQL(stack, 'Principal', {
  engine: 'postgres',
  instanceType: 'small',
  multiAz: true,
  storageGb: 100,
  backupRetentionDays: 7,
});
```

### Database.DocumentDB

MongoDB-compatible NoSQL document database (DocumentDB / CosmosDB Mongo API).

```typescript
new Database.DocumentDB(stack, 'Mongo', {
  instanceType: 'medium',
  instances: 3,
  deletionProtection: true,
});
```

### Database.DynamoDB

Key-value NoSQL (DynamoDB / CosmosDB Core).

```typescript
new Database.DynamoDB(stack, 'Users', {
  partitionKey: 'userId',
  sortKey: 'createdAt',
  billingMode: 'PAY_PER_REQUEST',
  streamEnabled: true,
});
```

---

## Fn — serverless

### Fn.Lambda

Serverless function. Supported runtimes: `nodejs20`, `nodejs18`, `python3.12`,
`python3.11`, `java21`, `go1.x`, `dotnet8`.

```typescript
new Fn.Lambda(stack, 'Handler', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 512,
  timeout: 30,
});
```

### Fn.ApiGateway

HTTP endpoint in front of Lambdas (API Gateway / API Management /
API Gateway).

```typescript
new Fn.ApiGateway(stack, 'Api', {
  name: 'api-prod',
  type: 'HTTP',
  cors: true,
  routes: [{ method: 'GET', path: '/users', lambdaId: 'Handler' }],
});
```

---

## Policy — IAM

### Policy.IAM

Policy attached to a resource (lambda, instance, bucket, database, role, group).

```typescript
new Policy.IAM(stack, 'LambdaReadBucket', {
  attachTo: 'Handler',
  attachType: 'lambda',
  statements: [{
    effect: 'Allow',
    actions: ['s3:GetObject'],
    resources: ['arn:aws:s3:::my-bucket/*'],
  }],
});
```

---

## Events — EventBridge

### Events.EventBridge

Event bus with routing rules.

```typescript
new Events.EventBridge(stack, 'Bus', {
  busName: 'default',
  rules: [{
    name: 'order-created',
    source: ['shop.orders'],
    detailTypes: ['OrderCreated'],
    targetArn: 'arn:aws:lambda:...',
  }],
});
```

---

## Workflow — Step Functions

### Workflow.StepFunctions

State machine (Step Functions / Logic Apps / Workflows).

```typescript
new Workflow.StepFunctions(stack, 'PedidoFlow', {
  type: 'STANDARD',
  steps: [
    { name: 'Validar', type: 'Task', resource: 'arn:...:lambda:validar' },
    { name: 'Cobrar', type: 'Task', resource: 'arn:...:lambda:cobrar' },
    { name: 'Fim', type: 'Succeed' },
  ],
});
```

---

## Cache — Redis and Memcached

### Cache.Redis

Managed Redis cluster (ElastiCache / Azure Cache / Memorystore).

```typescript
new Cache.Redis(stack, 'Sessions', {
  nodeType: 'small',
  numCacheNodes: 2,
  automaticFailoverEnabled: true,
  atRestEncryptionEnabled: true,
  transitEncryptionEnabled: true,
});
```

### Cache.Memcached

Managed Memcached cluster.

```typescript
new Cache.Memcached(stack, 'Items', { nodeType: 'small', numCacheNodes: 2 });
```

---

## Messaging — queues and topics

### Messaging.Queue

Queue (SQS / Service Bus Queue / Pub/Sub subscription).

```typescript
new Messaging.Queue(stack, 'Orders', {
  fifo: true,
  visibilityTimeoutSeconds: 60,
  messageRetentionSeconds: 345600,
  encrypted: true,
});
```

### Messaging.Topic

Pub/sub topic (SNS / Service Bus Topic / Pub/Sub topic).

```typescript
new Messaging.Topic(stack, 'OrderEvents', {
  fifo: true,
  subscriptions: [
    { protocol: 'lambda', endpoint: 'arn:aws:lambda:...' },
  ],
});
```

---

## Secret — vault and certificates

### Secret.Vault

Secrets vault (Secrets Manager / Key Vault / Secret Manager).

```typescript
new Secret.Vault(stack, 'DbCredentials', {
  description: 'Senhas do banco',
  rotationDays: 30,
});
```

### Certificate.TLS

Managed TLS certificate (ACM / Key Vault TLS / Certificate Manager). Exported
in its own namespace to make it clear it is a separate resource from `Vault`.

```typescript
new Certificate.TLS(stack, 'EdgeCert', {
  domainName: 'app.example.com',
  subjectAlternativeNames: ['www.app.example.com'],
  validationMethod: 'DNS',
});
```

---

## Monitoring & Logging

### Monitoring.Alarm

Metric-based alarm (CloudWatch Alarm / Azure Alert / Cloud Monitoring).

```typescript
new Monitoring.Alarm(stack, 'HighCpu', {
  metricName: 'CPUUtilization',
  namespace: 'AWS/EC2',
  threshold: 80,
  comparisonOperator: 'GreaterThanThreshold',
  evaluationPeriods: 3,
  periodSeconds: 60,
});
```

### Monitoring.Dashboard

Metrics dashboard.

```typescript
new Monitoring.Dashboard(stack, 'Prod', {
  widgets: [
    { type: 'metric', title: 'CPU', metricName: 'CPUUtilization', namespace: 'AWS/EC2' },
    { type: 'text', title: 'Notas', markdown: '# Produção' },
  ],
});
```

### Logging.Stream

Log group / Log Analytics Workspace / Log Bucket.

```typescript
new Logging.Stream(stack, 'AppLogs', {
  retentionDays: 30,
  subscriptionFilters: [{
    name: 'errors-to-lambda',
    filterPattern: 'ERROR',
    destinationArn: 'arn:aws:lambda:...',
  }],
});
```

---

## Full example

Stack for a serverless API with a database, queue, cache, and monitoring:

```typescript
import {
  Stack, Network, Database, Fn, Storage,
  Messaging, Cache, Monitoring,
} from '@iacmp/core';

const stack = new Stack('api-producao', {
  provider: 'aws',
  region: 'sa-east-1',
});

new Network.VPC(stack, 'Rede', { cidr: '10.0.0.0/16', maxAzs: 3 });

new Database.SQL(stack, 'Banco', {
  engine: 'postgres',
  instanceType: 'medium',
  multiAz: true,
});

new Storage.Bucket(stack, 'Uploads', { versioning: true });

new Cache.Redis(stack, 'Sessions', {
  nodeType: 'small',
  numCacheNodes: 2,
  automaticFailoverEnabled: true,
});

new Messaging.Queue(stack, 'JobsQueue', { encrypted: true });

new Fn.Lambda(stack, 'Api', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 1024,
  timeout: 30,
});

new Monitoring.Alarm(stack, 'HighErrors', {
  metricName: 'Errors',
  namespace: 'AWS/Lambda',
  threshold: 10,
  comparisonOperator: 'GreaterThanThreshold',
});

export default stack;
```
