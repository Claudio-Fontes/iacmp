import { BaseConstruct } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import {
  resolveVpcId,
  resolveSubnetId,
  resolveSecurityGroupId,
  resolveTargetGroupArn,
} from '../resolvers';
import { resourceRef } from '../graph';

function synthesizeVPCChildren(
  logicalId: string,
  cidr: string,
  maxAzs: number,
  resources: Record<string, CloudFormationResource>,
  outputs: Record<string, { Value: unknown; Export: { Name: string } }>,
  stackName: string,
  constructId: string,
): void {
  if (!maxAzs || maxAzs <= 0) return;

  const azLetters = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, maxAzs);
  const cidrBase = cidr.split('.').slice(0, 2).join('.');

  const igwId = `${logicalId}IGW`;
  resources[igwId] = { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: [{ Key: 'Name', Value: igwId }] } };
  resources[`${igwId}Attachment`] = {
    Type: 'AWS::EC2::VPCGatewayAttachment',
    Properties: { VpcId: resourceRef(logicalId, 'Id'), InternetGatewayId: resourceRef(igwId, 'Id') },
  };

  const pubRTId = `${logicalId}PublicRT`;
  resources[pubRTId] = { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: resourceRef(logicalId, 'Id'), Tags: [{ Key: 'Name', Value: pubRTId }] } };
  resources[`${pubRTId}DefaultRoute`] = {
    Type: 'AWS::EC2::Route',
    Properties: { RouteTableId: resourceRef(pubRTId, 'Id'), DestinationCidrBlock: '0.0.0.0/0', GatewayId: resourceRef(igwId, 'Id') },
  };

  azLetters.forEach((az, i) => {
    const pubSubnetId = `${logicalId}PublicSubnet${az.toUpperCase()}`;
    const privSubnetId = `${logicalId}PrivateSubnet${az.toUpperCase()}`;
    resources[pubSubnetId] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: resourceRef(logicalId, 'Id'),
        CidrBlock: `${cidrBase}.${i * 2}.0/24`,
        AvailabilityZone: { 'Fn::Select': [i, { 'Fn::GetAZs': '' }] },
        MapPublicIpOnLaunch: true,
        Tags: [{ Key: 'Name', Value: pubSubnetId }],
      },
    };
    resources[`${pubSubnetId}RTAssoc`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: { SubnetId: resourceRef(pubSubnetId, 'Id'), RouteTableId: resourceRef(pubRTId, 'Id') },
    };
    resources[privSubnetId] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: resourceRef(logicalId, 'Id'),
        CidrBlock: `${cidrBase}.${i * 2 + 1}.0/24`,
        AvailabilityZone: { 'Fn::Select': [i, { 'Fn::GetAZs': '' }] },
        Tags: [{ Key: 'Name', Value: privSubnetId }],
      },
    };
    // Exporta os IDs reais das subnets auto-geradas (maxAzs) — sem isso nada
    // fora da própria stack (ex: harness de teste lendo via describe-stacks)
    // consegue saber o ID real pra usar em outro construct (EKS, RDS, EC2...).
    outputs[`${pubSubnetId}SubnetId`] = {
      Value: resourceRef(pubSubnetId, 'Id'),
      Export: { Name: `${stackName}-${constructId}-Public${az.toUpperCase()}-SubnetId` },
    };
    outputs[`${privSubnetId}SubnetId`] = {
      Value: resourceRef(privSubnetId, 'Id'),
      Export: { Name: `${stackName}-${constructId}-Private${az.toUpperCase()}-SubnetId` },
    };
  });
}

export { synthesizeVPCChildren };

