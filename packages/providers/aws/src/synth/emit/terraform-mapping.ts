import type { CloudFormationResource } from '../types';

export interface SidecarResource {
  tfType: string;
  tfId: string;
  props: Record<string, unknown>;
}

export interface SidecarDataSource {
  dsType: string;
  dsId: string;
  props: Record<string, unknown>;
}

export interface SidecarResult {
  resources?: SidecarResource[];
  dataSources?: SidecarDataSource[];
  addArchiveProvider?: boolean;
}

export interface TFMapping {
  tfType: string;
  mapProps: (
    props: Record<string, unknown>,
    resolve: (v: unknown) => unknown,
    logicalId?: string,
    getResource?: (refId: string) => CloudFormationResource | undefined,
  ) => Record<string, unknown>;
  attrMap: Record<string, string>;
  refAttr: string;
  sidecars?: (
    logicalId: string,
    props: Record<string, unknown>,
    resolve: (v: unknown) => unknown,
  ) => SidecarResult;
}

export function toSnake(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function toTFId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

/** Recursively snake_cases all object keys (leaves values untouched). */
function deepSnakeKeys(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(deepSnakeKeys);
  if (typeof v === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      result[toSnake(k)] = deepSnakeKeys(val);
    }
    return result;
  }
  return v;
}

/**
 * Like deepSnakeKeys but pre-substitutes known compound words before snake_casing.
 * Required for WAF: TF uses "cloudwatch" (one word), but toSnake("CloudWatch") → "cloud_watch".
 */
function deepSnakeKeysWAF(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(deepSnakeKeysWAF);
  if (typeof v === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // CloudWatch is a single compound word in TF attribute names
      const normalized = k.replace('CloudWatch', 'Cloudwatch');
      result[toSnake(normalized)] = deepSnakeKeysWAF(val);
    }
    return result;
  }
  return v;
}

function generic(
  props: Record<string, unknown>,
  resolve: (v: unknown) => unknown,
  skip: Set<string> = new Set(),
  rename: Record<string, string> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'Tags' || skip.has(k)) continue;
    const key = rename[k] ?? toSnake(k);
    result[key] = resolve(v);
  }
  return result;
}

/**
 * Maps a single CFN security-group rule to TF inline rule.
 * Includes required defaults for all attributes the provider enforces.
 */
function sgRule(
  rule: Record<string, unknown>,
  resolve: (v: unknown) => unknown,
): Record<string, unknown> {
  const r: Record<string, unknown> = {
    // All required fields with defaults (aws provider v5 enforces them all)
    description: '',
    from_port: 0,
    to_port: 0,
    protocol: '-1',
    cidr_blocks: [],
    ipv6_cidr_blocks: [],
    prefix_list_ids: [],
    security_groups: [],
    self: false,
  };
  for (const [k, v] of Object.entries(rule)) {
    switch (k) {
      case 'IpProtocol': r['protocol'] = resolve(v); break;
      case 'FromPort': r['from_port'] = resolve(v); break;
      case 'ToPort': r['to_port'] = resolve(v); break;
      case 'CidrIp': r['cidr_blocks'] = [resolve(v)]; break;
      case 'CidrIpv6': r['ipv6_cidr_blocks'] = [resolve(v)]; break;
      case 'SourceSecurityGroupId': r['security_groups'] = [resolve(v)]; break;
      case 'Description': r['description'] = resolve(v); break;
      default: r[toSnake(k)] = resolve(v);
    }
  }
  return r;
}

