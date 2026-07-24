import { Stack, BaseConstruct } from '@iacmp/core';
import { TFOutput } from './constructs/common.js';
import { synthMonitoring } from './constructs/monitoring.js';
import { synthStorage } from './constructs/storage.js';
import { synthFunction } from './constructs/function.js';
import { synthMessaging } from './constructs/messaging.js';
import { synthCompute } from './constructs/compute.js';
import { synthDatabase } from './constructs/database.js';
import { synthNetwork } from './constructs/network.js';
import { synthWorkflow } from './constructs/workflow.js';

function synthesizeConstruct(construct: BaseConstruct, ctx: TFOutput): void {
  if (synthMonitoring(construct, ctx)) return;
  if (synthStorage(construct, ctx)) return;
  if (synthFunction(construct, ctx)) return;
  if (synthMessaging(construct, ctx)) return;
  if (synthCompute(construct, ctx)) return;
  if (synthDatabase(construct, ctx)) return;
  if (synthNetwork(construct, ctx)) return;
  if (synthWorkflow(construct, ctx)) return;
  console.warn(`[gcp] Construct type '${construct.type}' nao suportado — descartado.`);
}

export function emitGCPTerraform(stack: Stack): string {
  const ctx: TFOutput = {
    resources: {},
    outputs: {},
    needsZoneVar: false,
  };

  for (const construct of stack.constructs) {
    synthesizeConstruct(construct, ctx);
  }

  const variables: Record<string, unknown> = {
    project_id: { type: 'string' },
    gcp_region: { type: 'string', default: 'us-central1' },
  };

  if (ctx.needsZoneVar) {
    variables.gcp_zone = { type: 'string', default: 'us-central1-a' };
  }

  const tfJson: Record<string, unknown> = {
    terraform: {
      required_providers: {
        google: { source: 'hashicorp/google', version: '~> 5.0' },
      },
    },
    provider: {
      google: {
        project: '${var.project_id}',
        region: '${var.gcp_region}',
      },
    },
    variable: variables,
  };

  if (Object.keys(ctx.resources).length > 0) {
    tfJson.resource = ctx.resources;
  }

  if (Object.keys(ctx.outputs).length > 0) {
    tfJson.output = ctx.outputs;
  }

  return JSON.stringify(tfJson, null, 2) + '\n';
}