export function synthNetwork(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Network.VPC': {
      const vpcEntries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::EC2::VPC',
        Properties: {
          CidrBlock: (props.cidr as string) ?? '10.0.0.0/16',
          EnableDnsHostnames: true,
          EnableDnsSupport: true,
          Tags: [{ Key: 'Name', Value: logicalId }],
        },
      }]];

      // Subnets públicas explícitas (Network.Subnet public:true) na MESMA stack
      // precisam de Internet Gateway + route table pública com rota 0.0.0.0/0,
      // senão não têm saída pra internet (ALB internet-facing falha com "VPC has
      // no internet gateway" e tasks/instâncias com IP público não alcançam nada).
      const publicSubnets = (ctx.publicSubnetsByVpc.get(construct.id) ?? [])
        .filter(s => s.stackName === ctx.currentStackName);
      if (publicSubnets.length > 0) {
        const igwId = `${logicalId}IGW`;
        vpcEntries.push([igwId, { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: [{ Key: 'Name', Value: igwId }] } }]);
        vpcEntries.push([`${igwId}Attachment`, {
          Type: 'AWS::EC2::VPCGatewayAttachment',
          Properties: { VpcId: resourceRef(logicalId, 'Id'), InternetGatewayId: resourceRef(igwId, 'Id') },
        }]);
        const pubRTId = `${logicalId}PublicRT`;
        vpcEntries.push([pubRTId, { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: resourceRef(logicalId, 'Id'), Tags: [{ Key: 'Name', Value: pubRTId }] } }]);
        vpcEntries.push([`${pubRTId}DefaultRoute`, {
          Type: 'AWS::EC2::Route',
          DependsOn: [`${igwId}Attachment`],
          Properties: { RouteTableId: resourceRef(pubRTId, 'Id'), DestinationCidrBlock: '0.0.0.0/0', GatewayId: resourceRef(igwId, 'Id') },
        }]);
        publicSubnets.forEach((s, i) => {
          vpcEntries.push([`${logicalId}PublicRTAssoc${i}`, {
            Type: 'AWS::EC2::SubnetRouteTableAssociation',
            Properties: { SubnetId: resourceRef(s.id.replace(/[^a-zA-Z0-9]/g, ''), 'Id'), RouteTableId: resourceRef(pubRTId, 'Id') },
          }]);
        });
      }
      return vpcEntries;
    }

    case 'Network.Subnet': {
      const isPublic = (props.public as boolean) ?? false;
      return [[logicalId, {
        Type: 'AWS::EC2::Subnet',
        Properties: {
          VpcId: props.vpcId ? resolveVpcId(props.vpcId as string, ctx) : undefined,
          CidrBlock: props.cidr as string,
          ...(props.availabilityZone ? { AvailabilityZone: props.availabilityZone as string } : {}),
          MapPublicIpOnLaunch: isPublic,
          Tags: [{ Key: 'Name', Value: logicalId }, { Key: 'Type', Value: isPublic ? 'public' : 'private' }],
        },
      }]];
    }

    case 'Network.VpcEndpoint': {
      // Gateway VPC Endpoint (DynamoDB/S3): dá a uma Lambda em subnet privada
      // acesso ao serviço SEM NAT (grátis). Cria uma route table, associa as
      // subnets privadas a ela e pendura um endpoint Gateway por serviço.
      const services = (props.services as string[]) ?? [];
      const subnetIds = (props.subnetIds as string[]) ?? [];
      const entries: Array<[string, CloudFormationResource]> = [];
      const rtId = `${logicalId}RouteTable`;
      entries.push([rtId, {
        Type: 'AWS::EC2::RouteTable',
        Properties: {
          VpcId: resolveVpcId(props.vpcId as string, ctx),
          Tags: [{ Key: 'Name', Value: rtId }],
        },
      }]);
      subnetIds.forEach((sid, i) => {
        entries.push([`${logicalId}RTAssoc${i}`, {
          Type: 'AWS::EC2::SubnetRouteTableAssociation',
          Properties: {
            SubnetId: resolveSubnetId(sid, ctx),
            RouteTableId: resourceRef(rtId, 'Id'),
          },
        }]);
      });
      for (const svc of services) {
        const epId = `${logicalId}${svc.charAt(0).toUpperCase()}${svc.slice(1)}Endpoint`;
        entries.push([epId, {
          Type: 'AWS::EC2::VPCEndpoint',
          Properties: {
            ServiceName: { 'Fn::Sub': `com.amazonaws.\${AWS::Region}.${svc}` },
            VpcId: resolveVpcId(props.vpcId as string, ctx),
            VpcEndpointType: 'Gateway',
            RouteTableIds: [resourceRef(rtId, 'Id')],
          },
        }]);
      }
      return entries;
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];
      return [[logicalId, {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: (props.description as string) ?? `Security group ${logicalId}`,
          VpcId: props.vpcId ? resolveVpcId(props.vpcId as string, ctx) : undefined,
          SecurityGroupIngress: ingress.map((r, i) => {
            const base = {
              IpProtocol: r.protocol as string,
              FromPort: r.fromPort as number,
              ToPort: r.toPort as number,
              ...(r.description ? { Description: r.description } : {}),
            };
            // Fonte = outro SG (padrão correto p/ "acesso só do SG X") tem
            // precedência sobre CIDR — CloudFormation exige um OU outro.
            if (r.sourceSecurityGroupId) {
              return { ...base, SourceSecurityGroupId: resolveSecurityGroupId(r.sourceSecurityGroupId as string, ctx) };
            }
            if (r.cidr === undefined) {
              console.warn(`[aws] Security group rule sem CIDR nem sourceSecurityGroupId; usando 0.0.0.0/0 (${construct.id} ingress[${i}])`);
            }
            return { ...base, CidrIp: (r.cidr as string) ?? '0.0.0.0/0' };
          }),
          SecurityGroupEgress: egress.length > 0
            ? egress.map(r => {
                const base = {
                  IpProtocol: r.protocol as string,
                  FromPort: r.fromPort as number,
                  ToPort: r.toPort as number,
                  ...(r.description ? { Description: r.description } : {}),
                };
                if (r.destinationSecurityGroupId) {
                  return { ...base, DestinationSecurityGroupId: resolveSecurityGroupId(r.destinationSecurityGroupId as string, ctx) };
                }
                return { ...base, CidrIp: (r.cidr as string) ?? '0.0.0.0/0' };
              })
            : [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'Allow all egress' }],
          Tags: [{ Key: 'Name', Value: logicalId }],
        },
      }]];
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const defaultAction = (props.defaultAction as string) ?? 'allow';
      return [[logicalId, {
        Type: 'AWS::WAFv2::WebACL',
        Properties: {
          Name: logicalId,
          Scope: (props.scope as string) ?? 'REGIONAL',
          DefaultAction: { [defaultAction === 'block' ? 'Block' : 'Allow']: {} },
          Description: (props.description as string) ?? `WAF ${logicalId}`,
          Rules: rules.map((r, i) => {
            const actionKey = (r.action as string) === 'block' ? 'Block' : (r.action as string) === 'count' ? 'Count' : 'Allow';
            // Managed rule group → OverrideAction (NÃO Action; o WAFv2 rejeita Action
            // num ManagedRuleGroupStatement). Rate-based/ByteMatch → Action normal.
            const statement = r.managedGroup
              ? { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: r.managedGroup as string } }
              : r.rateLimit
                ? { RateBasedStatement: { Limit: r.rateLimit as number, AggregateKeyType: 'IP' } }
                : {
                    ByteMatchStatement: {
                      SearchString: ((r.matchValues as string[]) ?? ['BadBot'])[0],
                      FieldToMatch: { SingleHeader: { Name: 'user-agent' } },
                      TextTransformations: [{ Priority: 0, Type: 'NONE' }],
                      PositionalConstraint: 'CONTAINS',
                    },
                  };
            return {
              Name: (r.name as string) ?? `rule-${i}`,
              Priority: (r.priority as number) ?? (i + 1),
              ...(r.managedGroup
                // Managed group usa OverrideAction: 'count' = monitorar sem bloquear
                // (respeita o modo teste), senão None (deixa a ação nativa do grupo valer).
                ? { OverrideAction: (r.action as string) === 'count' ? { Count: {} } : { None: {} } }
                : { Action: { [r.rateLimit ? (actionKey === 'Allow' ? 'Block' : actionKey) : actionKey]: {} } }),
              VisibilityConfig: {
                SampledRequestsEnabled: true,
                CloudWatchMetricsEnabled: true,
                MetricName: ((r.name as string) ?? `rule${i}`).replace(/[^a-zA-Z0-9]/g, ''),
              },
              Statement: statement,
            };
          }),
          VisibilityConfig: {
            SampledRequestsEnabled: true,
            CloudWatchMetricsEnabled: true,
            MetricName: logicalId,
          },
        },
      }]];
    }

    case 'Network.LoadBalancer': {
      const lbType = (props.type as string) ?? 'application';
      const listeners = (props.listeners as Array<Record<string, unknown>>) ?? [];
      const targetGroups = (props.targetGroups as Array<Record<string, unknown>>) ?? [];

      const entries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        Properties: {
          Name: construct.id,
          Type: lbType,
          Scheme: (props.scheme as string) ?? 'internet-facing',
          Subnets: ((props.subnetIds as string[]) ?? []).map(id => resolveSubnetId(id, ctx)),
          ...(lbType === 'application' && props.securityGroupIds
            ? { SecurityGroups: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) }
            : {}),
          LoadBalancerAttributes: [
            { Key: 'deletion_protection.enabled', Value: String(props.deletionProtection ?? false) },
          ],
        },
      }]];

      // O 1º target group é o "default": listeners não-redirect fazem forward
      // pra ele e o ECS Service registra as tasks nele (ver resolveTargetGroupArn).
      let defaultTgId: string | undefined;
      for (const tg of targetGroups) {
        const tgId = `${logicalId}TG${(tg.name as string).replace(/[^a-zA-Z0-9]/g, '')}`;
        if (!defaultTgId) defaultTgId = tgId;
        entries.push([tgId, {
          Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          Properties: {
            Name: tg.name as string,
            Port: tg.port as number,
            Protocol: tg.protocol as string,
            VpcId: props.vpcId ? resolveVpcId(props.vpcId as string, ctx) : undefined,
            HealthCheckPath: (tg.healthCheckPath as string) ?? '/',
            HealthCheckPort: String(tg.healthCheckPort ?? tg.port),
            TargetType: 'ip',
          },
        }]);
      }

      let listenerIdx = 0;
      for (const l of listeners) {
        // HTTPS/TLS sem certificado não sobe (CFN exige Certificates) — pula com aviso
        // em vez de derrubar o deploy inteiro. Use certificateArn (ACM) para HTTPS.
        if ((l.protocol === 'HTTPS' || l.protocol === 'TLS') && !l.certificateArn) {
          console.warn(`[aws] LoadBalancer "${construct.id}": listener ${l.protocol}:${l.port} sem certificateArn — ignorado (HTTPS exige um certificado ACM).`);
          continue;
        }
        listenerIdx++;
        // forward → target group default quando existe; senão redirect ou 404.
        const defaultActions = (l.redirectToHttps as boolean)
          ? [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }]
          : defaultTgId
            ? [{ Type: 'forward', TargetGroupArn: resourceRef(defaultTgId, 'Id') }]
            : [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404', MessageBody: 'Not found', ContentType: 'text/plain' } }];
        entries.push([`${logicalId}Listener${listenerIdx}`, {
          Type: 'AWS::ElasticLoadBalancingV2::Listener',
          Properties: {
            LoadBalancerArn: resourceRef(logicalId, 'Id'),
            Port: l.port as number,
            Protocol: l.protocol as string,
            ...(l.certificateArn ? { Certificates: [{ CertificateArn: l.certificateArn }] } : {}),
            DefaultActions: defaultActions,
          },
        }]);
      }

      return entries;
    }

    case 'Network.CDN': {
      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      const cachePolicies = (props.cachePolicies as Array<Record<string, unknown>>) ?? [];

      const entries: Array<[string, CloudFormationResource]> = [];

      // Detecta origins S3 (com bucketRef) para usar OAC em vez de CustomOriginConfig
      const oacRefs: string[] = [];
      for (const o of origins) {
        if (!o.bucketRef) continue;
        const bucketRef = o.bucketRef as string;
        const oacId = `${logicalId}OAC${bucketRef}`;
        if (!oacRefs.includes(oacId)) {
          oacRefs.push(oacId);
          entries.push([oacId, {
            Type: 'AWS::CloudFront::OriginAccessControl',
            Properties: {
              OriginAccessControlConfig: {
                Name: { 'Fn::Sub': `${logicalId}-oac-\${AWS::StackName}` },
                OriginAccessControlOriginType: 's3',
                SigningBehavior: 'always',
                SigningProtocol: 'sigv4',
              },
            },
          }]);
          // BucketPolicy permitindo acesso do CloudFront via OAC
          entries.push([`${bucketRef}PolicyCDN${logicalId}`, {
            Type: 'AWS::S3::BucketPolicy',
            Properties: {
              Bucket: resourceRef(bucketRef, 'Id'),
              PolicyDocument: {
                Statement: [{
                  Effect: 'Allow',
                  Principal: { Service: 'cloudfront.amazonaws.com' },
                  Action: 's3:GetObject',
                  Resource: { 'Fn::Sub': `arn:aws:s3:::$\{${bucketRef}}/*` },
                  Condition: {
                    StringEquals: {
                      'AWS:SourceArn': { 'Fn::Sub': `arn:aws:cloudfront::$\{AWS::AccountId}:distribution/$\{${logicalId}}` },
                    },
                  },
                }],
              },
            },
          }]);
        }
      }

      entries.push([logicalId, {
        Type: 'AWS::CloudFront::Distribution',
        Properties: {
          DistributionConfig: {
            Enabled: true,
            HttpVersion: (props.httpVersion as string) ?? 'http2',
            PriceClass: (props.priceClass as string) ?? 'PriceClass_100',
            DefaultRootObject: (props.defaultRootObject as string) ?? 'index.html',
            ...(props.aliases ? { Aliases: props.aliases } : {}),
            ...(props.certificateArn
              ? { ViewerCertificate: { AcmCertificateArn: props.certificateArn, SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' } }
              : { ViewerCertificate: { CloudFrontDefaultCertificate: true } }),
            ...(props.wafAclId ? { WebACLId: props.wafAclId } : {}),
            Origins: origins.map(o => {
              const protocol = (o.protocol as string) ?? 'https-only';
              if (o.bucketRef) {
                const bucketRef = o.bucketRef as string;
                return {
                  Id: o.id as string,
                  DomainName: resourceRef(bucketRef, 'RegionalDomainName'),
                  OriginPath: (o.path as string) ?? '',
                  S3OriginConfig: { OriginAccessIdentity: '' },
                  OriginAccessControlId: resourceRef(`${logicalId}OAC${bucketRef}`, 'Id'),
                };
              }
              return {
                Id: o.id as string,
                DomainName: o.domainName as string,
                OriginPath: (o.path as string) ?? '',
                CustomOriginConfig: {
                  HTTPPort: 80,
                  HTTPSPort: 443,
                  OriginProtocolPolicy: protocol,
                },
              };
            }),
            DefaultCacheBehavior: {
              TargetOriginId: origins[0].id as string,
              ViewerProtocolPolicy: 'redirect-to-https',
              AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
              CachedMethods: ['GET', 'HEAD'],
              Compress: true,
              ForwardedValues: { QueryString: false, Cookies: { Forward: 'none' } },
            },
            CacheBehaviors: cachePolicies.map(cp => ({
              PathPattern: cp.pathPattern as string,
              TargetOriginId: origins[0].id as string,
              ViewerProtocolPolicy: 'redirect-to-https',
              DefaultTTL: cp.ttlSeconds ?? 86400,
              MaxTTL: (cp.ttlSeconds as number ?? 86400) * 2,
              Compress: (cp.compress as boolean) ?? true,
              ForwardedValues: { QueryString: true, Cookies: { Forward: 'all' } },
              AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
              CachedMethods: ['GET', 'HEAD'],
            })),
          },
        },
      }]);

      return entries;
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const hostedZoneId = `${logicalId}Zone`;

      const entries: Array<[string, CloudFormationResource]> = [[hostedZoneId, {
        Type: 'AWS::Route53::HostedZone',
        Properties: {
          Name: props.zoneName as string,
          HostedZoneConfig: { Comment: `Zone for ${props.zoneName}` },
        },
      }]];

      for (const r of records) {
        const recId = `${logicalId}${(r.name as string).replace(/[^a-zA-Z0-9]/g, '')}${r.type}`;
        entries.push([recId, {
          Type: 'AWS::Route53::RecordSet',
          Properties: {
            HostedZoneId: resourceRef(hostedZoneId, 'Id'),
            Name: r.name as string,
            Type: r.type as string,
            TTL: String(r.ttl ?? 300),
            ...(r.aliasTarget
              ? { AliasTarget: { DNSName: r.aliasTarget, HostedZoneId: 'Z35SXDOTRQ7X7K' } }
              : { ResourceRecords: r.values as string[] }),
          },
        }]);
      }

      return entries;
    }

    default: return null;
  }
}
