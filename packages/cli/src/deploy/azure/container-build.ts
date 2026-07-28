import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BootstrapAcr } from './bootstrap-acr';

export interface AzureContainerBuildMeta {
  constructId: string;
  imageParamName: string;
  repository: string;
  tag: string;
  context: string;
  dockerfile?: string;
}

/**
 * Distingue "Docker não instalado" de "daemon parado" — nunca cai silenciosamente
 * no fallback ACR Tasks quando o usuário só esqueceu de abrir o Docker Desktop
 * (ACR Tasks é sabidamente bloqueado com TasksOperationsNotAllowed em subscriptions
 * free-trial — cair nele "por acidente" só troca um erro claro por um confuso).
 */
function checkDockerAvailability(): 'available' | 'daemon-down' | 'not-installed' {
  try {
    execFileSync('docker', ['version', '--format', '{{.Client.Version}}'], { stdio: 'pipe' });
    return 'available';
  } catch {
    const cliCheck = spawnSync('docker', ['--version'], { encoding: 'utf-8' });
    return cliCheck.status === 0 ? 'daemon-down' : 'not-installed';
  }
}

/**
 * Builda e publica a imagem de um Compute.Container com `build` no ACR de bootstrap.
 * Precedência (decisão registrada — ver docs/plano-p4-migracao-grafo-gcp-azure.md):
 *   1. Docker local disponível → `docker build --platform linux/amd64` + `docker push` (rota validada em produção, commit 607292a).
 *   2. Docker ausente → `az acr build` (ACR Tasks), best-effort — conhecido por falhar com
 *      `TasksOperationsNotAllowed` em subscriptions free-trial; erro explícito nesse caso.
 *   3. Docker instalado mas daemon parado → erro direto pedindo pra iniciar o Docker Desktop
 *      (NUNCA cai silenciosamente no ACR Tasks, que pode estar bloqueado).
 */
export function buildAndPushContainerImage(build: AzureContainerBuildMeta, cwd: string, acr: BootstrapAcr): string {
  const contextPath = path.resolve(cwd, build.context);
  if (!fs.existsSync(contextPath)) {
    throw new Error(
      `Compute.Container "${build.constructId}": contexto de build "${build.context}" não encontrado ` +
      `(resolvido para "${contextPath}").`,
    );
  }
  const fullImage = `${acr.loginServer}/${build.repository}:${build.tag}`;
  const dockerState = checkDockerAvailability();

  if (dockerState === 'available') {
    process.stdout.write(`[iacmp] Compute.Container "${build.constructId}": build via Docker local -> ${fullImage}\n`);
    const buildArgs = ['build', '--platform', 'linux/amd64', '-t', fullImage];
    if (build.dockerfile) buildArgs.push('-f', path.resolve(cwd, build.dockerfile));
    buildArgs.push(contextPath);
    execFileSync('docker', buildArgs, { stdio: 'inherit' });
    execFileSync('az', ['acr', 'login', '--name', acr.name], { stdio: 'pipe' });
    execFileSync('docker', ['push', fullImage], { stdio: 'inherit' });
    return fullImage;
  }

  if (dockerState === 'daemon-down') {
    throw new Error(
      `Compute.Container "${build.constructId}": Docker está instalado mas o daemon não está rodando.\n` +
      `Inicie o Docker Desktop e tente novamente.\n` +
      `(Alternativa best-effort: ACR Tasks — mas é conhecida por falhar com "TasksOperationsNotAllowed" ` +
      `em subscriptions free-trial; Docker local é a rota suportada.)`,
    );
  }

  process.stdout.write(`[iacmp] Compute.Container "${build.constructId}": Docker não encontrado — tentando ACR Tasks (best-effort) -> ${fullImage}\n`);
  const acrBuildArgs = ['acr', 'build', '--registry', acr.name, '--image', `${build.repository}:${build.tag}`, '--platform', 'linux/amd64'];
  if (build.dockerfile) acrBuildArgs.push('--file', build.dockerfile);
  acrBuildArgs.push(contextPath);
  try {
    execFileSync('az', acrBuildArgs, { stdio: ['ignore', 'inherit', 'pipe'] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (stderr) process.stderr.write(stderr);
    if (/TasksOperationsNotAllowed/i.test(stderr)) {
      throw new Error(
        `Compute.Container "${build.constructId}": ACR Tasks ("az acr build") não está disponível nesta ` +
        `subscription (bloqueio conhecido em contas free-trial: TasksOperationsNotAllowed). Instale e inicie ` +
        `o Docker Desktop e rode o deploy novamente — é a rota de build suportada nesta subscription.`,
      );
    }
    throw new Error(`Compute.Container "${build.constructId}": az acr build falhou. ${stderr || (err as Error).message}`);
  }
  return fullImage;
}
