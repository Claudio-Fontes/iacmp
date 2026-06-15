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

// Fonte 3: Terraform Registry API — versão atual do provider AWS
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
    // AWS What's New: quando query menciona recente/novidades
    if (mentionsRecent(query) || sigSet.has('recent')) {
      const result = await fetchAwsWhatsNew(cache);
      if (result) parts.push(result);
    }

    // AWS Pricing: quando query menciona preço/custo
    if (mentionsPrice(query) || sigSet.has('price')) {
      const result = await fetchAwsPricing(query, cache);
      if (result) parts.push(result);
    }

    // Terraform Registry: quando query menciona Terraform
    if (mentionsTerraform(query) || sigSet.has('terraform')) {
      const result = await fetchTerraformProviderVersion(cache);
      if (result) parts.push(result);
    }
  } finally {
    saveCache(cache, options.projectDir);
  }

  return parts.join('\n\n');
}

// Sinais que ativam o live retriever no query-router
export const LIVE_SIGNALS = [
  'preço', 'preco', 'custo', 'quanto custa',
  'lançou', 'lancou', 'novidade', 'recente', 'novo serviço', 'novo recurso', 'anunciou',
  'versão atual', 'versao atual', 'terraform provider', 'terraform aws',
  'what\'s new', 'whats new',
];

// Verifica se a query contém sinais que ativam o live retriever
export function shouldFetchLive(query: string): boolean {
  const lower = query.toLowerCase();
  return LIVE_SIGNALS.some(s => lower.includes(s));
}
