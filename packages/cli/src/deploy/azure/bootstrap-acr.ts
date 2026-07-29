import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { t } from '../../i18n';
import { resourceGroupExists } from './stack-api';

/** Resource group compartilhado entre projetos — guarda o ACR de bootstrap. Nunca é destruído por `iacmp destroy` de um projeto individual. */
const ACR_BOOTSTRAP_RESOURCE_GROUP = 'iacmp-bootstrap-rg';

export function getSubscriptionId(): string {
  return execFileSync('az', ['account', 'show', '--query', 'id', '--output', 'tsv'], { stdio: 'pipe' }).toString().trim();
}

/** Nome do ACR de bootstrap — 1 por subscription, compartilhado entre projetos (nomes de ACR são globalmente únicos no Azure). */
export function acrBootstrapName(subscriptionId: string): string {
  return `iacmpacr${subscriptionId.replace(/-/g, '').slice(0, 12)}`;
}

function acrExists(name: string, resourceGroup: string): boolean {
  try {
    execFileSync('az', ['acr', 'show', '--name', name, '--resource-group', resourceGroup, '--query', 'name', '--output', 'tsv'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * `az acr check-name`: o namespace de nomes de ACR é GLOBAL (azurecr.io) — um
 * nome pode estar em uso por outra subscription/tenant inteiramente fora da
 * nossa visão. `acrExists` (show no nosso resource group) não detecta isso;
 * só o check-name diz se dá pra CRIAR com esse nome.
 */
function acrNameAvailable(name: string): boolean {
  try {
    const out = execFileSync('az', ['acr', 'check-name', '--name', name, '--query', 'nameAvailable', '--output', 'tsv'], { stdio: 'pipe' }).toString().trim();
    return out === 'true';
  } catch {
    // check-name falhou (az indisponível, etc.) — trata como indisponível: mais
    // seguro tentar um nome alternativo do que insistir num create que pode falhar.
    return false;
  }
}

function randomAcrSuffix(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.randomBytes(3).toString('hex'); // 6 chars alfanuméricos
}

export interface BootstrapAcr {
  name: string;
  loginServer: string;
  username: string;
  password: string;
}

/** Estado persistido do bootstrap Azure — sobrevive entre execuções do `iacmp deploy` (inclusive processos concorrentes). */
interface AzureBootstrapState {
  acrName?: string;
}

function bootstrapStatePath(): string {
  // `$HOME` é a fonte documentada do os.homedir() no POSIX — checar direto aqui
  // primeiro (em vez de só os.homedir()) mantém o comportamento idêntico em uso
  // real e permite override determinístico em teste (alguns runners não repassam
  // mutações de process.env.HOME até a chamada nativa de os.homedir()).
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.iacmp', 'azure-bootstrap.json');
}

export function readBootstrapState(): AzureBootstrapState {
  try {
    return JSON.parse(fs.readFileSync(bootstrapStatePath(), 'utf-8')) as AzureBootstrapState;
  } catch {
    return {};
  }
}

function writeBootstrapState(state: AzureBootstrapState): void {
  const file = bootstrapStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function fetchAcrCredentials(acrName: string): BootstrapAcr {
  const loginServer = execFileSync('az', [
    'acr', 'show', '--name', acrName, '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP,
    '--query', 'loginServer', '--output', 'tsv',
  ], { stdio: 'pipe' }).toString().trim();
  const credsRaw = execFileSync('az', [
    'acr', 'credential', 'show', '--name', acrName, '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP,
    '--query', '{username:username,password:passwords[0].value}', '--output', 'json',
  ], { stdio: 'pipe' }).toString();
  const creds = JSON.parse(credsRaw) as { username: string; password: string };
  return { name: acrName, loginServer, username: creds.username, password: creds.password };
}

/**
 * Garante o ACR de bootstrap (Basic, admin habilitado) num resource group próprio,
 * compartilhado entre projetos — sobrevive ao `iacmp destroy` de qualquer projeto
 * individual.
 *
 * O nome de ACR é GLOBALMENTE único (namespace azurecr.io) — o nome determinístico
 * `iacmpacr<subId[:12]>` pode estar reservado fora da nossa visão (outra subscription,
 * um registro já purgado, etc.), caso em que `az acr create` falha pra sempre com
 * `RegistryNameAlreadyInUse` mesmo o nosso resource group nunca tendo tido esse ACR.
 * Por isso: (1) show-before-create (reusa se já é nosso), (2) nome persistido em
 * `~/.iacmp/azure-bootstrap.json` tem prioridade sobre o determinístico, (3) se o
 * determinístico não estiver disponível, cai pra um nome com sufixo aleatório e
 * PERSISTE a escolha pra próximas execuções, (4) corrida entre processos (dois
 * deploys concorrentes chamando o bootstrap ao mesmo tempo): se o create falhar com
 * RegistryNameAlreadyInUse, refaz o show no nosso RG antes de desistir — se o outro
 * processo venceu a corrida, reusa o resultado dele em vez de falhar.
 */
export function ensureBootstrapAcr(location: string): BootstrapAcr {
  const subscriptionId = getSubscriptionId();
  if (!resourceGroupExists(ACR_BOOTSTRAP_RESOURCE_GROUP)) {
    process.stdout.write(t(`[iacmp] Criando resource group de bootstrap "${ACR_BOOTSTRAP_RESOURCE_GROUP}" (compartilhado entre projetos)...\n`, `[iacmp] Creating bootstrap resource group "${ACR_BOOTSTRAP_RESOURCE_GROUP}" (shared across projects)...\n`));
    execFileSync('az', ['group', 'create', '--name', ACR_BOOTSTRAP_RESOURCE_GROUP, '--location', location], { stdio: 'pipe' });
  }

  const state = readBootstrapState();
  const deterministicName = acrBootstrapName(subscriptionId);
  const candidates: Array<{ name: string; reason: 'persistido' | 'determinístico' | 'fallback' }> = state.acrName
    ? [{ name: state.acrName, reason: 'persistido' }]
    : [{ name: deterministicName, reason: 'determinístico' }];

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { name: acrName, reason } = candidates[candidates.length - 1];

    // 1. Show-before-create: já é nosso? Reusa sem tentar criar de novo.
    if (acrExists(acrName, ACR_BOOTSTRAP_RESOURCE_GROUP)) {
      process.stdout.write(t(`[iacmp] ACR de bootstrap "${acrName}" já existe (nome ${reason}) — reaproveitando.\n`, `[iacmp] Bootstrap ACR "${acrName}" already exists (${reason} name) — reusing.\n`));
      execFileSync('az', ['acr', 'update', '--name', acrName, '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP, '--admin-enabled', 'true'], { stdio: 'pipe' });
      if (state.acrName !== acrName) writeBootstrapState({ acrName });
      return fetchAcrCredentials(acrName);
    }

    // 2. Não é nosso ainda — o nome está livre pra CRIAR (namespace global)?
    if (!acrNameAvailable(acrName)) {
      process.stdout.write(t(`[iacmp] Nome de ACR "${acrName}" (${reason}) está em uso fora do nosso resource group (namespace global azurecr.io) — gerando nome alternativo...\n`, `[iacmp] ACR name "${acrName}" (${reason}) is taken outside our resource group (global azurecr.io namespace) — generating an alternative name...\n`));
      candidates.push({ name: `${deterministicName}${randomAcrSuffix()}`.slice(0, 50), reason: 'fallback' });
      continue;
    }

    process.stdout.write(t(`[iacmp] Criando Azure Container Registry de bootstrap "${acrName}" (nome ${reason})...\n`, `[iacmp] Creating bootstrap Azure Container Registry "${acrName}" (${reason} name)...\n`));
    try {
      execFileSync('az', [
        'acr', 'create',
        '--name', acrName,
        '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP,
        '--sku', 'Basic',
        '--admin-enabled', 'true',
        '--location', location,
      ], { stdio: 'pipe' });
      writeBootstrapState({ acrName });
      return fetchAcrCredentials(acrName);
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? (err as Error).message;
      if (!/RegistryNameAlreadyInUse/i.test(stderr)) {
        throw new Error(t(`Falha ao criar o ACR de bootstrap "${acrName}": ${stderr}`, `Failed to create the bootstrap ACR "${acrName}": ${stderr}`));
      }
      // 3. Corrida entre processos: outro deploy concorrente pode ter criado
      // esse MESMO nome entre o check-name e o create — se foi no NOSSO
      // resource group, a corrida terminou em sucesso; reusa.
      if (acrExists(acrName, ACR_BOOTSTRAP_RESOURCE_GROUP)) {
        process.stdout.write(t(`[iacmp] ACR "${acrName}" foi criado por um deploy concorrente entre o check e o create — reaproveitando.\n`, `[iacmp] ACR "${acrName}" was created by a concurrent deploy between the check and the create — reusing.\n`));
        execFileSync('az', ['acr', 'update', '--name', acrName, '--resource-group', ACR_BOOTSTRAP_RESOURCE_GROUP, '--admin-enabled', 'true'], { stdio: 'pipe' });
        writeBootstrapState({ acrName });
        return fetchAcrCredentials(acrName);
      }
      // Não é nosso — o nome é de terceiros mesmo (reservado fora da nossa visão). Fallback.
      process.stdout.write(t(`[iacmp] "${acrName}" já está em uso (RegistryNameAlreadyInUse) e não é nosso — gerando nome alternativo...\n`, `[iacmp] "${acrName}" is already taken (RegistryNameAlreadyInUse) and not ours — generating an alternative name...\n`));
      candidates.push({ name: `${deterministicName}${randomAcrSuffix()}`.slice(0, 50), reason: 'fallback' });
    }
  }
  throw new Error(t(
    `Não foi possível encontrar um nome disponível para o ACR de bootstrap após ${MAX_ATTEMPTS} tentativas ` +
    `(subscription ${subscriptionId}). Verifique "az acr check-name" manualmente ou limpe ~/.iacmp/azure-bootstrap.json.`,
    `Could not find an available name for the bootstrap ACR after ${MAX_ATTEMPTS} attempts ` +
    `(subscription ${subscriptionId}). Check "az acr check-name" manually or clear ~/.iacmp/azure-bootstrap.json.`,
  ));
}
