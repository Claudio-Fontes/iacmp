import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { resourceGroupExists } from '../azure';
import { formatCommand } from '../exec';
import { confirm, DeployFlowOptions } from './common';

/**
 * Garante que o resource group do projeto existe antes do deploy Azure nativo
 * (Bicep). O azure-tf NÃO passa por aqui — o Terraform gerencia o ciclo de
 * vida do RG sozinho (via azurerm_resource_group + import).
 */
export async function ensureAzureResourceGroup(o: DeployFlowOptions): Promise<void> {
  if (!o.config.resourceGroup) {
    o.ui.error('Configure "resourceGroup" no iacmp.json para usar --provider azure (ex: "resourceGroup": "meu-rg").');
  }
  if (resourceGroupExists(o.config.resourceGroup)) return;

  const createCmd = { bin: 'az', args: ['group', 'create', '--name', o.config.resourceGroup, '--location', o.region] };
  if (o.dryRun) {
    o.ui.log(`Resource group "${o.config.resourceGroup}" ainda não existe — seria criado:`);
    o.ui.log(chalk.dim('  $ ') + formatCommand(createCmd));
  } else if (o.yes || !process.stdin.isTTY) {
    // --yes ou não-TTY (CI, pipe): cria o RG automaticamente sem perguntar
    // (criar RG é seguro/reversível — diferente de apagar recurso órfão).
    execFileSync(createCmd.bin, createCmd.args, { stdio: 'inherit' });
  } else {
    const proceed = await confirm(`Resource group "${o.config.resourceGroup}" não existe. Criar agora em ${o.region}?`);
    if (!proceed) {
      o.ui.error('Deploy cancelado — resource group não existe.');
    }
    execFileSync(createCmd.bin, createCmd.args, { stdio: 'inherit' });
  }
}
