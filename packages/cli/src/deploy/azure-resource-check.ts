import { execSync } from 'child_process';
import { getTierEntry, AccountTier } from './resource-tier-map';

export interface ResourceRestriction {
  resource: string;
  reason: string;
  alternatives: Array<{ label: string; constraint: string }>;
}

function azAvailable(): boolean {
  try {
    execSync('az account show --query id -o tsv 2>/dev/null', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// Confirmação dinâmica via az CLI — só chamada quando a tabela marca 'restricted'
function confirmPostgresAvailable(region: string): boolean {
  try {
    const out = execSync(
      `az postgres flexible-server list-skus --location ${region} --query "[0].name" -o tsv 2>/dev/null`,
      { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    return out.length > 0;
  } catch {
    return false; // se falhar a confirmação, assume restrito (conservador)
  }
}

function confirmContainerAppSlotAvailable(region: string): boolean {
  try {
    const count = execSync(
      `az containerapp env list --query "length([?location=='${region}' || location=='${region.toLowerCase()}'])" -o tsv 2>/dev/null`,
      { timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    return parseInt(count || '0', 10) === 0;
  } catch {
    return true;
  }
}

interface ResourceHint {
  patterns: RegExp;
  construct: string;
  resource: string;
  confirm?: (region: string) => boolean; // confirmação dinâmica para casos 'restricted'
  alternatives: Array<{ label: string; constraint: string }>;
}

const RESOURCE_HINTS: ResourceHint[] = [
  {
    patterns: /\b(postgres|postgresql|rds|database\.sql|sql.*server|banco.*sql|sql.*banco)\b/i,
    construct: 'Database.SQL',
    resource: 'PostgreSQL Flexible Server',
    confirm: confirmPostgresAvailable,
    alternatives: [
      {
        label: 'a) Usar região eastus (geralmente disponível em free tier)',
        constraint: '[RESTRIÇÃO DE CONTA: PostgreSQL Flexible Server não disponível em {region}. Gere o projeto para azureRegion eastus.]',
      },
      {
        label: 'b) Substituir por Cosmos DB (NoSQL — adapta o modelo de dados)',
        constraint: '[RESTRIÇÃO DE CONTA: PostgreSQL Flexible Server não disponível. Use Database.DynamoDB (Cosmos DB Table API) em vez de Database.SQL. Handler usa @azure/data-tables.]',
      },
    ],
  },
  {
    patterns: /\b(container\s*app|ecs|fargate|compute\.container|containerapp)\b/i,
    construct: 'Compute.Container',
    resource: 'Container Apps — managed environment',
    confirm: confirmContainerAppSlotAvailable,
    alternatives: [
      {
        label: 'a) Usar região diferente (westus2 ou northeurope)',
        constraint: '[RESTRIÇÃO DE CONTA: Container App Environment já existe em {region} (limite 1/região no free trial). Use azureRegion westus2.]',
      },
      {
        label: 'b) Usar Azure Functions FC1 (serverless, sem limite de environment por região)',
        constraint: '[RESTRIÇÃO DE CONTA: Container App Environment esgotado em {region}. Use Fn.Lambda (vira Azure Function App FC1) em vez de Compute.Container.]',
      },
    ],
  },
  {
    patterns: /\b(kinesis|stream|messaging\.stream)\b/i,
    construct: 'Messaging.Stream',
    resource: 'Amazon Kinesis',
    alternatives: [
      {
        label: 'a) Usar SQS + polling (disponível no free tier)',
        constraint: '[RESTRIÇÃO DE CONTA: Kinesis requer assinatura específica (SubscriptionRequiredException). Use Messaging.Queue (SQS) com polling em vez de Messaging.Stream.]',
      },
    ],
  },
  {
    patterns: /\b(documentdb|mongodb|mongo|database\.documentdb)\b/i,
    construct: 'Database.DocumentDB',
    resource: 'Amazon DocumentDB',
    alternatives: [
      {
        label: 'a) Usar DynamoDB (NoSQL disponível no free tier)',
        constraint: '[RESTRIÇÃO DE CONTA: DocumentDB não incluso no free tier AWS (~$0.08/h). Use Database.DynamoDB em vez de Database.DocumentDB.]',
      },
      {
        label: 'b) Usar RDS PostgreSQL (relacional, incluso no free tier)',
        constraint: '[RESTRIÇÃO DE CONTA: DocumentDB não incluso no free tier AWS. Use Database.SQL engine postgres em vez de Database.DocumentDB.]',
      },
    ],
  },
];

export async function checkAzureResourceAvailability(
  prompt: string,
  region: string,
  accountTier: AccountTier = 'free',
): Promise<ResourceRestriction[]> {
  const restrictions: ResourceRestriction[] = [];
  const hasAz = azAvailable();

  for (const hint of RESOURCE_HINTS) {
    if (!hint.patterns.test(prompt)) continue;

    // 1. Verificação estática pela tabela de tiers
    const tierEntry = getTierEntry(hint.construct, 'azure', accountTier);
    if (!tierEntry || tierEntry.availability === 'available') continue;

    // 2. Para 'restricted': confirmar dinamicamente via az CLI se disponível
    if (tierEntry.availability === 'restricted' && hasAz && hint.confirm) {
      const confirmed = hint.confirm(region);
      if (confirmed) continue; // az confirmou que está disponível — ignora a restrição estática
    }

    // 3. 'unavailable' ou 'restricted' não confirmado → reportar
    const reason = tierEntry.reason ?? `Não disponível em ${region} nesta subscription (${accountTier})`;
    restrictions.push({
      resource: hint.resource,
      reason,
      alternatives: hint.alternatives.map(a => ({
        ...a,
        constraint: a.constraint.replace(/\{region\}/g, region),
      })),
    });
  }

  return restrictions;
}
