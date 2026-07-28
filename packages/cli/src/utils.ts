import * as fs from 'fs';
import * as path from 'path';
import type { EnvironmentProfile, AccountTier } from '@iacmp/core';

/**
 * Lê e parseia um arquivo JSON. Lança Error com mensagem amigável (inclui o
 * caminho + motivo do erro) quando o arquivo não existe, não é legível ou tem
 * JSON inválido. Quem chama deve repassar a Error.message via `this.error()`.
 */
export function readJsonFile<T = unknown>(filePath: string): T {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(`Falha ao ler '${filePath}': ${errMessage(e)}`);
  }
  try {
    return JSON.parse(content) as T;
  } catch (e) {
    throw new Error(`JSON inválido em '${filePath}': ${errMessage(e)}`);
  }
}

/** Campos conhecidos do iacmp.json (aceita chaves extras). */
export interface IacmpConfig {
  name?: string;
  provider?: string;
  region?: string;
  /** Região de DR na AWS — stacks marcadas com region: 'dr' deployam aqui. */
  drRegion?: string;
  resourceGroup?: string;
  azureRegion?: string;
  /** Região de DR na Azure — reservada para replicação com região livre (ORS); RA-GRS usa o par fixo da plataforma. */
  azureDrRegion?: string;
  /** Região GCP (ex: us-central1). Separada de `region` (AWS) porque as nomenclaturas não são compatíveis — `us-east-1` (AWS) não existe no GCP (é `us-east1`). Sem isso, um deploy GCP herdaria a região AWS e falharia. */
  gcpRegion?: string;
  accountTier?: AccountTier;
  availabilityZones?: string[];
  projectId?: string;
  language?: string;
  /**
   * Auto-enriquecimento da knowledge base (loop de aprendizado).
   *  - autolearn: 'local' → após um deploy bem-sucedido de um padrão inédito, o
   *    CLI oferece gravá-lo na base LOCAL do próprio cliente (fica só nele).
   *    'off' (default) → desligado.
   *  - `share` (envio à base central, Modo 2) é reservado — ainda não implementado.
   */
  knowledge?: {
    autolearn?: 'local' | 'off';
  };
  /**
   * Config específica do provider Azure.
   *  - sharedApim: quando presente, o synth Azure NÃO cria um
   *    Microsoft.ApiManagement/service próprio — referencia o APIM JÁ EXISTENTE
   *    (`name` + `resourceGroup`) e cria só os filhos do projeto (apis, backends,
   *    operations, policies, namedValues) sob ele. Elimina o piso de ~30-45min
   *    de provisionamento de APIM por projeto.
   */
  azure?: {
    sharedApim?: {
      name: string;
      resourceGroup: string;
    };
  };
  [key: string]: unknown;
}

/**
 * Lê o iacmp.json do projeto. Ponto ÚNICO de leitura da config — não duplicar
 * `JSON.parse(fs.readFileSync('iacmp.json'))` nos comandos. Retorna null quando
 * o projeto não foi inicializado; quem exige projeto trata o null com this.error.
 */
export function loadIacmpConfig(cwd: string): IacmpConfig | null {
  const configPath = path.join(cwd, 'iacmp.json');
  if (!fs.existsSync(configPath)) return null;
  return readJsonFile<IacmpConfig>(configPath);
}

/** Provider efetivo: flag da linha de comando > config do projeto > 'aws'. */
export function resolveProvider(config: IacmpConfig | null, flagProvider?: string): string {
  return flagProvider ?? config?.provider ?? 'aws';
}

/** EnvironmentProfile derivado da config (accountTier free é o default seguro). */
export function profileFromConfig(config: IacmpConfig | null): EnvironmentProfile {
  return {
    accountTier: (config?.accountTier === 'standard' ? 'standard' : 'free') as AccountTier,
    region: config?.region,
    drRegion: config?.drRegion,
    availabilityZones: config?.availabilityZones,
  };
}

/**
 * Resolve a região concreta para o provider do deploy/destroy. Cada cloud tem
 * um campo e um default próprios porque as nomenclaturas NÃO são intercambiáveis:
 * `region` guarda a região AWS (ex: us-east-1), `azureRegion` a Azure (eastus2),
 * `gcpRegion` a GCP (us-central1). Um projeto multi-cloud (provider aws mas
 * deployado com `--provider gcp`) NÃO pode herdar a região AWS — `us-east-1` não
 * existe no GCP e o deploy falha em cascata (locations 403, zonas inválidas).
 */
export function resolveProviderRegion(provider: string, config: IacmpConfig | null): string {
  if (provider === 'azure') return config?.azureRegion ?? 'eastus2';
  if (provider === 'gcp') return config?.gcpRegion ?? 'us-central1';
  return config?.region ?? 'us-east-1';
}

/** Extrai uma mensagem amigável de qualquer valor capturado em catch. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
