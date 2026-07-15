/**
 * Mapa estático de disponibilidade de recursos por camada de conta.
 * Construído empiricamente via bateria de deploys reais (p01-p20, AWS+Azure).
 *
 * Usado por azure-resource-check.ts como verificação rápida offline antes
 * de chamar az CLI. Atualizar quando novos bloqueios forem descobertos.
 */

export type AccountTier = 'free' | 'standard';
export type Provider = 'aws' | 'azure';
export type Availability = 'available' | 'restricted' | 'unavailable';

export interface TierEntry {
  availability: Availability;
  /** Por que está restrito/indisponível neste tier. */
  reason?: string;
  /** SKU/tamanho recomendado para este tier (quando disponível). */
  recommendedSku?: string;
  /** Alternativa quando indisponível. */
  alternative?: string;
}

export interface ResourceTierInfo {
  /** Nome amigável do recurso. */
  name: string;
  /** Construct iacmp que mapeia para este recurso. */
  construct: string;
  aws: Record<AccountTier, TierEntry>;
  azure: Record<AccountTier, TierEntry>;
}

export const RESOURCE_TIER_MAP: ResourceTierInfo[] = [
  // ─── Banco SQL ────────────────────────────────────────────────────────────
  {
    name: 'Banco SQL (PostgreSQL / MySQL)',
    construct: 'Database.SQL',
    aws: {
      free:     { availability: 'available',   recommendedSku: 'db.t3.micro', reason: 'Incluso no free tier (750h/mês)' },
      standard: { availability: 'available',   recommendedSku: 'db.t3.micro+' },
    },
    azure: {
      free:     { availability: 'restricted',  reason: 'PostgreSQL Flexible Server com LocationIsOfferRestricted em várias regiões no free trial', alternative: 'Região eastus (mais disponível) ou Cosmos DB Table API' },
      standard: { availability: 'available',   recommendedSku: 'Burstable B1ms' },
    },
  },

  // ─── Banco NoSQL / DynamoDB ───────────────────────────────────────────────
  {
    name: 'Banco NoSQL (DynamoDB / Cosmos DB Table)',
    construct: 'Database.DynamoDB',
    aws: {
      free:     { availability: 'available',   reason: '25 GB e 200M requisições/mês inclusos' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   recommendedSku: 'enableFreeTier: true', reason: 'Cosmos DB Table API com enableFreeTier funciona no free trial' },
      standard: { availability: 'available' },
    },
  },

  // ─── Banco DocumentDB / MongoDB ───────────────────────────────────────────
  {
    name: 'Banco DocumentDB / MongoDB',
    construct: 'Database.DocumentDB',
    aws: {
      free:     { availability: 'unavailable', reason: 'DocumentDB não incluso no free tier (db.t3.medium ~$0.08/h)', alternative: 'DynamoDB (NoSQL) ou RDS PostgreSQL (relacional)' },
      standard: { availability: 'available',   recommendedSku: 'db.t3.medium' },
    },
    azure: {
      free:     { availability: 'available',   recommendedSku: 'Cosmos DB Mongo API + enableFreeTier', reason: 'Cosmos DB Mongo API funciona no free trial com enableFreeTier' },
      standard: { availability: 'available' },
    },
  },

  // ─── Cache Redis ──────────────────────────────────────────────────────────
  {
    name: 'Cache Redis',
    construct: 'Cache.Redis',
    aws: {
      free:     { availability: 'available',   recommendedSku: 'cache.t3.micro', reason: '750h/mês de cache.t3.micro inclusos no free tier de 12 meses (deploy-validado na bateria p08aws)' },
      standard: { availability: 'available',   recommendedSku: 'cache.t3.micro+' },
    },
    azure: {
      free:     { availability: 'restricted',  recommendedSku: 'Basic C0 (porta 6380)', reason: 'Azure NÃO tem Redis grátis — Basic C0 é o menor SKU (~USD 16/mês, cobrado por hora). Redis Enterprise (Balanced_B0) falha com AllocationFailed — não usar.', alternative: 'Cosmos DB Table API com TTL como cache (free tier) ou destruir o Redis logo após o teste' },
      standard: { availability: 'available',   recommendedSku: 'Standard C1+' },
    },
  },

  // ─── Serverless / Functions ───────────────────────────────────────────────
  {
    name: 'Funções Serverless (Lambda / Functions)',
    construct: 'Function.Lambda',
    aws: {
      free:     { availability: 'available',   reason: '1M requisições e 400K GB-s/mês inclusos' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   recommendedSku: 'FC1 (Flex Consumption)', reason: 'FC1 disponível no free trial. Y1/Dynamic tem quota 0 — não usar.' },
      standard: { availability: 'available',   recommendedSku: 'FC1 ou EP1' },
    },
  },

  // ─── Container / ECS ─────────────────────────────────────────────────────
  {
    name: 'Container (ECS Fargate / Container Apps)',
    construct: 'Compute.Container',
    aws: {
      free:     { availability: 'unavailable', reason: 'ECS Fargate não incluso no free tier', alternative: 'Lambda (Function.Lambda) para workloads stateless' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'restricted',  reason: 'Limite de 1 Container App Environment por região por subscription no free trial', alternative: 'Usar região diferente (westus2) ou Azure Functions FC1' },
      standard: { availability: 'available' },
    },
  },

  // ─── Fila (SQS / Service Bus Queue) ──────────────────────────────────────
  {
    name: 'Fila de mensagens (SQS / Service Bus)',
    construct: 'Messaging.Queue',
    aws: {
      free:     { availability: 'available',   reason: '1M requisições SQS/mês inclusos' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   recommendedSku: 'Service Bus Standard' },
      standard: { availability: 'available' },
    },
  },

  // ─── Tópico pub/sub (SNS / Service Bus Topic) ─────────────────────────────
  {
    name: 'Pub/Sub (SNS / Service Bus Topic)',
    construct: 'Messaging.Topic',
    aws: {
      free:     { availability: 'available',   reason: '1M publicações SNS/mês inclusos' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   recommendedSku: 'Service Bus Standard + subscriptions' },
      standard: { availability: 'available' },
    },
  },

  // ─── Stream (Kinesis / Event Hub) ────────────────────────────────────────
  {
    name: 'Stream de eventos (Kinesis / Event Hub)',
    construct: 'Messaging.Stream',
    aws: {
      free:     { availability: 'unavailable', reason: 'Kinesis requer assinatura específica (SubscriptionRequiredException)', alternative: 'SQS + polling ou DynamoDB Streams' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'restricted',  recommendedSku: 'Event Hub Basic', reason: 'Event Hubs não tem free tier (Basic ~USD 11/mês, cobrado por hora)', alternative: 'Service Bus Queue (Basic, quase grátis) quando ordem/replay não são exigidos' },
      standard: { availability: 'available' },
    },
  },

  // ─── Storage Bucket (S3 / Blob) ───────────────────────────────────────────
  {
    name: 'Object Storage (S3 / Blob Storage)',
    construct: 'Storage.Bucket',
    aws: {
      free:     { availability: 'available',   reason: '5 GB S3 Standard inclusos' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   reason: '5 GB LRS inclusos' },
      standard: { availability: 'available' },
    },
  },

  // ─── CDN ──────────────────────────────────────────────────────────────────
  {
    name: 'CDN (CloudFront / Azure CDN)',
    construct: 'Network.CDN',
    aws: {
      free:     { availability: 'available',   reason: '1 TB transferência/mês incluso' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   reason: 'Azure CDN disponível; Front Door bloqueado no free trial' },
      standard: { availability: 'available' },
    },
  },

  // ─── API Gateway ──────────────────────────────────────────────────────────
  {
    name: 'API Gateway (API GW / APIM)',
    construct: 'Function.ApiGateway',
    aws: {
      free:     { availability: 'available',   reason: '1M chamadas REST/mês inclusos' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   recommendedSku: 'APIM Consumption (pay-per-call)', reason: 'Consumption tier disponível; Developer/Standard são pagos' },
      standard: { availability: 'available' },
    },
  },

  // ─── WAF ──────────────────────────────────────────────────────────────────
  {
    name: 'WAF (Web Application Firewall)',
    construct: 'Security.WAF',
    aws: {
      free:     { availability: 'restricted',  reason: 'WAF é pago (~$5/ACL + $1/regra/mês)', alternative: 'Sem WAF no free tier — usar API Gateway com throttling' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'restricted',  reason: 'App Gateway WAF Standard_v2 é pago; rate-based rules não existem no WAF v1', alternative: 'APIM com policies de rate-limiting (gratuito no Consumption tier)' },
      standard: { availability: 'available' },
    },
  },

  // ─── Step Functions / Logic Apps ──────────────────────────────────────────
  {
    name: 'Workflow de aprovação (Step Functions / Logic Apps)',
    construct: 'Compute.StepFunctions',
    aws: {
      free:     { availability: 'available',   reason: '4.000 transições de estado/mês inclusos' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   recommendedSku: 'Logic Apps Consumption (pay-per-action)' },
      standard: { availability: 'available' },
    },
  },

  // ─── Monitoramento ────────────────────────────────────────────────────────
  {
    name: 'Monitoramento / Alarmes (CloudWatch / Azure Monitor)',
    construct: 'Monitoring.Alarm',
    aws: {
      free:     { availability: 'available',   reason: '10 alarmes CloudWatch e métricas básicas inclusos' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   reason: 'Azure Monitor + MetricAlerts disponíveis; Action Groups gratuitos' },
      standard: { availability: 'available' },
    },
  },

  // ─── Secret Manager / Key Vault ───────────────────────────────────────────
  {
    name: 'Gerenciador de secrets (Secrets Manager / Key Vault)',
    construct: 'Secret.Vault',
    aws: {
      free:     { availability: 'restricted',  reason: 'Secrets Manager não incluso no free tier ($0.40/secret/mês)', alternative: 'Variáveis de ambiente com valores diretos ou SSM Parameter Store (grátis)' },
      standard: { availability: 'available' },
    },
    azure: {
      free:     { availability: 'available',   reason: 'Key Vault disponível; soft-delete 90 dias (purge obrigatório entre deploys)' },
      standard: { availability: 'available' },
    },
  },
];

/** Retorna entradas restritas ou indisponíveis para um provider+tier. */
export function getRestrictedResources(
  provider: Provider,
  tier: AccountTier,
): ResourceTierInfo[] {
  return RESOURCE_TIER_MAP.filter(r => {
    const entry = r[provider][tier];
    return entry.availability !== 'available';
  });
}

/** Retorna a entrada de tier para um construct específico. */
export function getTierEntry(
  construct: string,
  provider: Provider,
  tier: AccountTier,
): TierEntry | undefined {
  const info = RESOURCE_TIER_MAP.find(r => r.construct === construct);
  return info?.[provider][tier];
}
