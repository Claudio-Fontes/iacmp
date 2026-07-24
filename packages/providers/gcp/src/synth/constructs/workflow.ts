import { BaseConstruct } from '@iacmp/core';
import { TFOutput, toTfId, addResource } from './common.js';

export function synthWorkflow(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const definition = {
        main: {
          steps: steps.map((s) => ({
            [s.name as string]: {
              call: 'http.post',
              args: { url: (s.resource as string) ?? '' },
            },
          })),
        },
      };
      addResource(r, 'google_workflows_workflow', id, {
        name: construct.id,
        region: '${var.gcp_region}',
        source_contents: JSON.stringify(definition, null, 2),
      });
      return true;
    }

    default:
      return false;
  }
}
