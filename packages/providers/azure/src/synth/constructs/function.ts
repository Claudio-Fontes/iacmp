import { BaseConstruct, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';
import { expr, tag, toSym, crossParamName, resolveValue, resolveRef, SynthContext } from './shared';

export function synthesizeFunction(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs, crossParams, functionImageParams } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Function.Lambda': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const imageParamName = `${sym}Image`;
      functionImageParams.add(imageParamName);
      const envVars = Object.entries(environment).map(([k, v]) => {
        const value = resolveValue(v, ctx.idx, crossParams);
        if (value === undefined || value === null) {
          throw new Error(`Fn.Lambda "${construct.id}": env var "${k}" resolveu para undefined. No código da STACK, o valor de environment deve ser uma string literal ou ref('X','Attr') — nunca process.env.${k} (isso é runtime, não existe no synth).`);
        }
        return { name: k, value };
      });
      resources.push({
        sym,
        type: 'Microsoft.App/containerApps',
        apiVersion: '2023-05-01',
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        location: 'location',
        tags: tag(construct.id),
        identity: { type: 'SystemAssigned' },
        properties: {
          managedEnvironmentId: expr(`empty(sharedCaeId) ? sharedContainerEnv.id : sharedCaeId`),
          configuration: {
            ingress: { external: true, targetPort: 3000 },
            registries: expr(`empty(acrServer) ? [] : [{\n    server: acrServer\n    username: acrUser\n    passwordSecretRef: 'acr-pwd'\n  }]`),
            secrets: expr(`empty(acrPassword) ? [] : [{\n    name: 'acr-pwd'\n    value: acrPassword\n  }]`),
          },
          template: {
            containers: [{
              name: construct.id.toLowerCase(),
              image: expr(imageParamName),
              resources: { cpu: expr("json('0.25')"), memory: '0.5Gi' },
              env: envVars,
              probes: [{ type: 'Startup', tcpSocket: { port: 3000 }, periodSeconds: 5, failureThreshold: 30 }],
            }],
            scale: { minReplicas: 0, maxReplicas: 10 },
          },
        },
      });
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}PrincipalId`, type: 'string', value: `${sym}.identity.principalId` });
      outputs.push({ name: crossParamName(construct.id, 'Fqdn'), type: 'string', value: `${sym}.properties.configuration.ingress.fqdn` });
      break;
    }

    case 'Function.ApiGateway': {
      const rawName = (props.name as string) ?? construct.id;
      const apimBase = rawName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 36);
      const apimName = expr(`'${apimBase}-\${uniqueString(resourceGroup().id)}'`);
      const authorizerLambdaId = props.authorizerLambdaId as string | undefined;
      const routes = (props.routes as Array<Record<string, unknown>>) ?? [];

      const routeAuthorizerIds = [...new Set(routes.filter(r => r.authorizerLambdaId).map(r => r.authorizerLambdaId as string))];
      const hasRouteAuthorizer = routeAuthorizerIds.length > 0;

      const kvEntry = hasRouteAuthorizer ? [...ctx.idx.entries()].find(([, c]) => c.type === 'Secret.Vault') : undefined;
      const jwtKvSym = kvEntry ? toSym(kvEntry[0]) : undefined;
      const apimNamedValueSym = jwtKvSym ? `${sym}JwtNamedValue` : undefined;

      resources.push({
        sym,
        type: 'Microsoft.ApiManagement/service',
        apiVersion: '2023-05-01-preview',
        name: apimName,
        location: 'location',
        tags: tag(construct.id),
        sku: { name: 'Consumption', capacity: 0 },
        ...(jwtKvSym ? { identity: { type: 'SystemAssigned' } } : {}),
        properties: {
          publisherEmail: 'admin@example.com',
          publisherName: construct.id,
          virtualNetworkType: 'None',
          customProperties: {
            'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'false',
            'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'false',
          },
        },
      });

      const apiSym = `${sym}Api`;
      resources.push({
        sym: apiSym,
        type: 'Microsoft.ApiManagement/service/apis',
        apiVersion: '2023-05-01-preview',
        parent: sym,
        name: 'main',
        properties: { displayName: rawName, path: 'api', protocols: ['https'], subscriptionRequired: false, serviceUrl: '' },
      });

      if (props.cors) {
        const corsXml = `<policies><inbound><base /><cors allow-credentials="false"><allowed-origins><origin>*</origin></allowed-origins><allowed-methods preflight-result-max-age="300"><method>*</method></allowed-methods><allowed-headers><header>*</header></allowed-headers></cors></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>`;
        resources.push({ sym: `${sym}ApiPolicy`, type: 'Microsoft.ApiManagement/service/apis/policies', apiVersion: '2023-05-01-preview', parent: apiSym, name: 'policy', properties: { value: corsXml, format: 'xml' } });
      }

      const uniqueLambdaIds = [...new Set(routes.filter(r => r.lambdaId).map(r => r.lambdaId as string))];
      const backendNameMap = new Map<string, string>();
      for (const lambdaId of uniqueLambdaIds) {
        const backendName = `backend-${lambdaId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
        backendNameMap.set(lambdaId, backendName);
        let backendUrl: string;
        if (ctx.idx.get(lambdaId)) {
          const lambdaSym = toSym(lambdaId);
          backendUrl = expr(`'https://\${${lambdaSym}.properties.configuration.ingress.fqdn}'`);
        } else {
          const fqdnParam = crossParamName(lambdaId, 'Fqdn');
          crossParams.set(fqdnParam, 'string');
          backendUrl = expr(`'https://\${${fqdnParam}}'`);
        }
        resources.push({
          sym: `${sym}Backend${lambdaId.replace(/[^a-zA-Z0-9]/g, '')}`,
          type: 'Microsoft.ApiManagement/service/backends',
          apiVersion: '2023-05-01-preview',
          parent: sym,
          name: backendName,
          properties: {
            url: backendUrl,
            protocol: 'http',
            description: `Container App backend for ${lambdaId}`,
          },
        });
      }

      for (let ri = 0; ri < routes.length; ri++) {
        const route = routes[ri];
        const method = (route.method as string) ?? 'GET';
        const path = (route.path as string) ?? '/';
        const lambdaId = route.lambdaId as string | undefined;
        const routeAuthId = route.authorizerLambdaId as string | undefined;
        const opSym = `${sym}Op${ri}`;
        const sanitizedPath = path.replace(/\{(\w+)\+\}/g, '{$1}').replace(/^\$/, '');
        const templateParams = [...sanitizedPath.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], required: true, type: 'string' }));
        resources.push({
          sym: opSym,
          type: 'Microsoft.ApiManagement/service/apis/operations',
          apiVersion: '2023-05-01-preview',
          parent: apiSym,
          name: `op-${method.toLowerCase()}-${ri}`,
          properties: {
            displayName: `${method} ${path}`,
            method,
            urlTemplate: sanitizedPath,
            description: (route.description as string) ?? `${method} ${path}`,
            ...(templateParams.length > 0 ? { templateParameters: templateParams } : {}),
          },
        });
        if (lambdaId) {
          const backendId = backendNameMap.get(lambdaId) ?? `backend-${lambdaId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
          const usesJwt = routeAuthId !== undefined && jwtKvSym !== undefined;
          const opXml = usesJwt
            ? `<policies><inbound><base /><validate-jwt header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized" require-expiration-time="false"><issuer-signing-keys><key>{{jwt-signing-key}}</key></issuer-signing-keys></validate-jwt><set-backend-service backend-id="${backendId}" /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>`
            : `<policies><inbound><base /><set-backend-service backend-id="${backendId}" /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>`;
          resources.push({
            sym: `${sym}Policy${ri}`,
            type: 'Microsoft.ApiManagement/service/apis/operations/policies',
            apiVersion: '2023-05-01-preview',
            parent: opSym,
            name: 'policy',
            properties: { value: opXml, format: 'xml' },
            ...(usesJwt && apimNamedValueSym ? { dependsOn: [apimNamedValueSym] } : {}),
          });
        }
      }

      if (jwtKvSym) {
        const apimKvAccessPolicySym = `${sym}KvAccessPolicy`;
        resources.push({
          sym: apimKvAccessPolicySym,
          type: 'Microsoft.KeyVault/vaults/accessPolicies',
          apiVersion: '2023-02-01',
          parent: jwtKvSym,
          name: 'add',
          properties: {
            accessPolicies: [{
              tenantId: expr('subscription().tenantId'),
              objectId: expr(`${sym}.identity.principalId`),
              permissions: { secrets: ['get'] },
            }],
          },
        });
        resources.push({
          sym: `${sym}JwtNamedValue`,
          type: 'Microsoft.ApiManagement/service/namedValues',
          apiVersion: '2023-05-01-preview',
          parent: sym,
          name: 'jwt-signing-key',
          properties: {
            displayName: 'jwt-signing-key',
            secret: true,
            keyVault: {
              secretIdentifier: expr(`'\${${jwtKvSym}.properties.vaultUri}secrets/secret-value'`),
            },
          },
          dependsOn: [apimKvAccessPolicySym],
        });
      }

      if (authorizerLambdaId) {
        let authUrl: string;
        if (ctx.idx.get(authorizerLambdaId)) {
          const authFnSym = toSym(authorizerLambdaId);
          authUrl = expr(`'https://\${${authFnSym}.properties.configuration.ingress.fqdn}'`);
        } else {
          const authFqdnParam = crossParamName(authorizerLambdaId, 'Fqdn');
          crossParams.set(authFqdnParam, 'string');
          authUrl = expr(`'https://\${${authFqdnParam}}'`);
        }
        resources.push({ sym: `${sym}AuthorizerBackend`, type: 'Microsoft.ApiManagement/service/backends', apiVersion: '2023-05-01-preview', parent: sym, name: 'authorizer-backend', properties: { description: `Lambda authorizer backend (${authorizerLambdaId})`, url: authUrl, protocol: 'http' } });
      }

      outputs.push({ name: `${construct.id}Url`, type: 'string', value: `${sym}.properties.gatewayUrl` });
      break;
    }

    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      for (let ri = 0; ri < rules.length; ri++) {
        const r = rules[ri];
        const ruleSym = `${sym}Rule${ri}`;
        const ruleName = ((r.name as string) ?? `${construct.id}-rule-${ri}`).toLowerCase();

        let recurrence: Record<string, unknown> = { frequency: 'Day', interval: 1 };
        if (r.cron) {
          const parts = (r.cron as string).trim().split(/\s+/);
          const minute = parseInt(parts[0] ?? '0', 10) || 0;
          const hour   = parseInt(parts[1] ?? '0', 10) || 0;
          recurrence = { frequency: 'Day', interval: 1, timeZone: 'UTC', schedule: { hours: [String(hour)], minutes: [minute] } };
        } else if (r.rate) {
          const m = (r.rate as string).toLowerCase().match(/^(\d+)\s+(minute|minutes|hour|hours|day|days)$/);
          if (m) {
            const freqMap: Record<string, string> = { minute: 'Minute', minutes: 'Minute', hour: 'Hour', hours: 'Hour', day: 'Day', days: 'Day' };
            recurrence = { frequency: freqMap[m[2]] ?? 'Hour', interval: parseInt(m[1], 10) };
          }
        }

        let targetUrl: unknown = '';
        const targetLambdaId = r.targetLambdaId as string | undefined;
        if (targetLambdaId) {
          if (ctx.idx.get(targetLambdaId)) {
            const lSym = toSym(targetLambdaId);
            targetUrl = expr(`'https://\${${lSym}.properties.configuration.ingress.fqdn}/invoke'`);
          } else {
            const fqdnParam = crossParamName(targetLambdaId, 'Fqdn');
            crossParams.set(fqdnParam, 'string');
            targetUrl = expr(`'https://\${${fqdnParam}}/invoke'`);
          }
        }

        resources.push({
          sym: ruleSym,
          type: 'Microsoft.Logic/workflows',
          apiVersion: '2019-05-01',
          name: ruleName,
          location: 'location',
          tags: tag(construct.id),
          properties: {
            definition: {
              '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
              contentVersion: '1.0.0.0',
              triggers: {
                Recurrence: { type: 'Recurrence', recurrence },
              },
              actions: {
                InvokeTarget: {
                  type: 'Http',
                  inputs: { method: 'POST', uri: targetUrl, body: { rule: ruleName, time: '@{utcNow()}' } },
                  runAfter: {},
                },
              },
            },
            parameters: {},
          },
        });
      }
      break;
    }

    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const actions: Record<string, unknown> = {};
      for (let si = 0; si < steps.length; si++) {
        const s = steps[si];
        const stepName = s.name as string;
        const runAfter = si > 0 ? { [steps[si - 1].name as string]: ['Succeeded'] } : {};
        const stepType = (s.type as string) ?? 'Task';
        if (stepType === 'Wait') {
          const secs = (s.seconds as number) ?? 60;
          const mins = Math.max(1, Math.ceil(secs / 60));
          actions[stepName] = { type: 'Wait', inputs: { interval: { count: mins, unit: 'Minute' } }, runAfter };
        } else {
          let uri: unknown = '';
          const rawResource = s.resource;
          if (isRef(rawResource)) {
            const refObj = rawResource as Ref;
            const refConstruct = ctx.idx.get(refObj.constructId);
            if (refConstruct && (refConstruct.type === 'Function.Lambda' || refConstruct.type === 'Compute.Container')) {
              const lambdaSym = toSym(refObj.constructId);
              uri = expr(`'https://\${${lambdaSym}.properties.configuration.ingress.fqdn}'`);
            } else if (!refConstruct) {
              const fqdnParam = crossParamName(refObj.constructId, 'Fqdn');
              crossParams.set(fqdnParam, 'string');
              uri = expr(`'https://\${${fqdnParam}}'`);
            } else {
              uri = resolveRef(refObj, ctx.idx, crossParams);
            }
          } else if (typeof rawResource === 'string') {
            uri = rawResource;
          }
          actions[stepName] = { type: 'Http', inputs: { method: 'POST', uri }, runAfter };
        }
      }
      resources.push({ sym, type: 'Microsoft.Logic/workflows', apiVersion: '2019-05-01', name: construct.id, location: 'location', tags: tag(construct.id), properties: { definition: { '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#', contentVersion: '1.0.0.0', triggers: {}, actions } } });
      outputs.push({ name: crossParamName(construct.id, 'Arn'), type: 'string', value: `${sym}.id` });
      break;
    }
  }
}
