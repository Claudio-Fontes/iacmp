import { execSync } from 'child_process';

export interface ResourceRestriction {
  resource: string;
  reason: string;
  alternatives: Array<{ label: string; constraint: string }>;
}

// Detecta se az CLI está disponível e autenticado
function azAvailable(): boolean {
  try {
    execSync('az account show --query id -o tsv 2>/dev/null', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function checkPostgresFlexible(region: string): boolean {
  try {
    const out = execSync(
      `az postgres flexible-server list-skus --location ${region} --query "[0].name" -o tsv 2>/dev/null`,
      { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    return out.length > 0;
  } catch {
    return true; // se a verificação falhar, assume disponível
  }
}

function checkContainerAppEnvSlot(region: string): boolean {
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
  resource: string;
  check: (region: string) => boolean;
  alternatives: Array<{ label: string; constraint: string }>;
}

const RESOURCE_HINTS: ResourceHint[] = [
  {
    patterns: /\b(postgres|postgresql|rds|database\.sql|sql.*server|banco.*sql|sql.*banco)\b/i,
    resource: 'PostgreSQL Flexible Server',
    check: checkPostgresFlexible,
    alternatives: [
      {
        label: 'a) Usar região eastus (geralmente disponível em free tier)',
        constraint: '[RESTRIÇÃO DE CONTA: PostgreSQL Flexible Server não disponível em {region}. Gere o projeto para azureRegion eastus. Mantenha todos os outros recursos inalterados.]',
      },
      {
        label: 'b) Substituir por Cosmos DB (NoSQL — adapta o modelo de dados)',
        constraint: '[RESTRIÇÃO DE CONTA: PostgreSQL Flexible Server não disponível. Use Database.DynamoDB (Cosmos DB Table API) em vez de Database.SQL. O handler deve usar @azure/data-tables em vez de pg.]',
      },
    ],
  },
  {
    patterns: /\b(container\s*app|ecs|fargate|compute\.container|containerapp)\b/i,
    resource: 'Container Apps — slot de managed environment',
    check: checkContainerAppEnvSlot,
    alternatives: [
      {
        label: 'a) Usar região diferente (westus2, northeurope)',
        constraint: '[RESTRIÇÃO DE CONTA: já existe um Container App Environment em {region} (limite 1 por região em free trial). Use azureRegion westus2 para este projeto.]',
      },
      {
        label: 'b) Substituir por Azure Functions FC1 (serverless, sem limite de environment)',
        constraint: '[RESTRIÇÃO DE CONTA: já existe um Container App Environment em {region}. Use Fn.Lambda em vez de Compute.Container — no Azure vira Azure Function App FC1, sem limite de environment por região.]',
      },
    ],
  },
];

export async function checkAzureResourceAvailability(
  prompt: string,
  region: string,
): Promise<ResourceRestriction[]> {
  if (!azAvailable()) return [];

  const restrictions: ResourceRestriction[] = [];

  for (const hint of RESOURCE_HINTS) {
    if (!hint.patterns.test(prompt)) continue;
    const available = hint.check(region);
    if (!available) {
      restrictions.push({
        resource: hint.resource,
        reason: `Não disponível em ${region} nesta subscription`,
        alternatives: hint.alternatives.map(a => ({
          ...a,
          constraint: a.constraint.replace(/\{region\}/g, region),
        })),
      });
    }
  }

  return restrictions;
}
