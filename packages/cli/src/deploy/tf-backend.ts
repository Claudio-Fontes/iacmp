import * as fs from 'fs';
import * as path from 'path';
import { t } from '../i18n';

/**
 * Backend remoto do Terraform (state fora da máquina, com locking).
 *
 * Por que importa: por padrão o state fica em `synth-out/<provider>/
 * terraform.tfstate` — arquivo local que (a) guarda valores sensíveis em texto,
 * (b) não tem lock (dois operadores rodando ao mesmo tempo corrompem o estado)
 * e (c) some junto com a máquina. Para experimento é ok; para qualquer coisa
 * compartilhada, não (achado P1-04 da auditoria de 2026-07-31).
 *
 * Configuração em `iacmp.json`:
 *   "tfBackend": { "type": "s3", "bucket": "meu-state", "key": "prod/app.tfstate", "region": "us-east-1", "dynamodbTable": "tf-locks" }
 *   "tfBackend": { "type": "gcs", "bucket": "meu-state", "prefix": "prod/app" }
 *   "tfBackend": { "type": "azurerm", "resourceGroupName": "rg", "storageAccountName": "st", "containerName": "tfstate", "key": "prod.tfstate" }
 */
export interface TfBackendConfig {
  type: 's3' | 'gcs' | 'azurerm';
  [key: string]: unknown;
}

const BACKEND_FILE = '_backend.tf.json';

/** Campos obrigatórios por tipo — faltando algum, falhamos com a lista. */
const REQUIRED_FIELDS: Record<TfBackendConfig['type'], string[]> = {
  s3: ['bucket', 'key', 'region'],
  gcs: ['bucket'],
  azurerm: ['resourceGroupName', 'storageAccountName', 'containerName', 'key'],
};

/**
 * Escreve (ou remove) o arquivo de backend no diretório de synth. Retorna true
 * quando um backend remoto está configurado.
 */
export function applyTfBackend(synthDir: string, backend: TfBackendConfig | undefined): boolean {
  const file = path.join(synthDir, BACKEND_FILE);
  if (!backend) {
    // Sem backend configurado: garante que não sobrou um arquivo de execução
    // anterior (mudar de remoto para local sem querer seria pior que o local).
    if (fs.existsSync(file)) fs.rmSync(file);
    return false;
  }
  const type = backend.type;
  if (!REQUIRED_FIELDS[type]) {
    throw new Error(t(
      `iacmp.json: tfBackend.type "${type}" não suportado. Use 's3' (AWS), 'gcs' (GCP) ou 'azurerm' (Azure).`,
      `iacmp.json: tfBackend.type "${type}" is not supported. Use 's3' (AWS), 'gcs' (GCP) or 'azurerm' (Azure).`,
    ));
  }
  const missing = REQUIRED_FIELDS[type].filter(f => backend[f] === undefined || backend[f] === '');
  if (missing.length > 0) {
    throw new Error(t(
      `iacmp.json: tfBackend do tipo "${type}" exige: ${missing.join(', ')}.`,
      `iacmp.json: tfBackend of type "${type}" requires: ${missing.join(', ')}.`,
    ));
  }
  const { type: _t, ...settings } = backend;
  fs.mkdirSync(synthDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ terraform: [{ backend: [{ [type]: settings }] }] }, null, 2));
  return true;
}

/**
 * Aviso (uma linha, não bloqueia) quando o deploy vai usar state LOCAL. É o
 * comportamento default e continua válido para experimentos — mas o usuário
 * precisa saber que o arquivo guarda dados sensíveis e não tem lock.
 */
export function warnIfLocalState(synthDir: string, hasRemote: boolean, write: (s: string) => void): void {
  if (hasRemote) return;
  const statePath = path.join(synthDir, 'terraform.tfstate');
  const exists = fs.existsSync(statePath);
  write(t(
    `[iacmp] Terraform usando state LOCAL${exists ? ` (${path.basename(statePath)})` : ''} — sem lock e com dados sensíveis em texto.\n` +
    `        Para uso compartilhado/produção configure "tfBackend" no iacmp.json (s3 | gcs | azurerm).\n`,
    `[iacmp] Terraform using LOCAL state${exists ? ` (${path.basename(statePath)})` : ''} — no locking, sensitive values in plain text.\n` +
    `        For shared/production use, configure "tfBackend" in iacmp.json (s3 | gcs | azurerm).\n`,
  ));
}
