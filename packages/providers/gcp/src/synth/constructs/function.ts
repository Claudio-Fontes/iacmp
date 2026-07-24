import { BaseConstruct } from '@iacmp/core';
import { TFOutput, toTfId, addResource, RUNTIME_MAP } from './common.js';

export function synthFunction(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Function.Lambda': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const runtime = RUNTIME_MAP[(props.runtime as string) ?? 'nodejs20'] ?? 'nodejs20';
      addResource(r, 'google_cloudfunctions2_function', id, {
        name: construct.id,
        location: '${var.gcp_region}',
        build_config: [{
          runtime,
          entry_point: (props.handler as string) ?? 'handler',
          source: [{
            storage_source: [{
              bucket: '${var.project_id}-artifacts',
              object: 'function.zip',
            }],
          }],
        }],
        service_config: [{
          available_memory: `${(props.memory as number) ?? 128}Mi`,
          timeout_seconds: (props.timeout as number) ?? 30,
          ...(Object.keys(environment).length > 0 ? { environment_variables: environment } : {}),
        }],
      });
      ctx.outputs[`${construct.id}FunctionUrl`] = { value: `\${google_cloudfunctions2_function.${id}.service_config[0].uri}` };
      return true;
    }

    case 'Function.ApiGateway': {
      const apiId = toTfId(`${construct.id}_api`);
      const configId = toTfId(`${construct.id}_config`);
      const gatewayId = toTfId(`${construct.id}_gw`);
      const apiName = (props.name as string) ?? construct.id;
      addResource(r, 'google_api_gateway_api', apiId, {
        api_id: apiName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        display_name: apiName,
      });
      addResource(r, 'google_api_gateway_api_config', configId, {
        api: `\${google_api_gateway_api.${apiId}.api_id}`,
        display_name: `${construct.id} config`,
        openapi_documents: [{
          document: [{
            path: 'openapi.yaml',
            contents: Buffer.from(JSON.stringify({
              openapi: '3.0.0',
              info: { title: apiName, version: '1.0' },
              paths: {},
            })).toString('base64'),
          }],
        }],
      });
      addResource(r, 'google_api_gateway_gateway', gatewayId, {
        api_id: `\${google_api_gateway_api.${apiId}.api_id}`,
        api_config: `\${google_api_gateway_api_config.${configId}.id}`,
        gateway_id: `${construct.id}-gateway`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        region: '${var.gcp_region}',
      });
      return true;
    }

    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachTo = (props.attachTo as string) ?? construct.id;
      const accountId = attachTo.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
      const saId = `${id}_sa`;
      addResource(r, 'google_service_account', saId, {
        account_id: accountId,
        display_name: `Service Account for ${attachTo}`,
      });
      statements.forEach((s, i) => {
        const role = (s.actions as string[])?.[0]?.startsWith('roles/')
          ? (s.actions as string[])[0]
          : `roles/viewer`;
        addResource(r, 'google_project_iam_binding', `${id}_binding_${i}`, {
          project: '${var.project_id}',
          role,
          members: [`serviceAccount:\${google_service_account.${saId}.email}`],
        });
      });
      return true;
    }

    default:
      return false;
  }
}
