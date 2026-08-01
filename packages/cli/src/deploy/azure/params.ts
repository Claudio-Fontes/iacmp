import * as fs from 'fs';

/** Parâmetros Bicep sem valor default — precisam vir de stacks anteriores. */
// Senha do run: gerada uma vez por processo (mesmo valor em todas as stacks do
// deploy). Prefixo garante as classes de caractere que o flexible server exige.
let runAdminPassword: string | null = null;
export function getRunAdminPassword(): string {
  if (!runAdminPassword) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto') as typeof import('crypto');
    runAdminPassword = `Ia1${crypto.randomBytes(18).toString('base64url')}`;
  }
  return runAdminPassword;
}

// Valor inicial dos Secret.Vault do run: bytes aleatórios, gerados uma vez por
// execução (todas as stacks do deploy recebem o mesmo). Substitui o antigo
// uniqueString() do template, que era determinístico por resource group.
let runSecretValue: string | null = null;
export function getRunSecretValue(): string {
  if (!runSecretValue) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto') as typeof import('crypto');
    runSecretValue = crypto.randomBytes(32).toString('base64url');
  }
  return runSecretValue;
}

export function getCrossStackParams(templatePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    return []; // template ilegível/inexistente — sem params conhecidos (dry-run/testes)
  }
  const params: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^param\s+(\w+)\s+\w+\s*$/);
    if (m) params.push(m[1]);
  }
  return params;
}

/** Nomes dos outputs que sinalizam storage accounts com static website a ativar pós-deploy. */
export function getStaticWebsiteOutputKeys(templatePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^output\s+(\w+StaticWebsiteAccount)\s+/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** Params com default '' (soft) — injetados quando disponíveis, sem erro se ausentes. */
export function getSoftCrossStackParams(templatePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    return [];
  }
  const params: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^param\s+(\w+)\s+string\s*=\s*''\s*$/);
    if (m) params.push(m[1]);
  }
  return params;
}

/**
 * Retorna true se o nome do parâmetro (no formato "key=value") corresponde a uma
 * credencial que NÃO deve aparecer na linha de comando (visível em `ps aux`).
 * Regra: qualquer key cujo nome termine em "password" (case-insensitive).
 */
export function isSecretParam(paramKv: string): boolean {
  const key = paramKv.split('=')[0];
  return /password$/i.test(key);
}
