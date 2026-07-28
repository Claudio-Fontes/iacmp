import { Stack, BaseConstruct } from '@iacmp/core';
import { AzureTFCtx, newCtx } from './common';
import { TFRegistry, buildRegistry } from './refs';
import { synthFunction } from './constructs/function';
import { synthStorage } from './constructs/storage';
import { synthDatabase } from './constructs/database';
import { synthMessaging } from './constructs/messaging';
import { synthNetwork } from './constructs/network';
import { synthSecurity } from './constructs/security';
import { synthMonitoring } from './constructs/monitoring';
import { synthCompute } from './constructs/compute';

/**
 * Dispatcher por domínio — espelha o padrão dos synths AWS e GCP
 * (constructs/<domínio>.ts com assinatura `synth<Dom>(c, ctx, reg): boolean`).
 */
function synthesizeConstruct(c: BaseConstruct, ctx: AzureTFCtx, reg: TFRegistry): void {
  const handled =
    synthFunction(c, ctx, reg) ||
    synthStorage(c, ctx) ||
    synthDatabase(c, ctx, reg) ||
    synthMessaging(c, ctx) ||
    synthNetwork(c, ctx) ||
    synthSecurity(c, ctx, reg) ||
    synthMonitoring(c, ctx) ||
    synthCompute(c, ctx, reg);
  if (!handled) {
    process.stderr.write(`[azure-tf] Construct '${c.type}' não suportado — descartado.\n`);
  }
}

export class AzureTerraformProvider {
  private registry: TFRegistry = new Map();

  synthesizeResources(stack: Stack, allStacks: Stack[]): string {
    if (this.registry.size === 0) {
      this.registry = buildRegistry(allStacks);
    }
    const ctx = newCtx();
    for (const c of stack.constructs) {
      synthesizeConstruct(c, ctx, this.registry);
    }
    const tf: Record<string, unknown> = {};
    if (Object.keys(ctx.resources).length > 0) tf.resource = ctx.resources;
    if (Object.keys(ctx.outputs).length > 0) tf.output = ctx.outputs;
    if (ctx.needsClientConfig) {
      tf.data = { azurerm_client_config: { current: {} } };
    }
    return JSON.stringify(tf, null, 2) + '\n';
  }

  synthesizeProviders(location = 'eastus2', resourceGroup = 'iacmp-rg'): string {
    const tf = {
      terraform: {
        required_providers: {
          azurerm: { source: 'hashicorp/azurerm', version: '~> 4.0' },
        },
      },
      provider: {
        azurerm: { features: {} },
      },
      variable: {
        resource_group: { type: 'string', default: resourceGroup },
        location: { type: 'string', default: location },
      },
      data: {
        azurerm_client_config: { current: {} },
      },
      resource: {
        azurerm_resource_group: {
          main: {
            name: '${var.resource_group}',
            location: '${var.location}',
          },
        },
      },
    };
    return JSON.stringify(tf, null, 2) + '\n';
  }
}
