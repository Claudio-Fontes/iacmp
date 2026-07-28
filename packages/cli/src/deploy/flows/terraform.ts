import { errMessage } from '../../utils';
import { countResources } from '../../synth-out';
import { printPlan, runCommands } from '../exec';
import { DeployContext } from '../types';
import { DeployFlowOptions } from './common';

/**
 * Deploy via Terraform (aws-tf / azure-tf): opera no diretório inteiro como
 * um state único — uma única chamada ao executor, não um loop por stack.
 */
export async function deployTerraformDir(o: DeployFlowOptions, effectiveProvider: string): Promise<void> {
  for (const t of o.templates) {
    o.ui.log(`Stack: ${t.stackName} — ${countResources(t.filePath, effectiveProvider)} recurso(s)`);
  }
  o.ui.log('');
  const ctx: DeployContext = { ...o.baseCtx, stackName: o.config.name ?? 'iacmp', templatePath: '' };
  let commands;
  try {
    commands = await o.executor.planDeploy(ctx);
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
}
