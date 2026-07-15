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
  resourceGroup?: string;
  azureRegion?: string;
  accountTier?: AccountTier;
  availabilityZones?: string[];
  projectId?: string;
  language?: string;
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
    availabilityZones: config?.availabilityZones,
  };
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
