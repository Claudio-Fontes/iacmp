import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { AWSProvider } from '@iacmp/provider-aws';
import { Stack, EnvironmentProfile } from '@iacmp/core';
import { LoadedStack } from '../validators';
import { providerOutDir, listTemplates, orderByDependency } from '../synth-out';
import { SynthUI } from './types';
import { t } from '../i18n';

export function synthAws(o: {
  cwd: string;
  targetStacks: LoadedStack[];
  allStacks: Stack[];
  profile: EnvironmentProfile;
  projectName?: string;
  stackFlag?: string;
  ui: SynthUI;
}): void {
  const provOutDir = providerOutDir(o.cwd, 'aws');
  fs.mkdirSync(provOutDir, { recursive: true });

  for (const { stackName, stack } of o.targetStacks) {
    try {
      const p = new AWSProvider();
      const template = p.synthesize(stack, o.allStacks, o.profile, o.projectName);
      const outPath = path.join(provOutDir, `${stackName}.json`);
      fs.writeFileSync(outPath, JSON.stringify(template, null, 2) + '\n');
      o.ui.log(t(`Sintetizado: ${outPath}`, `Synthesized: ${outPath}`));
    } catch (err) {
      o.ui.error(t(`Falha ao sintetizar '${stackName}': ${(err as Error).message}`, `Failed to synthesize '${stackName}': ${(err as Error).message}`));
    }
  }

  // ── Detecção de dependência circular cross-stack ────────────────────────
  // Roda pós-synth (templates já em disco) mas pré-deploy. Se duas ou mais
  // stacks importam exports uma da outra, o deploy falharia. Detectar aqui dá
  // ao loop da IA o contexto correto para colocar os constructs
  // interdependentes na mesma stack.
  try {
    orderByDependency(listTemplates(o.cwd, 'aws'));
  } catch (err) {
    o.ui.error((err as Error).message);
  }

  validateAwsTemplates(o.cwd, o.ui, o.stackFlag);
}

/**
 * Valida templates CloudFormation gerados com `aws cloudformation validate-template`.
 * Requer aws CLI configurado e credenciais ativas. Skipa silenciosamente se
 * a ferramenta não estiver disponível.
 */
function validateAwsTemplates(cwd: string, ui: SynthUI, stack?: string): void {
  const awsCheck = spawnSync('aws', ['--version'], { encoding: 'utf-8' });
  if (awsCheck.error) {
    ui.log(t('  aws CLI não encontrado — aws cloudformation validate-template skipped.', '  aws CLI not found — aws cloudformation validate-template skipped.'));
    return;
  }

  const dir = providerOutDir(cwd, 'aws');
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter(
    f => f.endsWith('.json') && !f.startsWith('_') && (!stack || f === `${stack}.json`),
  );

  // Erro de AMBIENTE (sem credencial/região), não de template. Synth é offline:
  // não deve falhar por falta de AWS configurado — nem em CI, nem no cliente.
  const isAwsEnvError = (s: string): boolean =>
    /NoRegion|must specify a region|Unable to locate credentials|NoCredentialProviders|InvalidClientTokenId|ExpiredToken|security token|AuthFailure|The config profile .* could not be found/i.test(s);

  let hasError = false;
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stackName = file.replace('.json', '');
    const result = spawnSync(
      'aws',
      ['cloudformation', 'validate-template', '--template-body', `file://${filePath}`],
      { encoding: 'utf-8' },
    );
    if (result.status !== 0) {
      const out = result.stderr || result.stdout || '';
      if (isAwsEnvError(out)) {
        ui.log(t('  aws sem credenciais/região — validate-template skipped (synth é offline; validado no deploy).', '  aws has no credentials/region — validate-template skipped (synth is offline; validated on deploy).'));
        return;
      }
      ui.warn(t(`aws cloudformation validate-template falhou para '${stackName}':\n${out}`, `aws cloudformation validate-template failed for '${stackName}':\n${out}`));
      hasError = true;
    } else {
      ui.log(`  CFN validate OK: ${stackName}`);
    }
  }

  if (hasError) {
    ui.error(t('Validação CloudFormation encontrou erros. Corrija antes de fazer deploy.', 'CloudFormation validation found errors. Fix them before deploying.'));
  }
}
