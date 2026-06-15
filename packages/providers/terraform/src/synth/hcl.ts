import { Stack, BaseConstruct } from '@iacmp/core';

const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 't3.small',
  medium: 't3.medium',
  large: 't3.large',
};

function indent(text: string, spaces = 2): string {
  return text.split('\n').map(l => (l.trim() ? ' '.repeat(spaces) + l : l)).join('\n');
}

function block(type: string, labels: string[], body: string): string {
  const labelStr = labels.map(l => ` "${l}"`).join('');
  return `${type}${labelStr} {\n${body}\n}\n`;
}

function attr(key: string, value: string | number | boolean): string {
  if (typeof value === 'string') return `${key} = "${value}"`;
  return `${key} = ${value}`;
}

function tagsBlock(name: string): string {
  return indent(`tags = {\n${indent(`Name = "${name}"`)}\n}`);
}

function synthesizeConstruct(construct: BaseConstruct): string {
  const props = construct.props as Record<string, unknown>;
  const id = construct.id.replace(/[^a-zA-Z0-9_]/g, '_');

  switch (construct.type) {
    case 'Compute.Instance': {
      const instanceType = INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small';
      const body = indent([
        attr('ami', (props.image as string) ?? 'ami-ubuntu-22.04'),
        attr('instance_type', instanceType),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_instance', id], body);
    }

    case 'Storage.Bucket': {
      const versioning = (props.versioning as boolean) ?? false;
      const blockPublic = !(props.publicAccess as boolean);
      const bucketName = construct.id.toLowerCase();

      const bucketBody = indent([
        attr('bucket', bucketName),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const versioningBody = indent([
        `bucket = aws_s3_bucket.${id}.id`,
        `versioning_configuration {`,
        `  status = "${versioning ? 'Enabled' : 'Suspended'}"`,
        `}`,
      ].join('\n'));

      const pabBody = indent([
        `bucket                  = aws_s3_bucket.${id}.id`,
        attr('block_public_acls', blockPublic),
        attr('block_public_policy', blockPublic),
        attr('ignore_public_acls', blockPublic),
        attr('restrict_public_buckets', blockPublic),
      ].join('\n'));

      return [
        block('resource', ['aws_s3_bucket', id], bucketBody),
        block('resource', ['aws_s3_bucket_versioning', `${id}_versioning`], versioningBody),
        block('resource', ['aws_s3_bucket_public_access_block', `${id}_pab`], pabBody),
      ].join('\n');
    }

    case 'Network.VPC': {
      const body = indent([
        attr('cidr_block', (props.cidr as string) ?? '10.0.0.0/16'),
        attr('enable_dns_hostnames', true),
        attr('enable_dns_support', true),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_vpc', id], body);
    }

    case 'Network.Subnet': {
      const isPublic = (props.public as boolean) ?? false;
      const lines = [
        `vpc_id = "${props.vpcId as string}"`,
        attr('cidr_block', props.cidr as string),
        attr('map_public_ip_on_launch', isPublic),
      ];
      if (props.availabilityZone) lines.push(attr('availability_zone', props.availabilityZone as string));
      lines.push('', tagsBlock(construct.id));
      return block('resource', ['aws_subnet', id], indent(lines.join('\n')));
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];

      const ingressBlocks = ingress.map(r => indent([
        'ingress {',
        indent([
          attr('protocol', r.protocol as string),
          attr('from_port', r.fromPort as number),
          attr('to_port', r.toPort as number),
          attr('cidr_blocks', `["${(r.cidr as string) ?? '0.0.0.0/0'}"]`),
          r.description ? attr('description', r.description as string) : '',
        ].filter(Boolean).join('\n')),
        '}',
      ].join('\n'))).join('\n');

      const egressList = egress.length > 0 ? egress : [{
        protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0', description: 'Allow all egress',
      }];
      const egressBlocks = egressList.map((r: Record<string, unknown>) => indent([
        'egress {',
        indent([
          attr('protocol', r.protocol as string),
          attr('from_port', r.fromPort as number),
          attr('to_port', r.toPort as number),
          attr('cidr_blocks', `["${(r.cidr as string) ?? '0.0.0.0/0'}"]`),
          r.description ? attr('description', r.description as string) : '',
        ].filter(Boolean).join('\n')),
        '}',
      ].join('\n'))).join('\n');

      const body = indent([
        `vpc_id = "${props.vpcId as string}"`,
        attr('description', (props.description as string) ?? `Security group ${id}`),
        '',
        ingressBlocks,
        '',
        egressBlocks,
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      return block('resource', ['aws_security_group', id], body);
    }

    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const body = indent([
        attr('identifier', construct.id.toLowerCase()),
        attr('engine', engine),
        attr('engine_version', engine === 'postgres' ? '15.4' : '8.0.36'),
        attr('instance_class', (props.instanceType as string) ?? 'db.t3.micro'),
        attr('allocated_storage', 20),
        attr('username', 'dbadmin'),
        attr('password', 'changeme'),
        attr('multi_az', (props.multiAz as boolean) ?? false),
        attr('skip_final_snapshot', false),
        attr('storage_encrypted', true),
        attr('backup_retention_period', 7),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_db_instance', id], body);
    }

    case 'Function.Lambda': {
      const environment = props.environment as Record<string, string> | undefined;

      const envBlock = environment && Object.keys(environment).length > 0
        ? '\n' + indent([
            'environment {',
            indent('variables = {', 2),
            ...Object.entries(environment).map(([k, v]) => indent(indent(attr(k, v), 2), 2)),
            indent('}', 2),
            '}',
          ].join('\n'))
        : '';

      const body = indent([
        attr('function_name', construct.id),
        attr('runtime', 'nodejs20.x'),
        attr('handler', (props.handler as string) ?? 'index.handler'),
        attr('role', 'arn:aws:iam::ACCOUNT_ID:role/lambda-role'),
        '',
        `filename = "function.zip"`,
        `source_code_hash = filebase64sha256("function.zip")`,
        '',
        (props.memory ? attr('memory_size', props.memory as number) : ''),
        (props.timeout ? attr('timeout', props.timeout as number) : ''),
        envBlock,
        '',
        tagsBlock(construct.id),
      ].filter(l => l !== '').join('\n'));
      return block('resource', ['aws_lambda_function', id], body);
    }

    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachType = props.attachType as string;
      const attachTo = (props.attachTo as string).replace(/[^a-zA-Z0-9_]/g, '_');

      const principalService =
        attachType === 'lambda' ? 'lambda.amazonaws.com' :
        attachType === 'compute' ? 'ec2.amazonaws.com' :
        'ec2.amazonaws.com';

      const policyStmts = statements.map(s => {
        const actions = (s.actions as string[]).map(a => `"${a}"`).join(', ');
        const resources = ((s.resources as string[]) ?? ['*']).map(r => `"${r}"`).join(', ');
        return `    {\n      "Effect": "${s.effect}",\n      "Action": [${actions}],\n      "Resource": [${resources}]\n    }`;
      }).join(',\n');

      const assumeDoc = `jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Effect = "Allow"\n      Principal = { Service = "${principalService}" }\n      Action = "sts:AssumeRole"\n    }]\n  })`;

      const policyDoc = `jsonencode({\n    Version = "2012-10-17"\n    Statement = [\n${policyStmts}\n    ]\n  })`;

      const roleBody = indent([
        attr('name', `${attachTo}-role`),
        `assume_role_policy = ${assumeDoc}`,
        '',
        tagsBlock(`${attachTo}-role`),
      ].join('\n'));

      const policyBody = indent([
        attr('name', `${id}-policy`),
        `policy = ${policyDoc}`,
      ].join('\n'));

      const attachBody = indent([
        `role       = aws_iam_role.${id}_role.name`,
        `policy_arn = aws_iam_policy.${id}_policy.arn`,
      ].join('\n'));

      const parts = [
        block('resource', ['aws_iam_role', `${id}_role`], roleBody),
        block('resource', ['aws_iam_policy', `${id}_policy`], policyBody),
        block('resource', ['aws_iam_role_policy_attachment', `${id}_attach`], attachBody),
      ];

      if (attachType === 'compute') {
        const profileBody = indent([
          attr('name', `${attachTo}-profile`),
          `role = aws_iam_role.${id}_role.name`,
        ].join('\n'));
        parts.push(block('resource', ['aws_iam_instance_profile', `${id}_profile`], profileBody));
      }

      return parts.join('\n');
    }

    case 'Database.DocumentDB': {
      const instanceType = (props.instanceType as string) ?? 'db.t3.medium';
      const instances = (props.instances as number) ?? 1;

      const clusterBody = indent([
        attr('cluster_identifier', construct.id.toLowerCase()),
        attr('engine', 'docdb'),
        attr('master_username', 'docdbadmin'),
        attr('master_password', 'changeme'),
        attr('backup_retention_period', 7),
        attr('skip_final_snapshot', false),
        attr('storage_encrypted', true),
        attr('deletion_protection', (props.deletionProtection as boolean) ?? false),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const instanceBlocks = Array.from({ length: instances }, (_, i) => {
        const instId = `${id}_instance_${i + 1}`;
        return block('resource', ['aws_docdb_cluster_instance', instId], indent([
          attr('identifier', `${construct.id.toLowerCase()}-${i + 1}`),
          `cluster_id = aws_docdb_cluster.${id}.id`,
          attr('instance_class', instanceType),
        ].join('\n')));
      }).join('\n');

      return [
        block('resource', ['aws_docdb_cluster', id], clusterBody),
        instanceBlocks,
      ].join('\n');
    }

    case 'Cache.Redis': {
      const nodeTypeMap: Record<string, string> = {
        small: 'cache.t3.micro',
        medium: 'cache.t3.medium',
        large: 'cache.r6g.large',
      };
      const numNodes = (props.numCacheNodes as number) ?? 1;
      const autoFailover = (props.automaticFailoverEnabled as boolean) ?? false;

      const body = indent([
        attr('replication_group_id', construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)),
        attr('description', `Redis ${construct.id}`),
        attr('node_type', nodeTypeMap[(props.nodeType as string) ?? 'small'] ?? 'cache.t3.micro'),
        attr('num_cache_clusters', numNodes),
        attr('automatic_failover_enabled', autoFailover && numNodes > 1),
        attr('at_rest_encryption_enabled', (props.atRestEncryptionEnabled as boolean) ?? true),
        attr('transit_encryption_enabled', (props.transitEncryptionEnabled as boolean) ?? true),
        attr('engine_version', '7.0'),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_elasticache_replication_group', id], body);
    }

    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const busName = (props.busName as string) ?? 'default';

      const parts: string[] = [];

      if (busName !== 'default') {
        parts.push(block('resource', ['aws_cloudwatch_event_bus', id], indent(attr('name', busName))));
      }

      for (const r of rules) {
        const ruleId = ((r.name as string) ?? 'rule').replace(/[^a-zA-Z0-9_]/g, '_');
        const pattern: Record<string, unknown> = {};
        if (r.source) pattern['source'] = r.source;
        if (r.detailTypes) pattern['detail-type'] = r.detailTypes;

        const ruleBody = indent([
          attr('name', r.name as string),
          `event_bus_name = "${busName}"`,
          `event_pattern = jsonencode(${JSON.stringify(pattern)})`,
          attr('state', 'ENABLED'),
        ].join('\n'));
        parts.push(block('resource', ['aws_cloudwatch_event_rule', `${id}_${ruleId}`], ruleBody));

        if (r.targetArn) {
          const targetBody = indent([
            `rule      = aws_cloudwatch_event_rule.${id}_${ruleId}.name`,
            attr('target_id', `${ruleId}Target`),
            attr('arn', r.targetArn as string),
          ].join('\n'));
          parts.push(block('resource', ['aws_cloudwatch_event_target', `${id}_${ruleId}_target`], targetBody));
        }
      }

      return parts.join('\n');
    }

    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const sfType = (props.type as string) ?? 'STANDARD';

      const definition = {
        Comment: (props.description as string) ?? `Workflow ${construct.id}`,
        StartAt: steps.length > 0 ? (steps[0].name as string) : 'Start',
        States: Object.fromEntries(steps.map((s, i) => [
          s.name as string,
          {
            Type: (s.type as string) ?? 'Task',
            Resource: (s.resource as string) ?? 'arn:aws:lambda:us-east-1:ACCOUNT:function:placeholder',
            ...(i < steps.length - 1 ? { Next: steps[i + 1].name as string } : { End: true }),
          },
        ])),
      };

      const body = indent([
        attr('name', construct.id),
        attr('type', sfType),
        `definition = jsonencode(${JSON.stringify(definition)})`,
        attr('role_arn', 'arn:aws:iam::ACCOUNT_ID:role/StepFunctionsExecutionRole'),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_sfn_state_machine', id], body);
    }

    case 'Messaging.Queue': {
      const fifo = (props.fifo as boolean) ?? false;
      const queueName = fifo ? `${construct.id}.fifo` : construct.id;

      const body = indent([
        attr('name', queueName),
        attr('visibility_timeout_seconds', (props.visibilityTimeoutSeconds as number) ?? 30),
        attr('message_retention_seconds', (props.messageRetentionSeconds as number) ?? 345600),
        attr('delay_seconds', (props.delaySeconds as number) ?? 0),
        attr('fifo_queue', fifo),
        attr('sqs_managed_sse_enabled', (props.encrypted as boolean) ?? true),
        ...(props.dlqArn ? [
          `redrive_policy = jsonencode({\n  deadLetterTargetArn = "${props.dlqArn}"\n  maxReceiveCount     = ${(props.maxReceiveCount as number) ?? 3}\n})`,
        ] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_sqs_queue', id], body);
    }

    case 'Messaging.Topic': {
      const fifo = (props.fifo as boolean) ?? false;
      const topicName = fifo ? `${construct.id}.fifo` : construct.id;
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];

      const topicBody = indent([
        attr('name', topicName),
        attr('display_name', (props.displayName as string) ?? construct.id),
        attr('fifo_topic', fifo),
        ...(props.encrypted ? [attr('kms_master_key_id', 'alias/aws/sns')] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const subBlocks = subscriptions.map((s, i) => {
        const subBody = indent([
          `topic_arn = aws_sns_topic.${id}.arn`,
          attr('protocol', s.protocol),
          attr('endpoint', s.endpoint),
        ].join('\n'));
        return block('resource', ['aws_sns_topic_subscription', `${id}_sub_${i}`], subBody);
      }).join('\n');

      return [block('resource', ['aws_sns_topic', id], topicBody), subBlocks].filter(Boolean).join('\n');
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const scope = (props.scope as string) ?? 'REGIONAL';

      const ruleBlocks = rules.map((r, i) => {
        const action = (r.action as string) ?? 'allow';
        const ruleId = ((r.name as string) ?? `rule${i}`).replace(/[^a-zA-Z0-9_]/g, '_');
        return indent([
          'rule {',
          indent([
            attr('name', (r.name as string) ?? `rule-${i}`),
            attr('priority', i + 1),
            `action {\n  ${action} {}\n}`,
            `statement {\n  managed_rule_group_statement {\n    name        = "${(r.managedGroup as string) ?? 'AWSManagedRulesCommonRuleSet'}"\n    vendor_name = "AWS"\n  }\n}`,
            `visibility_config {\n  cloudwatch_metrics_enabled = true\n  metric_name                = "${ruleId}"\n  sampled_requests_enabled   = true\n}`,
          ].join('\n')),
          '}',
        ].join('\n'));
      });

      const body = indent([
        attr('name', id),
        attr('description', (props.description as string) ?? `WAF ${id}`),
        attr('scope', scope),
        `default_action {\n  ${(props.defaultAction as string) ?? 'allow'} {}\n}`,
        '',
        ruleBlocks.join('\n'),
        '',
        `visibility_config {\n  cloudwatch_metrics_enabled = true\n  metric_name                = "${id}"\n  sampled_requests_enabled   = true\n}`,
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      return block('resource', ['aws_wafv2_web_acl', id], body);
    }

    default:
      return '';
  }
}

export function synthesize(stack: Stack): string {
  const awsBlock = block('aws', [], indent(`source  = "hashicorp/aws"\nversion = "~> 5.0"`));
  const requiredProvidersBlock = block('required_providers', [], indent(awsBlock));
  const terraformBlock = block('terraform', [], indent(requiredProvidersBlock));
  const providerBlock = block('provider', ['aws'], indent(attr('region', 'us-east-1')));

  const header = [terraformBlock, providerBlock].join('\n');

  const resources = stack.constructs
    .map(c => synthesizeConstruct(c))
    .filter(Boolean)
    .join('\n');

  return [header, resources].filter(Boolean).join('\n');
}
