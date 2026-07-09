import { BaseConstruct, isRef } from '@iacmp/core';
import type { Ref } from '@iacmp/core';
import { expr, tag, toSym, safeStorageName, crossParamName, resolveValue, resolveRef, SynthContext } from './shared';

export function synthesizeFunction(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs, crossParams } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Function.Lambda': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const fnBaseName = construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
      const saPrefix = safeStorageName(construct.id + 'fn').slice(0, 11);
      const saSym = `${sym}Sa`;
      const planSym = ctx.sharedFunctionPlanSym ?? `${sym}Plan`;

      // Storage Account para AzureWebJobsStorage (name = prefix 11 chars + uniqueString 13 chars = 24 chars)
      resources.push({
        sym: saSym,
        type: 'Microsoft.Storage/storageAccounts',
        apiVersion: '2023-01-01',
        name: expr(`'${saPrefix}\${uniqueString(resourceGroup().id)}'`),
        location: 'location',
        kind: 'StorageV2',
        sku: { name: 'Standard_LRS' },
        tags: tag(construct.id),
        properties: {
          allowBlobPublicAccess: false,
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
        },
      });

      const envVars = Object.entries(environment).map(([k, v]) => {
        const value = resolveValue(v, ctx.idx, crossParams);
        if (value === undefined || value === null) {
          throw new Error(`Fn.Lambda "${construct.id}": env var "${k}" resolveu para undefined. No código da STACK, o valor de environment deve ser uma string literal ou ref('X','Attr') — nunca process.env.${k} (isso é runtime, não existe no synth).`);
        }
        return { name: k, value };
      });

      const connStr = expr(`'DefaultEndpointsProtocol=https;AccountName=\${${saSym}.name};AccountKey=\${${saSym}.listKeys().keys[0].value};EndpointSuffix=core.windows.net'`);

      const appSettings = [
        { name: 'AzureWebJobsStorage', value: connStr },
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' },
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' },
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' },
        ...envVars,
      ];

      // Function App
      resources.push({
        sym,
        type: 'Microsoft.Web/sites',
        apiVersion: '2022-03-01',
        name: expr(`'${fnBaseName}-\${uniqueString(resourceGroup().id)}'`),
        location: 'location',
        kind: 'functionapp,linux',
        tags: tag(construct.id),
        identity: { type: 'SystemAssigned' },
        properties: {
          serverFarmId: expr(`${planSym}.id`),
          siteConfig: {
            linuxFxVersion: 'Node|20',
            appSettings,
          },
          httpsOnly: true,
        },
      });

      const fnAppNameOutputKey = `${construct.id.replace(/[^a-zA-Z0-9]/g, '')}FunctionAppName`;
      outputs.push({ name: `${construct.id}Id`, type: 'string', value: `${sym}.id` });
      outputs.push({ name: `${construct.id}PrincipalId`, type: 'string', value: `${sym}.identity.principalId` });
      outputs.push({ name: crossParamName(construct.id, 'Fqdn'), type: 'string', value: `${sym}.properties.defaultHostName` });
      outputs.push({ name: fnAppNameOutputKey, type: 'string', value: `${sym}.name` });
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
        properties: { displayName: rawName, path: ((props.path as string) || 'api'), protocols: ['https'], subscriptionRequired: false, serviceUrl: '' },
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
        const lambdaConst = ctx.idx.get(lambdaId);
        if (lambdaConst) {
          const lambdaSym = toSym(lambdaId);
          if (lambdaConst.type === 'Function.Lambda') {
            backendUrl = expr(`'https://\${${lambdaSym}.properties.defaultHostName}'`);
          } else {
            backendUrl = expr(`'https://\${${lambdaSym}.properties.configuration.ingress.fqdn}'`);
          }
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
            description: `Function App backend for ${lambdaId}`,
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
        const authConst = ctx.idx.get(authorizerLambdaId);
        if (authConst) {
          const authFnSym = toSym(authorizerLambdaId);
          if (authConst.type === 'Function.Lambda') {
            authUrl = expr(`'https://\${${authFnSym}.properties.defaultHostName}'`);
          } else {
            authUrl = expr(`'https://\${${authFnSym}.properties.configuration.ingress.fqdn}'`);
          }
        } else {
          const authFqdnParam = crossParamName(authorizerLambdaId, 'Fqdn');
          crossParams.set(authFqdnParam, 'string');
          authUrl = expr(`'https://\${${authFqdnParam}}'`);
        }
        resources.push({ sym: `${sym}AuthorizerBackend`, type: 'Microsoft.ApiManagement/service/backends', apiVersion: '2023-05-01-preview', parent: sym, name: 'authorizer-backend', properties: { description: `Function App authorizer backend (${authorizerLambdaId})`, url: authUrl, protocol: 'http' } });
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
          const targetConst = ctx.idx.get(targetLambdaId);
          if (targetConst) {
            const lSym = toSym(targetLambdaId);
            if (targetConst.type === 'Function.Lambda') {
              targetUrl = expr(`'https://\${${lSym}.properties.defaultHostName}/invoke'`);
            } else {
              targetUrl = expr(`'https://\${${lSym}.properties.configuration.ingress.fqdn}/invoke'`);
            }
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
              if (refConstruct.type === 'Function.Lambda') {
                uri = expr(`'https://\${${lambdaSym}.properties.defaultHostName}'`);
              } else {
                uri = expr(`'https://\${${lambdaSym}.properties.configuration.ingress.fqdn}'`);
              }
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
