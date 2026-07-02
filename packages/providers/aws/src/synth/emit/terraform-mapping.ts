import type { CloudFormationResource } from '../types';

export interface TFMapping {
  tfType: string;
  mapProps: (
    props: Record<string, unknown>,
    resolve: (v: unknown) => unknown,
  ) => Record<string, unknown>;
  attrMap: Record<string, string>;
  refAttr: string;
}

export function toSnake(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
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

function sgRule(
  rule: Record<string, unknown>,
  resolve: (v: unknown) => unknown,
): Record<string, unknown> {
  const r: Record<string, unknown> = {};
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
    mapProps: (props, resolve) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        switch (k) {
          case 'Code':
            if (typeof v === 'string') {
              result['filename'] = v;
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
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
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
    attrMap: { 'PrimaryEndPoint.Address': 'primary_endpoint_address' },
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
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        CacheSubnetGroupName: 'name',
        Description: 'description',
        SubnetIds: 'subnet_ids',
      }),
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
          case 'DefaultAction': result['default_action'] = resolve(v); break;
          case 'Rules': result['rule'] = resolve(v); break;
          case 'VisibilityConfig': result['visibility_config'] = resolve(v); break;
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
          case 'Integration': {
            if (v && typeof v === 'object') {
              const intg = v as Record<string, unknown>;
              result['integration'] = {
                type: intg['Type'],
                http_method: intg['IntegrationHttpMethod'],
                uri: resolve(intg['Uri']),
              };
            }
            break;
          }
          case 'Tags': break;
          default: result[toSnake(k)] = resolve(v);
        }
      }
      return result;
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
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        PolicyName: 'name',
        PolicyType: 'policy_type',
        ScalingTargetId: 'resource_id',
        ServiceNamespace: 'service_namespace',
        ScalableDimension: 'scalable_dimension',
      }),
  },

  'AWS::CloudWatch::Alarm': {
    tfType: 'aws_cloudwatch_metric_alarm',
    refAttr: 'id',
    attrMap: { Arn: 'arn' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        AlarmName: 'alarm_name',
        MetricName: 'metric_name',
        Namespace: 'namespace',
        Threshold: 'threshold',
        EvaluationPeriods: 'evaluation_periods',
        Period: 'period',
        ComparisonOperator: 'comparison_operator',
        Statistic: 'statistic',
        TreatMissingData: 'treat_missing_data',
        AlarmActions: 'alarm_actions',
        Dimensions: 'dimensions',
      }),
  },

  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    tfType: 'aws_lb',
    refAttr: 'id',
    attrMap: { Arn: 'arn', DNSName: 'dns_name' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        Name: 'name',
        Type: 'load_balancer_type',
        Scheme: 'internal',
        Subnets: 'subnets',
        SecurityGroups: 'security_groups',
        LoadBalancerAttributes: 'access_logs',
      }),
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
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        Name: 'name',
        Port: 'port',
        Protocol: 'protocol',
        VpcId: 'vpc_id',
        HealthCheckPath: 'health_check_path',
        TargetType: 'target_type',
      }),
  },

  'AWS::SecretsManager::Secret': {
    tfType: 'aws_secretsmanager_secret',
    refAttr: 'arn',
    attrMap: { Id: 'arn' },
    mapProps: (props, resolve) =>
      generic(props, resolve, new Set(), {
        Name: 'name',
        Description: 'description',
        SecretString: 'secret_string',
      }),
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
