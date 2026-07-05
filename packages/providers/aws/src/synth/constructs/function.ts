import { BaseConstruct, isRef, type Ref } from '@iacmp/core';
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
  isSamestackS3BucketRef,
  resolveEnvVarValue,
  resolveRef,
} from '../resolvers';
import { resourceRef, importRef, subRef } from '../graph';

export function synthFunction(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Function.Lambda': {
      const environment = props.environment as Record<string, string | Ref> | undefined;
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
                Object.entries(environment).flatMap(([k, v]) => {
                  // Env vars que referenciam um bucket que aciona ESTA Lambda (mesma stack)
                  // criam ciclo CloudFormation: Bucket.NotifConfig→Lambda→env→Bucket.
                  // Omitimos a var — o handler deve obter o nome do bucket diretamente de
                  // `event.Records[0].s3.bucket.name` (S3 já entrega no payload do evento).
                  const bucketId = isSamestackS3BucketRef(v, ctx);
                  if (bucketId && ctx.s3TriggerBucketsForLambda.get(construct.id)?.has(bucketId)) return [];
                  return [[k, isRef(v) ? resolveRef(v, ctx) : resolveEnvVarValue(v as string, ctx)]];
                })
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
      // Id do construct alvo de um streamId/queueId (aceita string ou Ref tipado).
      const targetId = (v: unknown): string | undefined => {
        if (isRef(v)) return v.constructId;
        if (typeof v === 'string' && !v.startsWith('arn:')) return v.replace(/\.(arn|Arn|QueueArn)$/, '');
        return undefined; // ARN literal — sem validação de tipo possível
      };
      eventSources.forEach((es, i) => {
        const esmId = `${logicalId}EventSource${i + 1}`;
        if (es.streamId) {
          // streamId é EXCLUSIVO de Messaging.Stream (Kinesis). A IA às vezes passa
          // uma fila SQS aqui — o branch Kinesis emite StartingPosition/Bisect, que a
          // AWS rejeita para SQS com 400 SÓ NO DEPLOY. Barrar no synth dá erro claro
          // que o loop de auto-correção da geração consegue consertar (usar queueId).
          const sid = targetId(es.streamId);
          const stype = sid ? ctx.registry.get(sid)?.type : undefined;
          if (sid && stype && stype !== 'Messaging.Stream') {
            throw new Error(`Function.Lambda "${construct.id}": eventSources[${i}].streamId aponta para "${sid}" (${stype}). streamId é só para Messaging.Stream (Kinesis) — para fila SQS use queueId.`);
          }
          entries.push([esmId, {
            Type: 'AWS::Lambda::EventSourceMapping',
            Properties: {
              EventSourceArn: resolveQueueArn(es.streamId as string, ctx),
              FunctionName: resourceRef(logicalId, 'Id'),
              BatchSize: (es.batchSize as number) ?? 100,
              StartingPosition: (es.startingPosition as string) ?? 'LATEST',
              ...(es.bisectBatchOnFunctionError !== undefined ? { BisectBatchOnFunctionError: es.bisectBatchOnFunctionError } : {}),
              ...(es.maxBatchingWindowSeconds !== undefined ? { MaximumBatchingWindowInSeconds: es.maxBatchingWindowSeconds } : {}),
            },
          }]);
          return;
        }
        if (!es.queueId) {
          throw new Error(`Function.Lambda "${construct.id}": eventSources[${i}] deve ter queueId ou streamId.`);
        }
        const qid = targetId(es.queueId);
        const qtype = qid ? ctx.registry.get(qid)?.type : undefined;
        if (qid && qtype && qtype !== 'Messaging.Queue') {
          throw new Error(`Function.Lambda "${construct.id}": eventSources[${i}].queueId aponta para "${qid}" (${qtype}). queueId é só para Messaging.Queue (SQS) — para Kinesis use streamId.`);
        }
        entries.push([esmId, {
          Type: 'AWS::Lambda::EventSourceMapping',
          Properties: {
            EventSourceArn: resolveQueueArn(es.queueId as string, ctx),
            FunctionName: resourceRef(logicalId, 'Id'),
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
          if (segments.length === 0) return resourceRef(logicalId, 'RootResourceId');

          let parentRef: unknown = resourceRef(logicalId, 'RootResourceId');
          let cumulative = '';
          for (const seg of segments) {
            cumulative += `/${seg}`;
            let segLogicalId = resourceIdByPath.get(cumulative);
            if (!segLogicalId) {
              segLogicalId = `${logicalId}Resource${cumulative.replace(/[^a-zA-Z0-9]/g, '')}`;
              entries.push([segLogicalId, {
                Type: 'AWS::ApiGateway::Resource',
                Properties: { RestApiId: resourceRef(logicalId, 'Id'), ParentId: parentRef, PathPart: seg },
              }]);
              resourceIdByPath.set(cumulative, segLogicalId);
            }
            parentRef = resourceRef(segLogicalId, 'Id');
          }
          return resourceRef(resourceIdByPath.get(cumulative)!, 'Id');
        };

        // Um AWS::ApiGateway::Authorizer por Lambda authorizer distinta.
        for (const [la, authLogicalId] of routeAuthorizerIds) {
          entries.push([authLogicalId, {
            Type: 'AWS::ApiGateway::Authorizer',
            Properties: {
              RestApiId: resourceRef(logicalId, 'Id'),
              Type: 'TOKEN',
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
          const resourceIdRef = resolveResourceRef(path);
          const methodLogicalId = `${logicalId}${method}${path.replace(/[^a-zA-Z0-9]/g, '')}Method`;
          // Auth por rota (mesma lógica do HTTP): 'NONE' força pública.
          const routeAuthLambda = (r.authType === 'NONE')
            ? undefined
            : (r.authorizerLambdaId as string | undefined) ?? authorizerLambdaId;
          const routeAuthId = routeAuthLambda ? routeAuthorizerIds.get(routeAuthLambda) : undefined;

          entries.push([methodLogicalId, {
            Type: 'AWS::ApiGateway::Method',
            Properties: {
              RestApiId: resourceRef(logicalId, 'Id'),
              ResourceId: resourceIdRef,
              HttpMethod: method,
              AuthorizationType: routeAuthId ? 'CUSTOM' : 'NONE',
              ...(routeAuthId ? { AuthorizerId: resourceRef(routeAuthId, 'Id') } : {}),
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
            if (!corsResourceRefs.has(corsKey)) corsResourceRefs.set(corsKey, resourceIdRef);
          }
        }

        // OPTIONS+MOCK por resource único que tenha rota com CORS habilitado.
        for (const [path, resourceIdRef] of corsResourceRefs) {
          const optionsId = `${logicalId}Options${path.replace(/[^a-zA-Z0-9]/g, '')}Method`;
          entries.push([optionsId, {
            Type: 'AWS::ApiGateway::Method',
            Properties: {
              RestApiId: resourceRef(logicalId, 'Id'),
              ResourceId: resourceIdRef,
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
          Properties: { RestApiId: resourceRef(logicalId, 'Id') },
        }]);

        entries.push([`${logicalId}Stage`, {
          Type: 'AWS::ApiGateway::Stage',
          Properties: {
            RestApiId: resourceRef(logicalId, 'Id'),
            DeploymentId: resourceRef(deploymentId, 'Id'),
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
          const wafStack = ctx.registry.get(wafId)?.stackName;
          const wafArn = wafStack
            ? (wafStack === ctx.currentStackName
                ? resourceRef(wafId.replace(/[^a-zA-Z0-9]/g, ''), 'Arn')
                : importRef(`${wafStack}-${wafId}-Arn`))
            : wafId; // ARN literal
          entries.push([`${logicalId}WafAssociation`, {
            Type: 'AWS::WAFv2::WebACLAssociation',
            DependsOn: [`${logicalId}Stage`],
            Properties: {
              ResourceArn: subRef(`arn:aws:apigateway:\${AWS::Region}::/restapis/\${ApiId}/stages/${stageName}`, { ApiId: resourceRef(logicalId, 'Id') }),
              WebACLArn: wafArn,
            },
          }]);
        }
      } else {
        // ── HTTP/WEBSOCKET (API Gateway v2) — comportamento existente. ──────
        entries.push([`${logicalId}Stage`, {
          Type: 'AWS::ApiGatewayV2::Stage',
          Properties: {
            ApiId: resourceRef(logicalId, 'Id'),
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
              ApiId: resourceRef(logicalId, 'Id'),
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
              ApiId: resourceRef(logicalId, 'Id'),
              // WEBSOCKET: a RouteKey é só o nome da rota ($connect/$disconnect/$default
              // ou a action). HTTP: '<método> <path>' (ex: 'GET /items').
              RouteKey: apigwType === 'WEBSOCKET' ? (r.path as string) : `${r.method} ${r.path}`,
              ...(r.lambdaId ? { Target: { 'Fn::Sub': `integrations/\${${routeId}Integration}` } } : {}),
              ...(routeAuthId ? { AuthorizationType: 'CUSTOM', AuthorizerId: resourceRef(routeAuthId, 'Id') } : {}),
            },
          }]);

          if (r.lambdaId) {
            entries.push([`${routeId}Integration`, {
              Type: 'AWS::ApiGatewayV2::Integration',
              Properties: {
                ApiId: resourceRef(logicalId, 'Id'),
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
      if (!props.attachTo) {
        throw new Error(`Policy.IAM "${construct.id}" requer a propriedade attachTo.`);
      }
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
                Resource: ((s.resources as Array<string | Ref>) ?? ['*']).map(r => {
                  // Quando a Lambda é acionada por um bucket (via eventNotifications) na
                  // mesma stack, referenciar o ARN desse bucket na IAM policy cria um
                  // ciclo CloudFormation: Bucket→Permission→Lambda→PolicyRole→Bucket.
                  // Substituímos por '*' para quebrar o ciclo sem perda de segurança
                  // real (a Lambda::Permission já restringe qual bucket pode invocar).
                  const bucketId = isSamestackS3BucketRef(r, ctx);
                  if (bucketId && ctx.s3TriggerBucketsForLambda.get(props.attachTo as string)?.has(bucketId)) {
                    return '*';
                  }
                  return resolvePolicyResource(r, ctx);
                }),
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
            Roles: [resourceRef(roleLogicalId, 'Id')],
          },
        }]];
      }

      return [[roleLogicalId, roleResource]];
    }

    default: return null;
  }
}
