import { errMessage } from '../../utils';
import { countResources } from '../../synth-out';
import { commandExists } from '../../commands/doctor';
import { printPlan, runCommands } from '../exec';
import { DestroyContext } from '../types';
import { confirm, DestroyFlowOptions } from './common';

/**
 * Destroy via Terraform (aws-tf / azure-tf): opera no diretório inteiro —
 * executa uma vez, não um loop por stack.
 *
 * Retorna false se o usuário cancelou na confirmação.
 */
export async function destroyTerraformDir(o: DestroyFlowOptions, effectiveProvider: string): Promise<boolean> {
  for (const t of o.templates) {
    o.ui.log(`Stack: ${t.stackName} — ${countResources(t.filePath, effectiveProvider)} recurso(s)`);
  }
  o.ui.log('');
  if (!o.force && !o.dryRun) {
    const confirmed = await confirm('Tem certeza que deseja destruir todos os recursos?');
    if (!confirmed) { o.ui.log('Operação cancelada.'); return false; }
  }
  if (!o.dryRun && !commandExists(o.executor.requiredBinary)) {
    o.ui.error(`${o.executor.requiredBinary} não encontrado no PATH.`);
  }
  const ctx: DestroyContext = { ...o.baseCtx, stackName: o.config.name ?? 'iacmp' };
  let commands;
  try {
    commands = await o.executor.planDestroy(ctx);
  } catch (err) {
    o.ui.error(errMessage(err));
  }
  if (o.dryRun) {
    printPlan(commands);
  } else {
    try {
      await runCommands(commands);
    } catch (err) {
      o.ui.error(errMessage(err));
    }
  }
  return true;
}
