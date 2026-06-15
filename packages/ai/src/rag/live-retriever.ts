import * as fs from 'fs';
import * as path from 'path';

const CACHE_FILE = '.iacmp/live-cache.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora
const FETCH_TIMEOUT_MS = 3_000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

type CacheStore = Record<string, CacheEntry>;

function loadCache(projectDir?: string): CacheStore {
  const filePath = projectDir
    ? path.join(projectDir, CACHE_FILE)
    : path.join(process.cwd(), CACHE_FILE);

  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CacheStore;
  } catch {
    return {};
  }
}

function saveCache(store: CacheStore, projectDir?: string): void {
  const filePath = projectDir
    ? path.join(projectDir, CACHE_FILE)
    : path.join(process.cwd(), CACHE_FILE);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // falha silenciosa — cache é best-effort
  }
}

function getCached(store: CacheStore, key: string): string | null {
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.value;
}

function setCached(store: CacheStore, key: string, value: string): void {
  store[key] = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  // Remove entradas expiradas para não crescer indefinidamente
  const now = Date.now();
  for (const k of Object.keys(store)) {
    if (store[k].expiresAt < now) {
      delete store[k];
    }
  }
}

// Fetch com timeout de 3s — nunca lança exceção para fora
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    if (!resp.ok) return '';
    return await resp.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// Parse básico de RSS/Atom — extrai títulos e descrições sem dependências
