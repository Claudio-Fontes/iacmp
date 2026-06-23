import * as fs from 'fs';
import * as path from 'path';
import { providerOutDir } from '../synth-out';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand } from './types';

/**
 * Terraform opera no DIRETÓRIO inteiro (todos os .tf juntos formam um state
 * único), não por arquivo de stack como os outros providers — por isso
 * resolve o diretório de output a partir de `ctx.cwd`, em vez de usar
 * `ctx.templatePath` (que nos outros providers é um arquivo único).
 */
function ensureProviderBlock(dir: string, region: string): void {
  // Prefixo "_" sinaliza pro synth-out.ts que este arquivo não é uma stack
  // (listTemplates/countResources o ignoram — ver isStackFile em synth-out.ts).
  const providerPath = path.join(dir, '_provider.tf');
  // `synth` só gera recursos aws_* hoje — um único provider AWS é suficiente.
  // Sobrescrito a cada deploy para acompanhar a região configurada; não é
  // state, é só config — seguro reescrever sempre.
  fs.writeFileSync(providerPath, `provider "aws" {\n  region = "${region}"\n}\n`, 'utf-8');
}

export const terraformExecutor: DeployExecutor = {
  provider: 'terraform',
  requiredBinary: 'terraform',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const dir = providerOutDir(ctx.cwd, 'terraform');
    ensureProviderBlock(dir, ctx.region);
    return [
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
      { bin: 'terraform', args: ['apply', '-auto-approve'], cwd: dir },
    ];
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const dir = providerOutDir(ctx.cwd, 'terraform');
    return [
      { bin: 'terraform', args: ['init', '-input=false'], cwd: dir },
      { bin: 'terraform', args: ['destroy', '-auto-approve'], cwd: dir },
    ];
  },
};
