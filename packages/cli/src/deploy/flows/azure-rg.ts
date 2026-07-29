import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { t } from '../../i18n';
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
    o.ui.error(t(
      'Configure "resourceGroup" no iacmp.json para usar --provider azure (ex: "resourceGroup": "meu-rg").',
      'Set "resourceGroup" in iacmp.json to use --provider azure (e.g. "resourceGroup": "my-rg").',
    ));
  }
  if (resourceGroupExists(o.config.resourceGroup)) return;

  const createCmd = { bin: 'az', args: ['group', 'create', '--name', o.config.resourceGroup, '--location', o.region] };
  if (o.dryRun) {
    o.ui.log(t(
      `Resource group "${o.config.resourceGroup}" ainda não existe — seria criado:`,
      `Resource group "${o.config.resourceGroup}" does not exist yet — it would be created:`,
    ));
    o.ui.log(chalk.dim('  $ ') + formatCommand(createCmd));
  } else if (o.yes || !process.stdin.isTTY) {
    // --yes ou não-TTY (CI, pipe): cria o RG automaticamente sem perguntar
    // (criar RG é seguro/reversível — diferente de apagar recurso órfão).
    execFileSync(createCmd.bin, createCmd.args, { stdio: 'inherit' });
  } else {
    const proceed = await confirm(t(
      `Resource group "${o.config.resourceGroup}" não existe. Criar agora em ${o.region}?`,
      `Resource group "${o.config.resourceGroup}" does not exist. Create it now in ${o.region}?`,
    ));
    if (!proceed) {
      o.ui.error(t('Deploy cancelado — resource group não existe.', 'Deploy canceled — resource group does not exist.'));
    }
    execFileSync(createCmd.bin, createCmd.args, { stdio: 'inherit' });
  }
}
