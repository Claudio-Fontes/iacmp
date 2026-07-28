import * as fs from 'fs';
import * as path from 'path';
import { providerOutDir } from '../synth-out';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand } from './types';

/**
 * Terraform opera no DIRETÓRIO inteiro (todos os .tf juntos formam um state
 * único), não por arquivo de stack como os outros providers — por isso
 * resolve o diretório de output a partir de `ctx.cwd`, em vez de usar
 * `ctx.templatePath` (que nos outros providers é um arquivo único).
 *
 * O synth --format tf já gera _providers.tf.json com o bloco provider+variable.
 * O antigo _provider.tf (gerado inline aqui) causava "Duplicate provider".
 * Se ainda existir de um synth anterior, é removido antes do init.
 */
function removeLegacyProviderFile(dir: string): void {
  const legacy = path.join(dir, '_provider.tf');
  if (fs.existsSync(legacy)) fs.rmSync(legacy);
}

export const terraformExecutor: DeployExecutor = {
  provider: 'terraform',
  requiredBinary: 'terraform',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const dir = providerOutDir(ctx.cwd, 'terraform');
    removeLegacyProviderFile(dir);
    const regionVar = `aws_region=${ctx.region}`;
    return [
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
      { bin: 'terraform', args: ['apply', '-auto-approve', '-var', regionVar], cwd: dir },
    ];
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const dir = providerOutDir(ctx.cwd, 'terraform');
    removeLegacyProviderFile(dir);
    const regionVar = `aws_region=${ctx.region}`;
    return [
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
      { bin: 'terraform', args: ['destroy', '-auto-approve', '-var', regionVar], cwd: dir },
    ];
  },
};
