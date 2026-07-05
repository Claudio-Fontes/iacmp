export const CATALOG = `
## API completa do @iacmp/core

### Stack
\`\`\`typescript
import { Stack } from '@iacmp/core';
const stack = new Stack('nome-da-stack');
export default stack;
\`\`\`

---
## COMPUTE

### Compute.Instance — EC2, Azure VM, Compute Engine
\`\`\`typescript
import { Stack, Compute } from '@iacmp/core';
const stack = new Stack('nome');
new Compute.Instance(stack, 'LogicalId', {
  instanceType: 'small' | 'medium' | 'large',
  image: string,   // ver valores suportados abaixo
  region?: string,
  subnetId?: string,       // AWS — sem isso só funciona se a conta tiver VPC default
  securityGroupIds?: string[],
});
export default stack;
\`\`\`

### Compute.AutoScaling — Auto Scaling Group / VMSS
\`\`\`typescript
new Compute.AutoScaling(stack, 'LogicalId', {
  instanceType: 'small' | 'medium' | 'large',
  image: string,
  minCapacity: number,
  maxCapacity: number,
  desiredCapacity?: number,
  targetCpuUtilization?: number,
  subnetIds?: string[],
});
\`\`\`

**Valores de \`image\` suportados:**
| image | AWS | Azure | GCP |
|---|---|---|---|
| \`ubuntu\` / \`ubuntu-22.04\` | SSM → Ubuntu 22.04 AMI | Canonical UbuntuServer 22_04-lts | ubuntu-os-cloud/ubuntu-2204-lts |
| \`ubuntu-20.04\` | SSM → Ubuntu 20.04 AMI | Canonical UbuntuServer 20_04-lts | ubuntu-os-cloud/ubuntu-2004-lts |
| \`amazon-linux-2\` | SSM → Amazon Linux 2 AMI | — | — |
| \`amazon-linux-2023\` | SSM → AL2023 AMI | — | — |
| \`windows-2022\` | SSM → Windows Server 2022 AMI | MicrosoftWindowsServer 2022-Datacenter | windows-cloud/windows-2022 |
| \`windows-2019\` | SSM → Windows Server 2019 AMI | MicrosoftWindowsServer 2019-Datacenter | windows-cloud/windows-2019 |
| \`windows-2016\` | SSM → Windows Server 2016 AMI | MicrosoftWindowsServer 2016-Datacenter | windows-cloud/windows-2016 |

### Compute.Container — ECS/Fargate, ACI, Cloud Run
\`\`\`typescript
new Compute.Container(stack, 'LogicalId', {
  image: string,
  cpu?: number,
  memory?: number,
  port?: number,
  desiredCount?: number,
  publicIp?: boolean,
  environment?: Record<string, string>,
  subnetIds?: string[],
  securityGroupIds?: string[],
  minCapacity?: number,
  maxCapacity?: number,
  cpuTargetPercent?: number,
  targetGroupArn?: string,
});
\`\`\`
**REGRA — autoscaling de tasks Fargate:** use \`minCapacity\`/\`maxCapacity\` NO PRÓPRIO \`Compute.Container\`. NUNCA use \`Compute.AutoScaling\` para escalar tasks de container.
**REGRA — Container atrás de ALB:** (1) no LoadBalancer, declare \`targetGroups\`; (2) no Container, aponte \`targetGroupArn: '<LoadBalancerId>.TargetGroupArn'\`. Container NÃO fica atrás de \`Fn.ApiGateway\` (API Gateway é só para Lambda).

### Compute.Kubernetes — EKS, AKS, GKE
\`\`\`typescript
new Compute.Kubernetes(stack, 'LogicalId', {
  version?: string,
  nodeInstanceType?: 'small' | 'medium' | 'large',
  minNodes?: number,
  maxNodes?: number,
  desiredNodes?: number,
  privateCluster?: boolean,
  subnetIds?: string[],
  securityGroupIds?: string[],
});
\`\`\`

---
## STORAGE

### Storage.Bucket — S3, Blob Storage, Cloud Storage
\`\`\`typescript
import { Stack, Storage } from '@iacmp/core';
const stack = new Stack('nome');
new Storage.Bucket(stack, 'LogicalId', {
  versioning?: boolean,
  publicAccess?: boolean,
  websiteHosting?: boolean,
  bucketName?: string,
  lifecycleRules?: [{ prefix?: string, expireAfterDays?: number, transitionToGlacierDays?: number }],
  cors?: [{ allowedMethods: string[], allowedOrigins?: string[], allowedHeaders?: string[], maxAgeSeconds?: number }],
  eventNotifications?: [{ lambdaId: string, events?: string[], prefix?: string, suffix?: string }],
});
export default stack;
\`\`\`

### Storage.FileSystem — EFS, Azure Files, Filestore
\`\`\`typescript
new Storage.FileSystem(stack, 'LogicalId', {
  performanceMode?: 'generalPurpose' | 'maxIO',
  throughputMode?: 'bursting' | 'provisioned',
  encrypted?: boolean,
  accessPoints?: [{ name: string, path: string, uid?: number, gid?: number }],
});
\`\`\`

### Storage.Archive — S3 Glacier Deep Archive, Cool Blob, Coldline
\`\`\`typescript
new Storage.Archive(stack, 'LogicalId', {
  retentionDays?: number,
  lockEnabled?: boolean,
});
\`\`\`

---
## NETWORK

### Network.VPC — VPC, VNet
\`\`\`typescript
import { Stack, Network } from '@iacmp/core';
const stack = new Stack('nome');
new Network.VPC(stack, 'LogicalId', {
  cidr?: string,
  maxAzs?: number,  // NUNCA use maxAzs > 0 junto com Network.Subnet explícitos
});
export default stack;
\`\`\`

### Network.Subnet — Subnet explícita
\`\`\`typescript
new Network.Subnet(stack, 'LogicalId', {
  vpcId: string,
  cidr: string,
  availabilityZone?: string,
  public?: boolean,
});
\`\`\`

### Network.VpcEndpoint — Gateway VPC Endpoint (DynamoDB / S3)
\`\`\`typescript
new Network.VpcEndpoint(stack, 'LogicalId', {
  vpcId: string,
  services: ['dynamodb' | 's3'],
  subnetIds: string[],
});
\`\`\`

### Network.SecurityGroup — Security Group / NSG / Firewall Rules
\`\`\`typescript
new Network.SecurityGroup(stack, 'LogicalId', {
  vpcId: string,
  description?: string,
  ingressRules?: [{ protocol: string, fromPort: number, toPort: number, cidr?: string, sourceSecurityGroupId?: string, description?: string }],
  egressRules?: [...],
});
\`\`\`

### Network.WAF — Web Application Firewall
\`\`\`typescript
new Network.WAF(stack, 'LogicalId', {
  scope?: 'REGIONAL' | 'CLOUDFRONT',
  defaultAction?: 'allow' | 'block',
  mode?: 'Detection' | 'Prevention',
  description?: string,
  rules?: [{ name: string, priority?: number, action?: string, managedGroup?: string, rateLimit?: number, matchValues?: string[], sourceIps?: string[], description?: string }],
});
\`\`\`

### Network.LoadBalancer — ALB / NLB / Application Gateway / Cloud LB
\`\`\`typescript
new Network.LoadBalancer(stack, 'LogicalId', {
  vpcId: string,
  type?: 'application' | 'network',
  scheme?: 'internet-facing' | 'internal',
  subnetIds?: string[],
  securityGroupIds?: string[],
  listeners?: [{ port: number, protocol: string, certificateArn?: string, redirectToHttps?: boolean }],
  targetGroups?: [{ name: string, port: number, protocol: string, healthCheckPath?: string }],
});
\`\`\`

### Network.CDN — CloudFront, Azure CDN, Cloud CDN
\`\`\`typescript
new Network.CDN(stack, 'LogicalId', {
  origins: [{ id: string, domainName: string, bucketRef?: string, path?: string, protocol?: string }],
  defaultRootObject?: string,
  priceClass?: 'PriceClass_100' | 'PriceClass_200' | 'PriceClass_All',
  wafAclId?: string,
});
\`\`\`

### Network.Dns — Route53, Azure DNS, Cloud DNS
\`\`\`typescript
new Network.Dns(stack, 'LogicalId', {
  zoneName: string,
  records?: [{ name: string, type: string, values: string[], ttl?: number }],
});
\`\`\`

---
## DATABASE

### Database.SQL — RDS, Aurora, Azure SQL, Cloud SQL
\`\`\`typescript
import { Stack, Database } from '@iacmp/core';
const stack = new Stack('nome');
new Database.SQL(stack, 'LogicalId', {
  engine: 'mysql' | 'postgres' | 'mariadb' | 'oracle' | 'sqlserver' | 'aurora-mysql' | 'aurora-postgresql',
  instanceType?: string,
  instances?: number,
  storageGb?: number,
  multiAz?: boolean,
  backupRetentionDays?: number,
  deletionProtection?: boolean,
  storageEncrypted?: boolean,
  edition?: string,
  licenseModel?: string,
  subnetIds?: string[],
  securityGroupIds?: string[],
});
export default stack;
\`\`\`

### Database.DocumentDB — DocumentDB / MongoDB compatível
\`\`\`typescript
new Database.DocumentDB(stack, 'LogicalId', {
  instanceType?: string,
  instances?: number,
  deletionProtection?: boolean,
  subnetIds?: string[],
  securityGroupIds?: string[],
});
\`\`\`

### Database.DynamoDB — DynamoDB / Cosmos DB / Bigtable
\`\`\`typescript
new Database.DynamoDB(stack, 'LogicalId', {
  partitionKey: string,
  partitionKeyType?: 'S' | 'N' | 'B',
  sortKey?: string,
  sortKeyType?: 'S' | 'N' | 'B',
  billingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED',
  readCapacity?: number,
  writeCapacity?: number,
  ttlAttribute?: string,
  pointInTimeRecovery?: boolean,
  streamEnabled?: boolean,
  globalSecondaryIndexes?: [{ name: string, partitionKey: string, partitionKeyType?: string, sortKey?: string, sortKeyType?: string }],
});
\`\`\`

---
## CACHE

### Cache.Redis — ElastiCache Redis / Azure Cache / Memorystore
\`\`\`typescript
import { Stack, Cache } from '@iacmp/core';
const stack = new Stack('nome');
new Cache.Redis(stack, 'LogicalId', {
  nodeType?: 'small' | 'medium' | 'large',
  numCacheNodes?: number,
  version?: string,
  automaticFailoverEnabled?: boolean,
  atRestEncryptionEnabled?: boolean,
  transitEncryptionEnabled?: boolean,
  subnetIds?: string[],
  securityGroupIds?: string[],
});
export default stack;
\`\`\`

### Cache.Memcached — ElastiCache Memcached
\`\`\`typescript
new Cache.Memcached(stack, 'LogicalId', {
  nodeType?: 'small' | 'medium' | 'large',
  numCacheNodes?: number,
  subnetGroupName?: string,
});
\`\`\`

---
## FUNCTION

### Fn.Lambda — Lambda, Azure Functions, Cloud Functions
\`\`\`typescript
import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('nome');
new Fn.Lambda(stack, 'LogicalId', {
  runtime: 'nodejs20' | 'nodejs18' | 'python3.12' | 'python3.11' | 'java21' | 'go1.x' | 'dotnet8',
  handler: 'index.handler',
  code: 'dist/',
  memory?: number,
  timeout?: number,
  reservedConcurrency?: number,
  layerArns?: string[],
  vpcId?: string,
  subnetIds?: string[],
  securityGroupIds?: string[],
  environment?: Record<string, string>,
});
export default stack;
\`\`\`

### Fn.ApiGateway — API Gateway V2 / API Management / Cloud Endpoints
\`\`\`typescript
new Fn.ApiGateway(stack, 'Api', {
  name: string,
  type?: 'HTTP' | 'REST' | 'WEBSOCKET',
  stageName?: string,
  cors?: boolean,
  authType?: 'NONE' | 'JWT' | 'AWS_IAM' | 'COGNITO',
  authorizerLambdaId?: string,
  throttlingBurstLimit?: number,
  throttlingRateLimit?: number,
  routes: [{ method: string, path: string, lambdaId: string }],
});
\`\`\`

---
## POLICY

### Policy.IAM — IAM Role + Policy / RBAC / Service Account
\`\`\`typescript
import { Stack, Policy } from '@iacmp/core';
const stack = new Stack('nome');
new Policy.IAM(stack, 'LogicalId', {
  attachTo: string,
  attachType: 'lambda' | 'compute' | 'bucket' | 'database' | 'role' | 'group',
  description?: string,
  statements: [{ effect: 'Allow' | 'Deny', actions: string[], resources?: string[], conditions?: Record<string, Record<string, string>> }],
});
export default stack;
\`\`\`

---
## EVENTS & WORKFLOW

### Events.EventBridge — EventBridge / Event Grid / Pub/Sub
\`\`\`typescript
import { Stack, Events } from '@iacmp/core';
const stack = new Stack('nome');
new Events.EventBridge(stack, 'LogicalId', {
  busName?: string,
  description?: string,
  rules?: [{ name: string, cron?: string, rate?: string, source?: string[], detailTypes?: string[], targetLambdaId?: string, description?: string }],
});
export default stack;
\`\`\`

### Workflow.StepFunctions — Step Functions / Logic Apps / Cloud Workflows
\`\`\`typescript
import { Stack, Workflow } from '@iacmp/core';
const stack = new Stack('nome');
new Workflow.StepFunctions(stack, 'LogicalId', {
  type?: 'STANDARD' | 'EXPRESS',
  description?: string,
  steps: [{ name: string, type?: string, resource?: string, description?: string, waitForToken?: boolean, seconds?: number }],
});
export default stack;
\`\`\`

---
## MESSAGING

### Messaging.Queue — SQS / Service Bus Queue / Cloud Tasks
\`\`\`typescript
import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('nome');
new Messaging.Queue(stack, 'LogicalId', {
  visibilityTimeoutSeconds?: number,
  messageRetentionSeconds?: number,
  delaySeconds?: number,
  fifo?: boolean,
  encrypted?: boolean,
  dlqArn?: string,
  maxReceiveCount?: number,
});
export default stack;
\`\`\`

### Messaging.Stream — Kinesis Data Stream
\`\`\`typescript
new Messaging.Stream(stack, 'LogicalId', {
  shards?: number,
  retentionHours?: number,
  encrypted?: boolean,
});
\`\`\`

### Messaging.Topic — SNS / Service Bus Topic / Pub/Sub Topic
\`\`\`typescript
new Messaging.Topic(stack, 'LogicalId', {
  displayName?: string,
  fifo?: boolean,
  encrypted?: boolean,
  subscriptions?: [{ protocol: 'lambda' | 'sqs' | 'email' | 'http' | 'https', endpoint: string }],
});
\`\`\`

---
## SECRET & CERTIFICATE

### Secret.Vault — Secrets Manager / Key Vault / Secret Manager
\`\`\`typescript
import { Stack, Secret } from '@iacmp/core';
const stack = new Stack('nome');
new Secret.Vault(stack, 'LogicalId', {
  description?: string,
  kmsKeyId?: string,
  rotationDays?: number,
  replicaRegions?: string[],
});
export default stack;
\`\`\`

### Certificate.TLS — ACM / Key Vault Cert / Certificate Manager
\`\`\`typescript
import { Stack, Certificate } from '@iacmp/core';
const stack = new Stack('nome');
new Certificate.TLS(stack, 'LogicalId', {
  domainName: string,
  subjectAlternativeNames?: string[],
  validationMethod?: 'DNS' | 'EMAIL',
  region?: string,
});
export default stack;
\`\`\`

---
## MONITORING

### Monitoring.Alarm — CloudWatch Alarm / Azure Monitor / Cloud Monitoring
\`\`\`typescript
import { Stack, Monitoring } from '@iacmp/core';
const stack = new Stack('nome');
new Monitoring.Alarm(stack, 'LogicalId', {
  metricName: string,
  namespace?: string,
  threshold: number,
  evaluationPeriods?: number,
  periodSeconds?: number,
  comparisonOperator?: string,
  statistic?: string,
  treatMissingData?: string,
  alarmActions?: Array<string | Ref>,
  okActions?: Array<string | Ref>,
  dimensions?: Record<string, string>,
});
export default stack;
\`\`\`

### Monitoring.Dashboard — CloudWatch Dashboard
\`\`\`typescript
new Monitoring.Dashboard(stack, 'LogicalId', {
  widgets: [{ type: 'metric' | 'text' | 'alarm', title?: string, metricName?: string, namespace?: string, period?: number, stat?: string, markdown?: string }],
});
\`\`\`

### Logging.Stream — CloudWatch Log Group / Log Analytics / Cloud Logging
\`\`\`typescript
import { Stack, Logging } from '@iacmp/core';
const stack = new Stack('nome');
new Logging.Stream(stack, 'LogicalId', {
  retentionDays?: number,
  kmsKeyId?: string,
  subscriptionFilters?: [{ name: string, filterPattern: string, destinationArn: string }],
});
export default stack;
\`\`\`

---
## CUSTOM — escape hatch para serviços fora do catálogo

### Custom.Resource
\`\`\`typescript
import { Stack, Custom } from '@iacmp/core';
const stack = new Stack('nome');
new Custom.Resource(stack, 'LogicalId', {
  description?: string,
  cloudformation?: { type: string, properties: Record<string, unknown> },
  arm?: { type: string, apiVersion: string, properties: Record<string, unknown>, sku?: Record<string, unknown>, kind?: string },
  deploymentManager?: { type: string, properties: Record<string, unknown> },
  terraform?: { type: string, body: Record<string, unknown> },
});
export default stack;
\`\`\`

---
## Tamanhos de instância
- \`small\` → t3.small / cache.t3.micro / B1s / e2-small
- \`medium\` → t3.medium / cache.t3.medium / B2s / e2-medium
- \`large\` → t3.large / cache.r6g.large / B4ms / e2-standard-4
`;
