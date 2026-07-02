import { BaseConstruct } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import {
  resolveLambdaArnRef,
  requireLambda,
  buildInvocationUri,
  resolveLambdaRole,
  resolveSubnetId,
  resolveSecurityGroupId,
  resolveQueueArn,
  resolvePolicyResource,
  resolveEnvVarValue,
} from '../resolvers';

export function synthFunction(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Function.Lambda': {
      const environment = props.environment as Record<string, string> | undefined;
      const runtimeMap: Record<string, string> = {
        'nodejs20': 'nodejs20.x', 'nodejs18': 'nodejs18.x',
        'python3.12': 'python3.12', 'python3.11': 'python3.11',
        'java21': 'java21', 'go1.x': 'go1.x', 'dotnet8': 'dotnet8',
      };
      const role = resolveLambdaRole(construct.id, logicalId, ctx, !!props.vpcId);
      const entries: Array<[string, CloudFormationResource]> = [];
      if (role.extraResource) entries.push(role.extraResource);
      entries.push([logicalId, {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: construct.id,
          Runtime: runtimeMap[(props.runtime as string) ?? 'nodejs20'] ?? 'nodejs20.x',
          Handler: props.handler as string,
          // String (não { ZipFile }) — formato local-path que `aws cloudformation
          // package` reconhece e transforma em S3Bucket/S3Key antes do deploy real.
          Code: props.code as string,
          MemorySize: (props.memory as number) ?? 128,
          Timeout: (props.timeout as number) ?? 30,
          Role: role.roleRef,
          ...(props.reservedConcurrency !== undefined ? { ReservedConcurrentExecutions: props.reservedConcurrency } : {}),
          ...(environment && Object.keys(environment).length > 0 ? {
            Environment: {
              Variables: Object.fromEntries(
                Object.entries(environment).map(([k, v]) => [k, resolveEnvVarValue(v, ctx)])
              ),
            },
          } : {}),
          ...(props.vpcId ? {
            VpcConfig: {
              SubnetIds: ((props.subnetIds as string[]) ?? []).map(id => resolveSubnetId(id, ctx)),
              SecurityGroupIds: ((props.securityGroupIds as string[]) ?? []).map(id => resolveSecurityGroupId(id, ctx)),
            },
          } : {}),
        },
      }]);

      // Event source mappings: aciona a Lambda a partir de filas SQS ou streams Kinesis.
      const eventSources = (props.eventSources as Array<Record<string, unknown>> | undefined) ?? [];
      eventSources.forEach((es, i) => {
        const esmId = `${logicalId}EventSource${i + 1}`;
        if (es.streamId) {
          // Kinesis: exige StartingPosition; suporta BisectBatchOnFunctionError e
          // batchSize maior (até 10000). O ARN do stream resolve como os demais (-Arn).
          entries.push([esmId, {
            Type: 'AWS::Lambda::EventSourceMapping',
            Properties: {
              EventSourceArn: resolveQueueArn(es.streamId as string, ctx),
              FunctionName: { Ref: logicalId },
              BatchSize: (es.batchSize as number) ?? 100,
              StartingPosition: (es.startingPosition as string) ?? 'LATEST',
              ...(es.bisectBatchOnFunctionError !== undefined ? { BisectBatchOnFunctionError: es.bisectBatchOnFunctionError } : {}),
              ...(es.maxBatchingWindowSeconds !== undefined ? { MaximumBatchingWindowInSeconds: es.maxBatchingWindowSeconds } : {}),
            },
          }]);
          return;
        }
        entries.push([esmId, {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            EventSourceArn: resolveQueueArn(es.queueId as string, ctx),
            FunctionName: { Ref: logicalId },
            BatchSize: (es.batchSize as number) ?? 10,
            // BisectBatchOnFunctionError NÃO é suportado para SQS (só Kinesis/DynamoDB
            // streams) — ignorado de propósito para não quebrar o deploy.
            ...(es.maxBatchingWindowSeconds !== undefined ? { MaximumBatchingWindowInSeconds: es.maxBatchingWindowSeconds } : {}),
          },
        }]);
      });
      return entries;
    }

    case 'Function.ApiGateway': {
      const apigwType = (props.type as string) ?? 'HTTP';
      const routes = (props.routes as Array<Record<string, unknown>>) ?? [];
      // Toda rota com lambdaId TEM que apontar para uma Fn.Lambda (não um container etc).
      for (const r of routes) if (r.lambdaId) requireLambda(r.lambdaId as string, ctx);
      // REST (v1) só aceita nome de stage [a-zA-Z0-9_] — '$default' é exclusivo do
      // HTTP API (v2). Default por tipo pra não quebrar o deploy do REST.
      const stageName = (props.stageName as string) ?? (apigwType === 'REST' ? 'prod' : '$default');
      const authorizerLambdaId = props.authorizerLambdaId as string | undefined;
      if (authorizerLambdaId) requireLambda(authorizerLambdaId, ctx);
      for (const r of routes) if (r.authorizerLambdaId) requireLambda(r.authorizerLambdaId as string, ctx);
      const authorizerId = authorizerLambdaId ? `${logicalId}Authorizer` : undefined;
      // Authorizer por rota (route.authorizerLambdaId) — cada Lambda authorizer
      // distinta vira um AWS::Gateway::Authorizer. Combinado com o do gateway.
      // Uma rota com authType 'NONE' fica pública mesmo se o gateway tem authorizer.
      const routeAuthorizerIds = new Map<string, string>(); // lambdaId → authorizerLogicalId
      if (authorizerLambdaId) routeAuthorizerIds.set(authorizerLambdaId, authorizerId!);
      for (const r of routes) {
        const ra = r.authorizerLambdaId as string | undefined;
        if (ra && !routeAuthorizerIds.has(ra)) {
          routeAuthorizerIds.set(ra, `${logicalId}${ra.replace(/[^a-zA-Z0-9]/g, '')}Authorizer`);
        }
      }
      // Toda Lambda referenciada (rotas + authorizers) precisa de uma
      // AWS::Lambda::Permission liberando o API Gateway a invocá-la.
      const lambdaIdsNeedingPermission = new Set<string>();
      for (const la of routeAuthorizerIds.keys()) lambdaIdsNeedingPermission.add(la);
      for (const r of routes) {
        if (r.lambdaId) lambdaIdsNeedingPermission.add(r.lambdaId as string);
      }

      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: apigwType === 'REST' ? 'AWS::ApiGateway::RestApi' : 'AWS::ApiGatewayV2::Api',
        Properties: {
          Name: props.name as string,
          // ApiGateway (v1) rejeita Description: '' com 400 ("cannot be an
          // empty string") — omitir a propriedade quando não houver
          // descrição, em vez de mandar string vazia como default.
          ...(props.description ? { Description: props.description as string } : {}),
          ...(apigwType !== 'REST' ? { ProtocolType: apigwType } : {}),
          // WEBSOCKET exige RouteSelectionExpression (qual campo do payload escolhe a rota).
          ...(apigwType === 'WEBSOCKET' ? { RouteSelectionExpression: '$request.body.action' } : {}),
          ...(apigwType !== 'REST' && props.cors ? { CorsConfiguration: { AllowOrigins: ['*'], AllowMethods: ['*'], AllowHeaders: ['*'] } } : {}),
        },
      }]];

      if (apigwType === 'REST') {
        // ── REST (API Gateway v1) — Resource/Method/Deployment, incompatível
        // com os recursos ApiGatewayV2 usados no branch HTTP abaixo. ─────────
        const resourceIdByPath = new Map<string, string>(); // caminho cumulativo → logicalId do Resource
        const methodLogicalIds: string[] = [];
        const corsResourceRefs = new Map<string, unknown>(); // logicalId-do-resource-ou-root → ref, deduplicado

        const resolveResourceRef = (path: string): unknown => {
          const segments = path.split('/').filter(Boolean);
          if (segments.length === 0) return { 'Fn::GetAtt': [logicalId, 'RootResourceId'] };

          let parentRef: unknown = { 'Fn::GetAtt': [logicalId, 'RootResourceId'] };
          let cumulative = '';
          for (const seg of segments) {
            cumulative += `/${seg}`;
            let segLogicalId = resourceIdByPath.get(cumulative);
            if (!segLogicalId) {
              segLogicalId = `${logicalId}Resource${cumulative.replace(/[^a-zA-Z0-9]/g, '')}`;
              entries.push([segLogicalId, {
                Type: 'AWS::ApiGateway::Resource',
                Properties: { RestApiId: { Ref: logicalId }, ParentId: parentRef, PathPart: seg },
              }]);
              resourceIdByPath.set(cumulative, segLogicalId);
            }
            parentRef = { Ref: segLogicalId };
          }
          return { Ref: resourceIdByPath.get(cumulative)! };
        };

        // Um AWS::ApiGateway::Authorizer por Lambda authorizer distinta.
        for (const [la, authLogicalId] of routeAuthorizerIds) {
          entries.push([authLogicalId, {
            Type: 'AWS::ApiGateway::Authorizer',
            Properties: {
              RestApiId: { Ref: logicalId },
              Type: 'REQUEST',
              Name: `${props.name as string}-${la}`,
              AuthorizerUri: buildInvocationUri(la, ctx),
              IdentitySource: 'method.request.header.Authorization',
              AuthorizerResultTtlInSeconds: 0,
            },
          }]);
        }

        for (const r of routes) {
          const path = r.path as string;
          const method = r.method as string;
          const resourceRef = resolveResourceRef(path);
          const methodLogicalId = `${logicalId}${method}${path.replace(/[^a-zA-Z0-9]/g, '')}Method`;
          // Auth por rota (mesma lógica do HTTP): 'NONE' força pública.
          const routeAuthLambda = (r.authType === 'NONE')
            ? undefined
            : (r.authorizerLambdaId as string | undefined) ?? authorizerLambdaId;
          const routeAuthId = routeAuthLambda ? routeAuthorizerIds.get(routeAuthLambda) : undefined;

          entries.push([methodLogicalId, {
            Type: 'AWS::ApiGateway::Method',
            Properties: {
              RestApiId: { Ref: logicalId },
              ResourceId: resourceRef,
              HttpMethod: method,
              AuthorizationType: routeAuthId ? 'CUSTOM' : 'NONE',
              ...(routeAuthId ? { AuthorizerId: { Ref: routeAuthId } } : {}),
              ...(r.lambdaId ? {
                Integration: {
                  Type: 'AWS_PROXY',
                  IntegrationHttpMethod: 'POST',
                  Uri: buildInvocationUri(r.lambdaId as string, ctx),
                },
              } : {}),
            },
          }]);
          methodLogicalIds.push(methodLogicalId);

          if (props.cors) {
            const corsKey = path;
            if (!corsResourceRefs.has(corsKey)) corsResourceRefs.set(corsKey, resourceRef);
          }
        }

        // OPTIONS+MOCK por resource único que tenha rota com CORS habilitado.
        for (const [path, resourceRef] of corsResourceRefs) {
          const optionsId = `${logicalId}Options${path.replace(/[^a-zA-Z0-9]/g, '')}Method`;
          entries.push([optionsId, {
            Type: 'AWS::ApiGateway::Method',
            Properties: {
              RestApiId: { Ref: logicalId },
              ResourceId: resourceRef,
              HttpMethod: 'OPTIONS',
              AuthorizationType: 'NONE',
              Integration: {
                Type: 'MOCK',
                RequestTemplates: { 'application/json': '{"statusCode": 200}' },
                IntegrationResponses: [{
                  StatusCode: '200',
                  ResponseParameters: {
                    'method.response.header.Access-Control-Allow-Headers': "'Content-Type,Authorization'",
                    'method.response.header.Access-Control-Allow-Methods': "'OPTIONS,GET,POST,PUT,DELETE,PATCH'",
                    'method.response.header.Access-Control-Allow-Origin': "'*'",
                  },
                }],
              },
              MethodResponses: [{
                StatusCode: '200',
                ResponseParameters: {
                  'method.response.header.Access-Control-Allow-Headers': true,
                  'method.response.header.Access-Control-Allow-Methods': true,
                  'method.response.header.Access-Control-Allow-Origin': true,
                },
              }],
            },
          }]);
          methodLogicalIds.push(optionsId);
        }

        // Hash das rotas no LOGICAL ID do Deployment — quando rotas mudam, o
        // logical ID muda, CloudFormation cria um NOVO Deployment (novo snapshot
        // da API), atualiza o Stage para apontar para ele e deleta o antigo.
        // Usar só a Description não funciona: o CF atualiza em-place sem criar
        // novo snapshot, então o stage continua com as rotas antigas (403).
        const routesHash = routes
          .map(r => `${r.method}:${r.path}:${r.lambdaId}`)
          .sort()
          .join('|');
        let hashVal = 0;
        for (let i = 0; i < routesHash.length; i++) hashVal = (Math.imul(31, hashVal) + routesHash.charCodeAt(i)) >>> 0;
        const deploymentId = `${logicalId}Deployment${hashVal.toString(16)}`;
        entries.push([deploymentId, {
          Type: 'AWS::ApiGateway::Deployment',
          DependsOn: methodLogicalIds,
          Properties: { RestApiId: { Ref: logicalId } },
        }]);

        entries.push([`${logicalId}Stage`, {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: { Ref: logicalId },
            DeploymentId: { Ref: deploymentId },
            StageName: stageName,
            ...(props.throttlingBurstLimit ? {
              MethodSettings: [{
                ResourcePath: '/*', HttpMethod: '*',
                ThrottlingBurstLimit: props.throttlingBurstLimit,
                ThrottlingRateLimit: props.throttlingRateLimit ?? 1000,
              }],
            } : {}),
          },
        }]);

        // Associa um Network.WAF (REGIONAL) ao stage do REST API via WAFv2
        // WebACLAssociation (o WAF não é uma prop do stage; é um recurso à parte).
        if (props.wafAclId) {
          const wafId = props.wafAclId as string;
          const wafStack = ctx.registry.get(wafId);
          const wafArn = wafStack
            ? (wafStack === ctx.currentStackName
                ? { 'Fn::GetAtt': [wafId.replace(/[^a-zA-Z0-9]/g, ''), 'Arn'] }
                : { 'Fn::ImportValue': `${wafStack}-${wafId}-Arn` })
            : wafId; // ARN literal
          entries.push([`${logicalId}WafAssociation`, {
            Type: 'AWS::WAFv2::WebACLAssociation',
            DependsOn: [`${logicalId}Stage`],
            Properties: {
              ResourceArn: { 'Fn::Sub': [`arn:aws:apigateway:\${AWS::Region}::/restapis/\${ApiId}/stages/${stageName}`, { ApiId: { Ref: logicalId } }] },
              WebACLArn: wafArn,
            },
          }]);
        }
      } else {
        // ── HTTP/WEBSOCKET (API Gateway v2) — comportamento existente. ──────
        entries.push([`${logicalId}Stage`, {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: {
            ApiId: { Ref: logicalId },
            StageName: stageName,
            AutoDeploy: true,
            ...(props.throttlingBurstLimit ? {
              DefaultRouteSettings: {
                ThrottlingBurstLimit: props.throttlingBurstLimit,
                ThrottlingRateLimit: props.throttlingRateLimit ?? 1000,
              },
            } : {}),
          },
        }]);

        // Um AWS::ApiGatewayV2::Authorizer por Lambda authorizer distinta.
        for (const [la, authLogicalId] of routeAuthorizerIds) {
          entries.push([authLogicalId, {
            Type: 'AWS::ApiGatewayV2::Authorizer',
            Properties: {
              ApiId: { Ref: logicalId },
              AuthorizerType: 'REQUEST',
              Name: `${props.name as string}-${la}`,
              AuthorizerUri: buildInvocationUri(la, ctx),
              AuthorizerPayloadFormatVersion: '2.0',
              IdentitySource: ['$request.header.Authorization'],
              EnableSimpleResponses: true,
            },
          }]);
        }

        for (const r of routes) {
          const routeId = `${logicalId}${(r.method as string)}${(r.path as string).replace(/[^a-zA-Z0-9]/g, '')}Route`;
          // Auth por rota: authType 'NONE' força pública; senão usa o authorizer
          // da rota (route.authorizerLambdaId) ou o do gateway como fallback.
          const routeAuthLambda = (r.authType === 'NONE')
            ? undefined
            : (r.authorizerLambdaId as string | undefined) ?? authorizerLambdaId;
          const routeAuthId = routeAuthLambda ? routeAuthorizerIds.get(routeAuthLambda) : undefined;
          entries.push([routeId, {
            Type: 'AWS::ApiGatewayV2::Route',
            Properties: {
              ApiId: { Ref: logicalId },
              // WEBSOCKET: a RouteKey é só o nome da rota ($connect/$disconnect/$default
              // ou a action). HTTP: '<método> <path>' (ex: 'GET /items').
              RouteKey: apigwType === 'WEBSOCKET' ? (r.path as string) : `${r.method} ${r.path}`,
              ...(r.lambdaId ? { Target: { 'Fn::Sub': `integrations/\${${routeId}Integration}` } } : {}),
              ...(routeAuthId ? { AuthorizationType: 'CUSTOM', AuthorizerId: { Ref: routeAuthId } } : {}),
            },
          }]);

          if (r.lambdaId) {
            entries.push([`${routeId}Integration`, {
              Type: 'AWS::ApiGatewayV2::Integration',
              Properties: {
                ApiId: { Ref: logicalId },
                IntegrationType: 'AWS_PROXY',
                IntegrationUri: buildInvocationUri(r.lambdaId as string, ctx),
                // WEBSOCKET exige IntegrationMethod POST e NÃO aceita
                // PayloadFormatVersion (essa prop é exclusiva do HTTP API).
                ...(apigwType === 'WEBSOCKET'
                  ? { IntegrationMethod: 'POST' }
                  : { PayloadFormatVersion: '2.0' }),
              },
            }]);
          }
        }
      }

      // Permissões de invocação — comuns aos dois tipos (Ref resolve pro ID
      // certo de cada tipo de API automaticamente).
      for (const lambdaId of lambdaIdsNeedingPermission) {
        entries.push([`${lambdaId}${logicalId}Permission`, {
          Type: 'AWS::Lambda::Permission',
          Properties: {
            Action: 'lambda:InvokeFunction',
            FunctionName: resolveLambdaArnRef(lambdaId, ctx),
            Principal: 'apigateway.amazonaws.com',
            SourceArn: { 'Fn::Sub': `arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${${logicalId}}/*/*` },
          },
        }]);
      }

      return entries;
    }

    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachType = props.attachType as string;
      const attachTo = (props.attachTo as string).replace(/[^a-zA-Z0-9]/g, '');
      const principalService = attachType === 'lambda' ? 'lambda.amazonaws.com' : 'ec2.amazonaws.com';
      const lambdaInVpc = attachType === 'lambda' && ctx.vpcLambdas.has(props.attachTo as string);
      const managedPolicies: string[] = attachType === 'lambda'
        ? [lambdaInVpc
            ? 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
            : 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
        : attachType === 'compute'
        ? ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore']
        : [];
      // Lambda acionada por SQS: garante as permissões do EventSourceMapping
      // (ReceiveMessage/DeleteMessage/GetQueueAttributes) via managed policy.
      if (attachType === 'lambda' && ctx.sqsEventSourceLambdas.has(props.attachTo as string)) {
        managedPolicies.push('arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole');
      }
      if (attachType === 'lambda' && ctx.kinesisEventSourceLambdas.has(props.attachTo as string)) {
        managedPolicies.push('arn:aws:iam::aws:policy/service-role/AWSLambdaKinesisExecutionRole');
      }

      const roleLogicalId = `${logicalId}Role`;
      const roleResource: CloudFormationResource = {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { 'Fn::Sub': `${attachTo}-role-\${AWS::StackName}` },
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: principalService }, Action: 'sts:AssumeRole' }],
          },
          ManagedPolicyArns: managedPolicies,
          Policies: [{
            PolicyName: logicalId,
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: statements.map(s => ({
                Effect: s.effect as string,
                Action: s.actions as string[],
                Resource: ((s.resources as string[]) ?? ['*']).map(r => resolvePolicyResource(r, ctx)),
                ...(s.conditions ? { Condition: s.conditions } : {}),
              })),
            },
          }],
          Tags: [{ Key: 'Name', Value: roleLogicalId }],
        },
      };

      if (attachType === 'compute') {
        return [[roleLogicalId, roleResource], [`${logicalId}InstanceProfile`, {
          Type: 'AWS::IAM::InstanceProfile',
          Properties: {
            InstanceProfileName: { 'Fn::Sub': `${attachTo}-profile-\${AWS::StackName}` },
            Roles: [{ Ref: roleLogicalId }],
          },
        }]];
      }

      return [[roleLogicalId, roleResource]];
    }

    default: return null;
  }
}