function parseRssText(xml: string, maxItems = 5): string {
  const items: string[] = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const titleRegex = /<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/i;
  const descRegex = /<description[^>]*><!\[CDATA\[(.*?)\]\]><\/description>|<description[^>]*>(.*?)<\/description>/i;

  let match: RegExpExecArray | null;
  let count = 0;

  while ((match = itemRegex.exec(xml)) !== null && count < maxItems) {
    const itemContent = match[1];
    const titleMatch = titleRegex.exec(itemContent);
    const descMatch = descRegex.exec(itemContent);

    const title = (titleMatch?.[1] ?? titleMatch?.[2] ?? '').trim();
    const desc = (descMatch?.[1] ?? descMatch?.[2] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

    if (title) {
      items.push(desc ? `- ${title}: ${desc}` : `- ${title}`);
      count++;
    }
  }

  return items.join('\n');
}

// Detecta se a query menciona preço/custo
function mentionsPrice(query: string): boolean {
  const lower = query.toLowerCase();
  return ['preço', 'preco', 'custo', 'quanto custa', 'valor', 'cost', 'price', 'pricing'].some(
    s => lower.includes(s),
  );
}

// Detecta se a query menciona Terraform
function mentionsTerraform(query: string): boolean {
  const lower = query.toLowerCase();
  return ['terraform', 'tf provider', 'terraform provider', 'hashicorp'].some(s => lower.includes(s));
}

// Detecta se a query é sobre "recente" / "lançou" / novidades
function mentionsRecent(query: string): boolean {
  const lower = query.toLowerCase();
  return ['lançou', 'lancou', 'novidade', 'recente', 'novo serviço', 'novo recurso', 'anunciou', 'what\'s new', 'whats new'].some(
    s => lower.includes(s),
  );
}

// Detecta se a query menciona Azure especificamente
function mentionsAzure(query: string): boolean {
  const lower = query.toLowerCase();
  return ['azure', 'microsoft azure', 'az '].some(s => lower.includes(s));
}

// Detecta se a query menciona GCP especificamente
function mentionsGcp(query: string): boolean {
  const lower = query.toLowerCase();
  return ['gcp', 'google cloud', 'gcloud', 'cloud run', 'bigquery', 'cloud functions', 'pub/sub', 'pubsub', 'spanner'].some(
    s => lower.includes(s),
  );
}

// Extrai o nome do serviço Azure da query para filtrar preços
// Mapeia termos comuns para o serviceName da Azure Pricing API
function extractAzureServiceName(query: string): string | null {
  const lower = query.toLowerCase();
  const serviceMap: Array<[string[], string]> = [
    [['functions', 'function app'], 'Azure Functions'],
    [['app service', 'web app'], 'Azure App Service'],
    [['sql database', 'azure sql'], 'SQL Database'],
    [['cosmos', 'cosmosdb'], 'Azure Cosmos DB'],
    [['blob', 'storage account'], 'Storage'],
    [['kubernetes', 'aks'], 'Azure Kubernetes Service'],
    [['container instance', 'aci'], 'Container Instances'],
    [['virtual machine', 'vm ', 'vms '], 'Virtual Machines'],
    [['redis', 'cache'], 'Azure Cache for Redis'],
    [['service bus'], 'Service Bus'],
    [['event hub'], 'Event Hubs'],
    [['api management', 'apim'], 'API Management'],
    [['postgresql', 'postgres'], 'Azure Database for PostgreSQL'],
    [['mysql'], 'Azure Database for MySQL'],
  ];

  for (const [terms, serviceName] of serviceMap) {
    if (terms.some(t => lower.includes(t))) return serviceName;
  }
  return null;
}

// Extrai o nome do serviço GCP da query para filtrar SKUs
function extractGcpServiceId(query: string): string | null {
  const lower = query.toLowerCase();
  const serviceMap: Array<[string[], string]> = [
    [['cloud run'], 'Cloud Run'],
    [['cloud functions', 'functions'], 'Cloud Functions'],
    [['bigquery'], 'BigQuery'],
    [['gke', 'kubernetes', 'kubernetes engine'], 'Kubernetes Engine'],
    [['cloud sql', 'sql'], 'Cloud SQL'],
    [['spanner'], 'Cloud Spanner'],
    [['pub/sub', 'pubsub'], 'Cloud Pub/Sub'],
    [['compute engine', 'vm ', 'instância'], 'Compute Engine'],
    [['cloud storage', 'gcs'], 'Cloud Storage'],
    [['cloud bigtable', 'bigtable'], 'Cloud Bigtable'],
  ];

  for (const [terms, serviceId] of serviceMap) {
    if (terms.some(t => lower.includes(t))) return serviceId;
  }
  return null;
}

// Fonte 1: AWS What's New RSS
async function fetchAwsWhatsNew(cache: CacheStore): Promise<string> {
  const cacheKey = 'aws-whats-new';
  const cached = getCached(cache, cacheKey);
  if (cached !== null) return cached;

  const xml = await fetchWithTimeout('https://aws.amazon.com/about-aws/whats-new/recent/feed/');
  if (!xml) return '';

  const text = parseRssText(xml, 5);
  const result = text ? `### AWS What's New (recente)\n${text}` : '';
  setCached(cache, cacheKey, result);
  return result;
}

// Fonte 2: AWS Pricing API — Lambda e RDS sample
async function fetchAwsPricing(query: string, cache: CacheStore): Promise<string> {
  const sections: string[] = [];

  // Lambda pricing (us-east-1 como referência)
  if (query.toLowerCase().includes('lambda')) {
    const cacheKey = 'aws-pricing-lambda';
    const cached = getCached(cache, cacheKey);
    if (cached !== null) {
      if (cached) sections.push(cached);
    } else {
      const url = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json';
      const raw = await fetchWithTimeout(url);
      let result = '';
      if (raw) {
        try {
          const data = JSON.parse(raw) as {
            products?: Record<string, { attributes?: Record<string, string> }>;
            terms?: { OnDemand?: Record<string, Record<string, { priceDimensions?: Record<string, { pricePerUnit?: Record<string, string>; description?: string }> }>> };
          };
          const pricePoints: string[] = [];
          if (data.terms?.OnDemand) {
            let count = 0;
            for (const sku of Object.values(data.terms.OnDemand)) {
              for (const term of Object.values(sku)) {
                for (const dim of Object.values(term.priceDimensions ?? {})) {
                  const usd = dim.pricePerUnit?.USD;
                  const desc = dim.description;
                  if (usd && desc && count < 3) {
                    pricePoints.push(`  - ${desc}: $${usd}`);
                    count++;
                  }
                }
              }
            }
          }
          if (pricePoints.length > 0) {
            result = `### AWS Lambda Pricing (us-east-1)\n${pricePoints.join('\n')}`;
          }
        } catch {
          // parse falhou — ignora
        }
      }
      setCached(cache, cacheKey, result);
      if (result) sections.push(result);
    }
  }

  // RDS pricing sample (apenas menciona link canônico — JSON completo é muito grande)
  if (query.toLowerCase().includes('rds') || query.toLowerCase().includes('aurora')) {
    const cacheKey = 'aws-pricing-rds-note';
    const cached = getCached(cache, cacheKey);
    if (cached !== null) {
      if (cached) sections.push(cached);
    } else {
      // Preços do RDS são muito dinâmicos e variam por engine/instância/região
      // Referencia o endpoint público da AWS Pricing sem tentar parsear o JSON inteiro
      const result = `### AWS RDS Pricing\nPreços variam por engine (MySQL, PostgreSQL, Oracle, SQL Server, Aurora), tipo de instância e região.\nCalculadora oficial: https://aws.amazon.com/rds/pricing/\nEndpoint JSON: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/index.json`;
      setCached(cache, cacheKey, result);
      sections.push(result);
    }
  }

  return sections.join('\n\n');
}

// Fonte 3: Azure Pricing API — preços por serviço (eastus como referência)
// https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'X' and armRegionName eq 'eastus'
async function fetchAzurePricing(query: string, cache: CacheStore): Promise<string> {
  const serviceName = extractAzureServiceName(query);
  if (!serviceName) return '';

  const cacheKey = `azure-pricing-${serviceName.toLowerCase().replace(/\s+/g, '-')}`;
  const cached = getCached(cache, cacheKey);
  if (cached !== null) return cached;

  const filter = encodeURIComponent(
    `serviceName eq '${serviceName}' and armRegionName eq 'eastus' and priceType eq 'Consumption'`,
  );
  const url = `https://prices.azure.com/api/retail/prices?$filter=${filter}&$top=10`;

  const raw = await fetchWithTimeout(url);
  if (!raw) return '';

  try {
    const data = JSON.parse(raw) as {
      Items?: Array<{
        skuName?: string;
        retailPrice?: number;
        unitOfMeasure?: string;
        productName?: string;
      }>;
    };

    if (!data.Items || data.Items.length === 0) return '';

    const lines: string[] = [`### Azure ${serviceName} Pricing (East US)`];
    let count = 0;
    for (const item of data.Items) {
      if (count >= 6) break;
      const sku = item.skuName ?? item.productName ?? '';
      const price = item.retailPrice;
      const unit = item.unitOfMeasure ?? '';
      if (sku && price !== undefined) {
        lines.push(`  - ${sku}: $${price}/${unit}`);
        count++;
      }
    }

    if (lines.length <= 1) return '';
    const result = lines.join('\n');
    setCached(cache, cacheKey, result);
    return result;
  } catch {
    return '';
  }
}

// Fonte 4: Azure Updates RSS — novidades da plataforma Azure
async function fetchAzureUpdates(cache: CacheStore): Promise<string> {
  const cacheKey = 'azure-updates';
  const cached = getCached(cache, cacheKey);
  if (cached !== null) return cached;

  const xml = await fetchWithTimeout('https://www.microsoft.com/releasecommunications/api/v2/azure/rss');
  if (!xml) return '';

  const text = parseRssText(xml, 5);
  const result = text ? `### Azure Updates (recente)\n${text}` : '';
  setCached(cache, cacheKey, result);
  return result;
}

// Fonte 5: GCP Cloud Billing Catalog API — SKUs por serviço
// https://cloudbilling.googleapis.com/v1/services (público, sem auth para listar serviços)
// SKUs individuais: https://cloudbilling.googleapis.com/v1/services/{serviceId}/skus
async function fetchGcpPricing(query: string, cache: CacheStore): Promise<string> {
  const targetService = extractGcpServiceId(query);
  if (!targetService) return '';

  const cacheKey = `gcp-pricing-${targetService.toLowerCase().replace(/\s+/g, '-')}`;
  const cached = getCached(cache, cacheKey);
  if (cached !== null) return cached;

  // Primeiro busca a lista de serviços para encontrar o serviceId
  const servicesRaw = await fetchWithTimeout('https://cloudbilling.googleapis.com/v1/services?pageSize=200');
  if (!servicesRaw) return '';

  let serviceId: string | null = null;
  try {
    const servicesData = JSON.parse(servicesRaw) as {
      services?: Array<{ name?: string; displayName?: string }>;
    };

    const match = (servicesData.services ?? []).find(
      s => s.displayName?.toLowerCase().includes(targetService.toLowerCase()),
    );
    if (match?.name) {
      // name é algo como "services/95FF-2EF5-5EA1"
      serviceId = match.name;
    }
  } catch {
    return '';
  }

  if (!serviceId) return '';

  // Busca SKUs do serviço (limita a 10 para não pesar)
  const skusRaw = await fetchWithTimeout(
    `https://cloudbilling.googleapis.com/v1/${serviceId}/skus?pageSize=10&currencyCode=USD`,
  );
  if (!skusRaw) return '';

  try {
    const skusData = JSON.parse(skusRaw) as {
      skus?: Array<{
        description?: string;
        pricingInfo?: Array<{
          pricingExpression?: {
            tieredRates?: Array<{
              unitPrice?: { units?: string; nanos?: number };
              startUsageAmount?: number;
            }>;
            usageUnit?: string;
          };
        }>;
      }>;
    };

    if (!skusData.skus || skusData.skus.length === 0) return '';

    const lines: string[] = [`### GCP ${targetService} Pricing (USD)`];
    let count = 0;
    for (const sku of skusData.skus) {
      if (count >= 6) break;
      const desc = sku.description;
      const rate = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.[0];
      const unit = sku.pricingInfo?.[0]?.pricingExpression?.usageUnit ?? '';
      if (desc && rate?.unitPrice) {
        const units = Number(rate.unitPrice.units ?? 0);
        const nanos = (rate.unitPrice.nanos ?? 0) / 1e9;
        const price = units + nanos;
        lines.push(`  - ${desc}: $${price.toFixed(6)}/${unit}`);
        count++;
      }
    }

    if (lines.length <= 1) return '';
    const result = lines.join('\n');
    setCached(cache, cacheKey, result);
    return result;
  } catch {
    return '';
  }
}

// Fonte 6: GCP Release Notes RSS — novidades por produto
async function fetchGcpReleaseNotes(cache: CacheStore): Promise<string> {
  const cacheKey = 'gcp-release-notes';
  const cached = getCached(cache, cacheKey);
  if (cached !== null) return cached;

  // Feed público de release notes do GCP (Atom)
  const xml = await fetchWithTimeout('https://cloud.google.com/feeds/gcp-release-notes.xml');
  if (!xml) return '';

  // Feed Atom usa <entry> em vez de <item>
  const text = parseAtomText(xml, 5);
  const result = text ? `### GCP Release Notes (recente)\n${text}` : '';
  setCached(cache, cacheKey, result);
  return result;
}

// Parse básico de Atom feed (GCP usa Atom, não RSS)
function parseAtomText(xml: string, maxItems = 5): string {
  const items: string[] = [];
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  const titleRegex = /<title[^>]*>(.*?)<\/title>/i;
  const summaryRegex = /<summary[^>]*>([\s\S]*?)<\/summary>/i;

  let match: RegExpExecArray | null;
  let count = 0;

  while ((match = entryRegex.exec(xml)) !== null && count < maxItems) {
    const entryContent = match[1];
    const titleMatch = titleRegex.exec(entryContent);
    const summaryMatch = summaryRegex.exec(entryContent);

    const title = (titleMatch?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
    const summary = (summaryMatch?.[1] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

    if (title) {
      items.push(summary ? `- ${title}: ${summary}` : `- ${title}`);
      count++;
    }
  }

  return items.join('\n');
}

// Fonte 7: Terraform Registry API — versão atual do provider AWS
async function fetchTerraformProviderVersion(cache: CacheStore): Promise<string> {
  const cacheKey = 'tf-aws-provider-version';
  const cached = getCached(cache, cacheKey);
  if (cached !== null) return cached;

  const raw = await fetchWithTimeout('https://registry.terraform.io/v1/providers/hashicorp/aws');
  if (!raw) return '';

  try {
    const data = JSON.parse(raw) as { version?: string; description?: string };
    const version = data.version;
    if (!version) return '';
    const result = `### Terraform AWS Provider\nVersão atual: ${version}\nDocumentação: https://registry.terraform.io/providers/hashicorp/aws/latest/docs`;
    setCached(cache, cacheKey, result);
    return result;
  } catch {
    return '';
  }
}

export interface LiveRetrieverOptions {
  projectDir?: string;
}

// Busca informações ao vivo com cache de 1h e timeout de 3s por fonte
export async function fetchLive(
  query: string,
  signals: string[],
  options: LiveRetrieverOptions = {},
): Promise<string> {
  const cache = loadCache(options.projectDir);
  const parts: string[] = [];

  const sigSet = new Set(signals);

  try {
    const isRecent = mentionsRecent(query) || sigSet.has('recent');
    const isPrice  = mentionsPrice(query)  || sigSet.has('price');
    const isAzure  = mentionsAzure(query)  || sigSet.has('azure');
    const isGcp    = mentionsGcp(query)    || sigSet.has('gcp');
    const isTf     = mentionsTerraform(query) || sigSet.has('terraform');

    // Dispara fontes em paralelo para não somar os timeouts
    const fetches: Array<Promise<string>> = [];

    // AWS What's New
    if (isRecent && !isAzure && !isGcp) fetches.push(fetchAwsWhatsNew(cache));

    // AWS Pricing
    if (isPrice && !isAzure && !isGcp) fetches.push(fetchAwsPricing(query, cache));

    // Azure Pricing
    if (isPrice && isAzure) fetches.push(fetchAzurePricing(query, cache));

    // Azure Updates (novidades)
    if (isRecent && isAzure) fetches.push(fetchAzureUpdates(cache));

    // GCP Pricing
    if (isPrice && isGcp) fetches.push(fetchGcpPricing(query, cache));

    // GCP Release Notes
    if (isRecent && isGcp) fetches.push(fetchGcpReleaseNotes(cache));

    // Terraform Registry
    if (isTf) fetches.push(fetchTerraformProviderVersion(cache));

    const results = await Promise.all(fetches);
    for (const r of results) {
      if (r) parts.push(r);
    }
  } finally {
    saveCache(cache, options.projectDir);
  }

  return parts.join('\n\n');
}

// Sinais que ativam o live retriever no query-router
export const LIVE_SIGNALS = [
  // Preço / custo
  'preço', 'preco', 'custo', 'quanto custa', 'valor', 'pricing',
  // Novidades / recente
  'lançou', 'lancou', 'novidade', 'recente', 'novo serviço', 'novo recurso', 'anunciou',
  'versão atual', 'versao atual', "what's new", 'whats new', 'release notes', 'release note',
  // Terraform
  'terraform provider', 'terraform aws', 'terraform azure', 'terraform gcp',
  // Azure (específicos que indicam contexto Azure + info ao vivo)
  'azure functions preço', 'app service custo', 'cosmos db custo', 'azure sql preço',
  // GCP (específicos)
  'cloud run preço', 'bigquery custo', 'gke preço', 'cloud sql gcp',
];

// Verifica se a query contém sinais que ativam o live retriever
export function shouldFetchLive(query: string): boolean {
  const lower = query.toLowerCase();
  return LIVE_SIGNALS.some(s => lower.includes(s));
}