export const TERRAFORM_MAPPING: Record<string, TFMapping> = {
  'AWS::Lambda::Function': {
    tfType: 'aws_lambda_function',
    refAttr: 'function_name',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve, logicalId) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'Code':
            if (typeof v === 'string') {
              // Local directory → archive_file data source (generated via sidecars)
              const archiveId = `${toTFId(logicalId ?? 'fn')}_archive`;
              result['filename'] = `\${data.archive_file.${archiveId}.output_path}`;
              result['source_code_hash'] = `\${data.archive_file.${archiveId}.output_base64sha256}`;
            } else if (v && typeof v === 'object') {
              const code = v as Record<string, unknown>;
              if ('ZipFile' in code) {
                result['filename'] = resolve(code['ZipFile']);
              } else if ('S3Bucket' in code) {
                result['s3_bucket'] = resolve(code['S3Bucket']);
                result['s3_key'] = resolve(code['S3Key']);
              }
            }
            break;
          case 'Environment':
            if (v && typeof v === 'object') {
              const env = v as Record<string, unknown>;
              result['environment'] = { variables: resolve(env['Variables']) };
            }
            break;
          case 'VpcConfig':
            if (v && typeof v === 'object') {
              const vpc = v as Record<string, unknown>;
              result['vpc_config'] = {
                subnet_ids: resolve(vpc['SubnetIds']),
                security_group_ids: resolve(vpc['SecurityGroupIds']),
              };
            }
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
    sidecars: (logicalId, props) => {
      if (typeof props['Code'] !== 'string') return {};
      const tfId = toTFId(logicalId);
      return {
        dataSources: [{
          dsType: 'archive_file',
          dsId: `${tfId}_archive`,
          props: {
            type: 'zip',
            source_dir: props['Code'],
            output_path: `${tfId}.zip`,
          },
        }],
        addArchiveProvider: true,
      };
    },
  },

  'AWS::IAM::Role': {
    tfType: 'aws_iam_role',
    refAttr: 'name',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'AssumeRolePolicyDocument':
            result['assume_role_policy'] = JSON.stringify(resolve(v));
            break;
          case 'ManagedPolicyArns':
            result['managed_policy_arns'] = resolve(v);
            break;
          case 'Policies':
            if (Array.isArray(v)) {
              result['inline_policy'] = (v as Array<Record<string, unknown>>).map((p) => ({
                name: resolve(p['PolicyName']),
                policy: JSON.stringify(resolve(p['PolicyDocument'])),
              }));
            }
            break;
          case 'RoleName':
            result['name'] = resolve(v);
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::IAM::Policy': {
    tfType: 'aws_iam_policy',
    refAttr: 'id',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (k === 'PolicyDocument') result['policy'] = JSON.stringify(resolve(v));
        else if (k === 'PolicyName') result['name'] = resolve(v);
        else if (k !== 'Tags') result[toSnake(k)] = resolve(v);
      }
      return result;
    },
  },

  'AWS::IAM::ManagedPolicy': {
    tfType: 'aws_iam_policy',
    refAttr: 'arn',
    attrMap: { PolicyArn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (k === 'PolicyDocument') result['policy'] = JSON.stringify(resolve(v));
        else if (k === 'ManagedPolicyName') result['name'] = resolve(v);
        else if (k !== 'Tags') result[toSnake(k)] = resolve(v);
      }
      return result;
    },
  },

  'AWS::Lambda::Permission': {
    tfType: 'aws_lambda_permission',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        FunctionName: 'function_name',
        Action: 'action',
        Principal: 'principal',
        SourceArn: 'source_arn',
        SourceAccount: 'source_account',
      }),
  },

  'AWS::Lambda::EventSourceMapping': {
    tfType: 'aws_lambda_event_source_mapping',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) => generic(props, resolve),
  },

  'AWS::S3::Bucket': {
    tfType: 'aws_s3_bucket',
    refAttr: 'bucket',
    attrMap: { Arn: 'arn', WebsiteURL: 'website_endpoint' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'BucketName': result['bucket'] = resolve(v); break;
          // These are separate resources in provider v5 — handled via sidecars
          case 'VersioningConfiguration':
          case 'PublicAccessBlockConfiguration':
          case 'NotificationConfiguration':
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
    sidecars: (logicalId, props, resolve) => {
      const tfId = toTFId(logicalId);
      const bucketRef = `\${aws_s3_bucket.${tfId}.id}`;
      const resources: SidecarResource[] = [];

      if (props['VersioningConfiguration']) {
        const vc = props['VersioningConfiguration'] as Record<string, unknown>;
        resources.push({
          tfType: 'aws_s3_bucket_versioning',
          tfId: `${tfId}_versioning`,
          props: {
            bucket: bucketRef,
            versioning_configuration: { status: vc['Status'] },
          },
        });
      }

      if (props['PublicAccessBlockConfiguration']) {
        const pabc = props['PublicAccessBlockConfiguration'] as Record<string, unknown>;
        resources.push({
          tfType: 'aws_s3_bucket_public_access_block',
          tfId: `${tfId}_public_access_block`,
          props: {
            bucket: bucketRef,
            block_public_acls: pabc['BlockPublicAcls'],
            block_public_policy: pabc['BlockPublicPolicy'],
            ignore_public_acls: pabc['IgnorePublicAcls'],
            restrict_public_buckets: pabc['RestrictPublicBuckets'],
          },
        });
      }

      if (props['NotificationConfiguration']) {
        const nc = props['NotificationConfiguration'] as Record<string, unknown>;
        if (nc['LambdaConfigurations']) {
          resources.push({
            tfType: 'aws_s3_bucket_notification',
            tfId: `${tfId}_notification`,
            props: {
              bucket: bucketRef,
              lambda_function: (nc['LambdaConfigurations'] as Array<Record<string, unknown>>).map((lc) => ({
                lambda_function_arn: resolve(lc['Function']),
                events: [lc['Event']],
              })),
            },
          });
        }
      }

      return { resources };
    },
  },

  'AWS::DynamoDB::Table': {
    tfType: 'aws_dynamodb_table',
    refAttr: 'id',
    attrMap: { Arn: 'arn', StreamArn: 'stream_arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      const attrDefs = (props['AttributeDefinitions'] as Array<Record<string, unknown>>) ?? [];
      const keySchema = (props['KeySchema'] as Array<Record<string, unknown>>) ?? [];

      let hashKey: string | undefined;
      let rangeKey: string | undefined;
      for (const key of keySchema) {
        if (key['KeyType'] === 'HASH') hashKey = key['AttributeName'] as string;
        if (key['KeyType'] === 'RANGE') rangeKey = key['AttributeName'] as string;
      }

      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'TableName': result['name'] = resolve(v); break;
          case 'AttributeDefinitions':
            result['attribute'] = attrDefs.map((a) => ({
              name: a['AttributeName'],
              type: a['AttributeType'],
            }));
            break;
          case 'KeySchema':
            if (hashKey) result['hash_key'] = hashKey;
            if (rangeKey) result['range_key'] = rangeKey;
            break;
          case 'BillingMode': result['billing_mode'] = resolve(v); break;
          case 'ProvisionedThroughput':
            if (v && typeof v === 'object') {
              const pt = v as Record<string, unknown>;
              result['read_capacity'] = pt['ReadCapacityUnits'];
              result['write_capacity'] = pt['WriteCapacityUnits'];
            }
            break;
          case 'PointInTimeRecoverySpecification':
            if (v && typeof v === 'object') {
              const pitr = v as Record<string, unknown>;
              result['point_in_time_recovery'] = { enabled: pitr['PointInTimeRecoveryEnabled'] };
            }
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::SQS::Queue': {
    tfType: 'aws_sqs_queue',
    refAttr: 'url',
    attrMap: { Arn: 'arn', QueueUrl: 'url' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'QueueName': result['name'] = resolve(v); break;
          case 'VisibilityTimeout': result['visibility_timeout_seconds'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::SNS::Topic': {
    tfType: 'aws_sns_topic',
    refAttr: 'arn',
    attrMap: { TopicArn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'TopicName': result['name'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::SNS::Subscription': {
    tfType: 'aws_sns_topic_subscription',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        TopicArn: 'topic_arn',
        Protocol: 'protocol',
        Endpoint: 'endpoint',
      }),
  },

  'AWS::RDS::DBInstance': {
    tfType: 'aws_db_instance',
    refAttr: 'id',
    attrMap: {
      'Endpoint.Address': 'address',
      'Endpoint.Port': 'port',
      Arn: 'arn',
    },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'DBInstanceIdentifier': result['identifier'] = resolve(v); break;
          case 'DBInstanceClass': result['instance_class'] = resolve(v); break;
          case 'Engine': result['engine'] = resolve(v); break;
          case 'EngineVersion': result['engine_version'] = resolve(v); break;
          case 'MasterUsername': result['username'] = resolve(v); break;
          case 'MasterUserPassword': result['password'] = resolve(v); break;
          case 'DBName': result['db_name'] = resolve(v); break;
          case 'AllocatedStorage': result['allocated_storage'] = resolve(v); break;
          case 'VPCSecurityGroups': result['vpc_security_group_ids'] = resolve(v); break;
          case 'DBSubnetGroupName': result['db_subnet_group_name'] = resolve(v); break;
          case 'MultiAZ': result['multi_az'] = resolve(v); break;
          case 'BackupRetentionPeriod': result['backup_retention_period'] = resolve(v); break;
          case 'StorageEncrypted': result['storage_encrypted'] = resolve(v); break;
          case 'StorageType': result['storage_type'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::RDS::DBSubnetGroup': {
    tfType: 'aws_db_subnet_group',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        DBSubnetGroupDescription: 'description',
        DBSubnetGroupName: 'name',
        SubnetIds: 'subnet_ids',
      }),
  },

  'AWS::ElastiCache::ReplicationGroup': {
    tfType: 'aws_elasticache_replication_group',
    refAttr: 'id',
    attrMap: {
      'PrimaryEndPoint.Address': 'primary_endpoint_address',
      'PrimaryEndPoint.Port': 'port',
    },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'ReplicationGroupDescription': result['description'] = resolve(v); break;
          case 'ReplicationGroupId': result['replication_group_id'] = resolve(v); break;
          case 'CacheNodeType': result['node_type'] = resolve(v); break;
          case 'NumCacheClusters': result['num_cache_clusters'] = resolve(v); break;
          case 'SecurityGroupIds': result['security_group_ids'] = resolve(v); break;
          case 'CacheSubnetGroupName': result['subnet_group_name'] = resolve(v); break;
          case 'AtRestEncryptionEnabled': result['at_rest_encryption_enabled'] = resolve(v); break;
          case 'TransitEncryptionEnabled': result['transit_encryption_enabled'] = resolve(v); break;
          case 'AutomaticFailoverEnabled': result['automatic_failover_enabled'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::ElastiCache::SubnetGroup': {
    tfType: 'aws_elasticache_subnet_group',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve, logicalId) => {
      const result: Record<string, unknown> = {};
      // `name` is required in TF; CFN may omit CacheSubnetGroupName (uses logicalId)
      result['name'] = props['CacheSubnetGroupName']
        ? resolve(props['CacheSubnetGroupName'])
        : toTFId(logicalId ?? 'subnet_group');
      if (props['Description']) result['description'] = resolve(props['Description']);
      if (props['SubnetIds']) result['subnet_ids'] = resolve(props['SubnetIds']);
      return result;
    },
  },

  'AWS::EC2::VPC': {
    tfType: 'aws_vpc',
    refAttr: 'id',
    attrMap: { VpcId: 'id' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        CidrBlock: 'cidr_block',
        EnableDnsHostnames: 'enable_dns_hostnames',
        EnableDnsSupport: 'enable_dns_support',
      }),
  },

  'AWS::EC2::Subnet': {
    tfType: 'aws_subnet',
    refAttr: 'id',
    attrMap: { SubnetId: 'id' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        VpcId: 'vpc_id',
        CidrBlock: 'cidr_block',
        AvailabilityZone: 'availability_zone',
        MapPublicIpOnLaunch: 'map_public_ip_on_launch',
      }),
  },

  'AWS::EC2::InternetGateway': {
    tfType: 'aws_internet_gateway',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) => generic(props, resolve),
  },

  'AWS::EC2::VPCGatewayAttachment': {
    tfType: 'aws_internet_gateway_attachment',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        VpcId: 'vpc_id',
        InternetGatewayId: 'internet_gateway_id',
      }),
  },

  'AWS::EC2::RouteTable': {
    tfType: 'aws_route_table',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), { VpcId: 'vpc_id' }),
  },

  'AWS::EC2::Route': {
    tfType: 'aws_route',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        RouteTableId: 'route_table_id',
        DestinationCidrBlock: 'destination_cidr_block',
        GatewayId: 'gateway_id',
      }),
  },

  'AWS::EC2::SubnetRouteTableAssociation': {
    tfType: 'aws_route_table_association',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        SubnetId: 'subnet_id',
        RouteTableId: 'route_table_id',
      }),
  },

  'AWS::EC2::SecurityGroup': {
    tfType: 'aws_security_group',
    refAttr: 'id',
    attrMap: { GroupId: 'id' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'GroupDescription': result['description'] = resolve(v); break;
          case 'VpcId': result['vpc_id'] = resolve(v); break;
          case 'SecurityGroupIngress':
            result['ingress'] = Array.isArray(v)
              ? (v as Array<Record<string, unknown>>).map((r) => sgRule(r, resolve))
              : resolve(v);
            break;
          case 'SecurityGroupEgress':
            result['egress'] = Array.isArray(v)
              ? (v as Array<Record<string, unknown>>).map((r) => sgRule(r, resolve))
              : resolve(v);
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::EC2::VPCEndpoint': {
    tfType: 'aws_vpc_endpoint',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        VpcId: 'vpc_id',
        ServiceName: 'service_name',
        VpcEndpointType: 'vpc_endpoint_type',
        SubnetIds: 'subnet_ids',
        SecurityGroupIds: 'security_group_ids',
        RouteTableIds: 'route_table_ids',
      }),
  },

  'AWS::ApiGatewayV2::Api': {
    tfType: 'aws_apigatewayv2_api',
    refAttr: 'id',
    attrMap: { ApiEndpoint: 'api_endpoint' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        Name: 'name',
        ProtocolType: 'protocol_type',
        RouteSelectionExpression: 'route_selection_expression',
      }),
  },

  'AWS::ApiGatewayV2::Stage': {
    tfType: 'aws_apigatewayv2_stage',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        ApiId: 'api_id',
        StageName: 'name',
        AutoDeploy: 'auto_deploy',
      }),
  },

  'AWS::ApiGatewayV2::Integration': {
    tfType: 'aws_apigatewayv2_integration',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        ApiId: 'api_id',
        IntegrationType: 'integration_type',
        IntegrationUri: 'integration_uri',
        IntegrationMethod: 'integration_method',
        PayloadFormatVersion: 'payload_format_version',
      }),
  },

  'AWS::ApiGatewayV2::Route': {
    tfType: 'aws_apigatewayv2_route',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        ApiId: 'api_id',
        RouteKey: 'route_key',
        Target: 'target',
      }),
  },

  'AWS::ECS::Cluster': {
    tfType: 'aws_ecs_cluster',
    refAttr: 'id',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), { ClusterName: 'name' }),
  },

  'AWS::ECS::TaskDefinition': {
    tfType: 'aws_ecs_task_definition',
    refAttr: 'arn',
    attrMap: { TaskDefinitionArn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'ContainerDefinitions':
            result['container_definitions'] = JSON.stringify(resolve(v));
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::ECS::Service': {
    tfType: 'aws_ecs_service',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'ServiceName': result['name'] = resolve(v); break;
          case 'Cluster': result['cluster'] = resolve(v); break;
          case 'TaskDefinition': result['task_definition'] = resolve(v); break;
          case 'DesiredCount': result['desired_count'] = resolve(v); break;
          case 'LaunchType': result['launch_type'] = resolve(v); break;
          case 'NetworkConfiguration':
            if (v && typeof v === 'object') {
              const nc = v as Record<string, unknown>;
              if (nc['AwsvpcConfiguration']) {
                const aw = nc['AwsvpcConfiguration'] as Record<string, unknown>;
                result['network_configuration'] = {
                  subnets: resolve(aw['Subnets']),
                  security_groups: resolve(aw['SecurityGroups']),
                  assign_public_ip: aw['AssignPublicIp'] === 'ENABLED' ? true : false,
                };
              }
            }
            break;
          case 'LoadBalancers':
            if (Array.isArray(v)) {
              result['load_balancer'] = (v as Array<Record<string, unknown>>).map((lb) => ({
                target_group_arn: resolve(lb['TargetGroupArn']),
                container_name: lb['ContainerName'],
                container_port: lb['ContainerPort'],
              }));
            }
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::Logs::LogGroup': {
    tfType: 'aws_cloudwatch_log_group',
    refAttr: 'name',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        LogGroupName: 'name',
        RetentionInDays: 'retention_in_days',
      }),
  },

  'AWS::StepFunctions::StateMachine': {
    tfType: 'aws_sfn_state_machine',
    refAttr: 'id',
    attrMap: { Arn: 'arn', Name: 'name' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'StateMachineName': result['name'] = resolve(v); break;
          case 'DefinitionString': result['definition'] = resolve(v); break;
          case 'RoleArn': result['role_arn'] = resolve(v); break;
          case 'StateMachineType': result['type'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::Kinesis::Stream': {
    tfType: 'aws_kinesis_stream',
    refAttr: 'name',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        Name: 'name',
        ShardCount: 'shard_count',
        RetentionPeriodHours: 'retention_period',
      }),
  },

  'AWS::WAFv2::WebACL': {
    tfType: 'aws_wafv2_web_acl',
    refAttr: 'id',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'Name': result['name'] = resolve(v); break;
          case 'Scope': result['scope'] = resolve(v); break;
          // Deep snake_case: CFN uses PascalCase, TF requires snake_case at all levels.
          // Uses WAF variant to keep "cloudwatch" as one word (not "cloud_watch").
          case 'DefaultAction': result['default_action'] = deepSnakeKeysWAF(resolve(v)); break;
          case 'Rules': result['rule'] = deepSnakeKeysWAF(resolve(v)); break;
          case 'VisibilityConfig': result['visibility_config'] = deepSnakeKeysWAF(resolve(v)); break;
          case 'Description': result['description'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::WAFv2::WebACLAssociation': {
    tfType: 'aws_wafv2_web_acl_association',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        ResourceArn: 'resource_arn',
        WebACLArn: 'web_acl_arn',
      }),
  },

  // REST API Gateway
  'AWS::ApiGateway::RestApi': {
    tfType: 'aws_api_gateway_rest_api',
    refAttr: 'id',
    attrMap: { RootResourceId: 'root_resource_id' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), { Name: 'name', Description: 'description' }),
  },

  'AWS::ApiGateway::Resource': {
    tfType: 'aws_api_gateway_resource',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        RestApiId: 'rest_api_id',
        ParentId: 'parent_id',
        PathPart: 'path_part',
      }),
  },

  'AWS::ApiGateway::Method': {
    tfType: 'aws_api_gateway_method',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'RestApiId': result['rest_api_id'] = resolve(v); break;
          case 'ResourceId': result['resource_id'] = resolve(v); break;
          case 'HttpMethod': result['http_method'] = resolve(v); break;
          case 'AuthorizationType': result['authorization'] = resolve(v); break;
          case 'Integration': break; // emitted as separate aws_api_gateway_integration via sidecars
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
    sidecars: (logicalId, props, resolve) => {
      if (!props['Integration']) return {};
      const intg = props['Integration'] as Record<string, unknown>;
      const tfId = toTFId(logicalId);
      return {
        resources: [{
          tfType: 'aws_api_gateway_integration',
          tfId: `${tfId}_integration`,
          props: {
            rest_api_id: resolve(props['RestApiId']),
            resource_id: resolve(props['ResourceId']),
            http_method: resolve(props['HttpMethod']),
            type: intg['Type'],
            integration_http_method: intg['IntegrationHttpMethod'],
            uri: resolve(intg['Uri']),
          },
        }],
      };
    },
  },

  'AWS::ApiGateway::Deployment': {
    tfType: 'aws_api_gateway_deployment',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), { RestApiId: 'rest_api_id' }),
  },

  'AWS::ApiGateway::Stage': {
    tfType: 'aws_api_gateway_stage',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        RestApiId: 'rest_api_id',
        DeploymentId: 'deployment_id',
        StageName: 'stage_name',
      }),
  },

  'AWS::ApplicationAutoScaling::ScalableTarget': {
    tfType: 'aws_appautoscaling_target',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        MinCapacity: 'min_capacity',
        MaxCapacity: 'max_capacity',
        ResourceId: 'resource_id',
        ScalableDimension: 'scalable_dimension',
        ServiceNamespace: 'service_namespace',
      }),
  },

  'AWS::ApplicationAutoScaling::ScalingPolicy': {
    tfType: 'aws_appautoscaling_policy',
    refAttr: 'arn',
    attrMap: {},
    mapProps: (props, resolve, _logicalId, getResource) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'PolicyName': result['name'] = resolve(v); break;
          case 'PolicyType': result['policy_type'] = resolve(v); break;
          case 'ScalingTargetId': {
            // CFN links via ScalingTargetId ref; TF needs scalable_dimension + service_namespace
            // pulled from the referenced ScalableTarget
            const ref = typeof v === 'object' && v !== null && 'Ref' in (v as Record<string, unknown>)
              ? (v as Record<string, unknown>)['Ref'] as string
              : null;
            const target = ref ? getResource?.(ref) : undefined;
            if (target) {
              result['resource_id'] = target.Properties['ResourceId'];
              result['scalable_dimension'] = target.Properties['ScalableDimension'];
              result['service_namespace'] = target.Properties['ServiceNamespace'];
            }
            break;
          }
          // TargetTrackingScalingPolicyConfiguration sub-keys are PascalCase → deep snake_case
          case 'TargetTrackingScalingPolicyConfiguration':
            result['target_tracking_scaling_policy_configuration'] = deepSnakeKeys(resolve(v));
            break;
          case 'StepScalingPolicyConfiguration':
            result['step_scaling_policy_configuration'] = deepSnakeKeys(resolve(v));
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::CloudWatch::Alarm': {
    tfType: 'aws_cloudwatch_metric_alarm',
    refAttr: 'id',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'AlarmName': result['alarm_name'] = resolve(v); break;
          case 'MetricName': result['metric_name'] = resolve(v); break;
          case 'Namespace': result['namespace'] = resolve(v); break;
          case 'Threshold': result['threshold'] = resolve(v); break;
          case 'EvaluationPeriods': result['evaluation_periods'] = resolve(v); break;
          case 'Period': result['period'] = resolve(v); break;
          case 'ComparisonOperator': result['comparison_operator'] = resolve(v); break;
          case 'Statistic': result['statistic'] = resolve(v); break;
          case 'TreatMissingData': result['treat_missing_data'] = resolve(v); break;
          case 'AlarmActions': result['alarm_actions'] = resolve(v); break;
          // CFN: [{Name:"k", Value:"v"}] → TF: {"k":"v"}
          case 'Dimensions':
            if (Array.isArray(v)) {
              const map: Record<string, unknown> = {};
              for (const d of v as Array<Record<string, unknown>>) {
                map[d['Name'] as string] = resolve(d['Value']);
              }
              result['dimensions'] = map;
            } else {
              result['dimensions'] = resolve(v);
            }
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    tfType: 'aws_lb',
    refAttr: 'id',
    attrMap: { Arn: 'arn', DNSName: 'dns_name' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'Name': result['name'] = resolve(v); break;
          case 'Type': result['load_balancer_type'] = resolve(v); break;
          // CFN Scheme is a string; TF `internal` is a bool
          case 'Scheme': result['internal'] = v === 'internal'; break;
          case 'Subnets': result['subnets'] = resolve(v); break;
          case 'SecurityGroups': result['security_groups'] = resolve(v); break;
          // LoadBalancerAttributes is a [{Key, Value}] list — no direct TF equivalent; skip
          case 'LoadBalancerAttributes': break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::ElasticLoadBalancingV2::Listener': {
    tfType: 'aws_lb_listener',
    refAttr: 'arn',
    attrMap: { ListenerArn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'LoadBalancerArn': result['load_balancer_arn'] = resolve(v); break;
          case 'Port': result['port'] = resolve(v); break;
          case 'Protocol': result['protocol'] = resolve(v); break;
          case 'DefaultActions':
            if (Array.isArray(v)) {
              result['default_action'] = (v as Array<Record<string, unknown>>).map((a) => ({
                type: a['Type'],
                target_group_arn: a['TargetGroupArn'] ? resolve(a['TargetGroupArn']) : undefined,
              }));
            }
            break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    tfType: 'aws_lb_target_group',
    refAttr: 'id',
    attrMap: { TargetGroupArn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      const healthCheck: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'Name': result['name'] = resolve(v); break;
          case 'Port': result['port'] = resolve(v); break;
          case 'Protocol': result['protocol'] = resolve(v); break;
          case 'VpcId': result['vpc_id'] = resolve(v); break;
          case 'TargetType': result['target_type'] = resolve(v); break;
          // Health check properties go into a nested block
          case 'HealthCheckPath': healthCheck['path'] = resolve(v); break;
          case 'HealthCheckPort': healthCheck['port'] = resolve(v); break;
          case 'HealthCheckProtocol': healthCheck['protocol'] = resolve(v); break;
          case 'HealthCheckIntervalSeconds': healthCheck['interval'] = resolve(v); break;
          case 'HealthCheckTimeoutSeconds': healthCheck['timeout'] = resolve(v); break;
          case 'HealthyThresholdCount': healthCheck['healthy_threshold'] = resolve(v); break;
          case 'UnhealthyThresholdCount': healthCheck['unhealthy_threshold'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      if (Object.keys(healthCheck).length > 0) {
        result['health_check'] = healthCheck;
      }
      return result;
    },
  },

  'AWS::SecretsManager::Secret': {
    tfType: 'aws_secretsmanager_secret',
    refAttr: 'arn',
    attrMap: { Id: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'Name': result['name'] = resolve(v); break;
          case 'Description': result['description'] = resolve(v); break;
          case 'SecretString': result['secret_string'] = resolve(v); break;
          // GenerateSecretString is CFN-only; TF uses random_password + aws_secretsmanager_secret_version
          case 'GenerateSecretString': break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::CloudFront::Distribution': {
    tfType: 'aws_cloudfront_distribution',
    refAttr: 'id',
    attrMap: { Arn: 'arn', DomainName: 'domain_name' },
    mapProps: (props, resolve) => {
      const config = (props['DistributionConfig'] as Record<string, unknown>) ?? {};
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(config)) {
        switch (k) {
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::CloudFront::OriginAccessControl': {
    tfType: 'aws_cloudfront_origin_access_control',
    refAttr: 'id',
    attrMap: { Id: 'id' },
    mapProps: (props, resolve) => {
      const config = (props['OriginAccessControlConfig'] as Record<string, unknown>) ?? props;
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(config)) {
        result[toSnake(k)] = resolve(v);
      }
      return result;
    },
  },

  'AWS::Events::EventBus': {
    tfType: 'aws_cloudwatch_event_bus',
    refAttr: 'id',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'Name': result['name'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::Events::Rule': {
    tfType: 'aws_cloudwatch_event_rule',
    refAttr: 'id',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'Name': result['name'] = resolve(v); break;
          case 'EventBusName': result['event_bus_name'] = resolve(v); break;
          case 'ScheduleExpression': result['schedule_expression'] = resolve(v); break;
          case 'EventPattern': result['event_pattern'] = typeof v === 'object' ? JSON.stringify(resolve(v)) : resolve(v); break;
          case 'State': result['is_enabled'] = v === 'ENABLED'; break;
          case 'Targets': break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::DocDB::DBCluster': {
    tfType: 'aws_docdb_cluster',
    refAttr: 'id',
    attrMap: { Endpoint: 'endpoint', Port: 'port' },
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'DBClusterIdentifier': result['cluster_identifier'] = resolve(v); break;
          case 'MasterUsername': result['master_username'] = resolve(v); break;
          case 'MasterUserPassword': result['master_password'] = resolve(v); break;
          case 'DBSubnetGroupName': result['db_subnet_group_name'] = resolve(v); break;
          case 'VpcSecurityGroupIds': result['vpc_security_group_ids'] = resolve(v); break;
          case 'StorageEncrypted': result['storage_encrypted'] = resolve(v); break;
          case 'BackupRetentionPeriod': result['backup_retention_period'] = resolve(v); break;
          case 'DeletionProtection': result['deletion_protection'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::DocDB::DBInstance': {
    tfType: 'aws_docdb_cluster_instance',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'DBClusterIdentifier': result['cluster_id'] = resolve(v); break;
          case 'DBInstanceClass': result['instance_class'] = resolve(v); break;
          case 'DBInstanceIdentifier': result['identifier'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },

  'AWS::DocDB::DBSubnetGroup': {
    tfType: 'aws_docdb_subnet_group',
    refAttr: 'id',
    attrMap: {},
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'DBSubnetGroupDescription': result['description'] = resolve(v); break;
          case 'SubnetIds': result['subnet_ids'] = resolve(v); break;
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
    },
  },
};

export function getTFMapping(awsType: string): TFMapping | undefined {
  return TERRAFORM_MAPPING[awsType];
}

export function getOrFallbackTFMapping(awsType: string): TFMapping {
  const mapping = TERRAFORM_MAPPING[awsType];
  if (mapping) return mapping;
  // Generic fallback for unknown types
  const parts = awsType.split('::');
  const tfType = parts
    .slice(1)
    .map((p) => toSnake(p))
    .join('_');
  return {
    tfType: `aws_${tfType}`,
    refAttr: 'id',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) => generic(props, resolve),
  };
}

// Re-export CloudFormationResource to avoid circular imports in tests
export type { CloudFormationResource };
