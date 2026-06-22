import { Stack, BaseConstruct } from '@iacmp/core';

const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 't3.small',
  medium: 't3.medium',
  large: 't3.large',
};

const AMI_MAP: Record<string, string> = {
  'ubuntu': 'data.aws_ami.ubuntu.id',
  'ubuntu-22.04': 'data.aws_ami.ubuntu.id',
  'amazon-linux-2': 'data.aws_ami.amazon_linux.id',
  'amazon-linux-2023': 'data.aws_ami.amazon_linux_2023.id',
  'windows-2022': 'data.aws_ami.windows_2022.id',
  'windows-2019': 'data.aws_ami.windows_2019.id',
  'windows-2016': 'data.aws_ami.windows_2016.id',
};

const CACHE_NODE_TYPE_MAP: Record<string, string> = {
  small: 'cache.t3.micro',
  medium: 'cache.t3.medium',
  large: 'cache.r6g.large',
};

const K8S_NODE_TYPE_MAP: Record<string, string> = {
  small: 't3.medium',
  medium: 'm5.large',
  large: 'm5.2xlarge',
};

function indent(text: string, spaces = 2): string {
  return text.split('\n').map(l => (l.trim() ? ' '.repeat(spaces) + l : l)).join('\n');
}

function block(type: string, labels: string[], body: string): string {
  const labelStr = labels.map(l => ` "${l}"`).join('');
  return `${type}${labelStr} {\n${body}\n}\n`;
}

// HCL string escape: barra, aspas e interpoladores ${..} / %{..} precisam ser neutralizados
// para que valores arbitrarios (gerados por IA, vindos de prompts) nao quebrem o template.
// Nota: em replacement de String.replace, '$$' significa '$' literal; por isso usamos '$$$$' p/ emitir '$$'.
export function hclString(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$\{/g, '$$$${')
    .replace(/%\{/g, '%%{');
}

function attr(key: string, value: string | number | boolean): string {
  if (typeof value === 'string') return `${key} = "${hclString(value)}"`;
  return `${key} = ${value}`;
}

function tagsBlock(name: string): string {
  return indent(`tags = {\n${indent(`Name = "${hclString(name)}"`)}\n}`);
}

function hclValue(value: unknown): string {
  if (typeof value === 'string') {
    // permite que a IA passe referências cruas do Terraform (ex: aws_lambda_function.x.arn)
    if (/^[a-zA-Z_][a-zA-Z0-9_.\[\]]*$/.test(value) && /\./.test(value)) return value;
    return `"${hclString(value)}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(hclValue).join(', ')}]`;
  if (value && typeof value === 'object') return hclBody(value as Record<string, unknown>);
  return 'null';
}

function hclBody(obj: Record<string, unknown>): string {
  const lines = Object.entries(obj).map(([k, v]) => `${k} = ${hclValue(v)}`);
  return `{\n${indent(lines.join('\n'))}\n}`;
}

function synthesizeConstruct(construct: BaseConstruct): string {
  const props = construct.props as Record<string, unknown>;
  const id = construct.id.replace(/[^a-zA-Z0-9_]/g, '_');

  switch (construct.type) {

    // ── Compute ──────────────────────────────────────────────────────────
    case 'Compute.Instance': {
      const instanceType = INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small';
      const ami = AMI_MAP[props.image as string];
      const body = indent([
        `ami           = ${ami ? ami : `"${hclString(props.image)}"`}`,
        attr('instance_type', instanceType),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_instance', id], body);
    }

    case 'Compute.AutoScaling': {
      const instanceType = INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small';
      const image = props.image as string;

      const lcBody = indent([
        `image_id      = "${hclString(image)}"`,
        attr('instance_type', instanceType),
      ].join('\n'));

      const asgBody = indent([
        `launch_configuration = aws_launch_configuration.${id}_lc.name`,
        attr('min_size', props.minCapacity as number),
        attr('max_size', props.maxCapacity as number),
        attr('desired_capacity', (props.desiredCapacity as number) ?? (props.minCapacity as number)),
        ...(props.subnetIds ? [`vpc_zone_identifier = ${JSON.stringify(props.subnetIds)}`] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const parts = [
        block('resource', ['aws_launch_configuration', `${id}_lc`], lcBody),
        block('resource', ['aws_autoscaling_group', id], asgBody),
      ];

      if (props.targetCpuUtilization) {
        const spBody = indent([
          `autoscaling_group_name = aws_autoscaling_group.${id}.name`,
          attr('policy_type', 'TargetTrackingScaling'),
          `target_tracking_configuration {\n  predefined_metric_specification {\n    predefined_metric_type = "ASGAverageCPUUtilization"\n  }\n  target_value = ${props.targetCpuUtilization}\n}`,
        ].join('\n'));
        parts.push(block('resource', ['aws_autoscaling_policy', `${id}_sp`], spBody));
      }

      return parts.join('\n');
    }

    case 'Compute.Container': {
      const environment = props.environment as Record<string, string> | undefined;

      const containerDef = JSON.stringify([{
        name: construct.id,
        image: props.image as string,
        cpu: props.cpu ?? 256,
        memory: props.memory ?? 512,
        portMappings: props.port ? [{ containerPort: props.port, protocol: 'tcp' }] : [],
        environment: environment ? Object.entries(environment).map(([k, v]) => ({ name: k, value: v })) : [],
      }]);

      const clusterBody = indent([attr('name', construct.id)].join('\n'));
      const tdBody = indent([
        attr('family', construct.id),
        attr('network_mode', 'awsvpc'),
        `requires_compatibilities = ["FARGATE"]`,
        attr('cpu', String(props.cpu ?? 256)),
        attr('memory', String(props.memory ?? 512)),
        `execution_role_arn = "arn:aws:iam::ACCOUNT_ID:role/ecsTaskExecutionRole"`,
        `container_definitions = jsonencode(${containerDef})`,
      ].join('\n'));

      const svcBody = indent([
        `cluster         = aws_ecs_cluster.${id}.id`,
        `task_definition = aws_ecs_task_definition.${id}.arn`,
        attr('desired_count', (props.desiredCount as number) ?? 1),
        attr('launch_type', 'FARGATE'),
        `network_configuration {\n  assign_public_ip = ${(props.publicIp as boolean) ?? false}\n  subnets         = []\n}`,
      ].join('\n'));

      return [
        block('resource', ['aws_ecs_cluster', id], clusterBody),
        block('resource', ['aws_ecs_task_definition', id], tdBody),
        block('resource', ['aws_ecs_service', id], svcBody),
      ].join('\n');
    }

    case 'Compute.Kubernetes': {
      const nodeType = K8S_NODE_TYPE_MAP[(props.nodeInstanceType as string) ?? 'medium'] ?? 'm5.large';
      const clusterBody = indent([
        attr('name', construct.id),
        attr('version', (props.version as string) ?? '1.29'),
        `role_arn = "arn:aws:iam::ACCOUNT_ID:role/EKSClusterRole"`,
        `vpc_config {\n  subnet_ids              = []\n  endpoint_private_access = ${(props.privateCluster as boolean) ?? false}\n  endpoint_public_access  = ${!(props.privateCluster as boolean)}\n}`,
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const ngBody = indent([
        `cluster_name    = aws_eks_cluster.${id}.name`,
        attr('node_group_name', `${construct.id}-ng`),
        `node_role_arn   = "arn:aws:iam::ACCOUNT_ID:role/EKSNodeRole"`,
        `subnet_ids      = []`,
        `scaling_config {\n  desired_size = ${props.desiredNodes ?? 2}\n  max_size     = ${props.maxNodes ?? 3}\n  min_size     = ${props.minNodes ?? 1}\n}`,
        `instance_types = ["${nodeType}"]`,
      ].join('\n'));

      return [
        block('resource', ['aws_eks_cluster', id], clusterBody),
        block('resource', ['aws_eks_node_group', `${id}_ng`], ngBody),
      ].join('\n');
    }

    // ── Storage ───────────────────────────────────────────────────────────
    case 'Storage.Bucket': {
      const versioning = (props.versioning as boolean) ?? false;
      const blockPublic = !(props.publicAccess as boolean);
      const lifecycleRules = (props.lifecycleRules as Array<Record<string, unknown>>) ?? [];

      const bucketBody = indent([
        attr('bucket', construct.id.toLowerCase()),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const versioningBody = indent([
        `bucket = aws_s3_bucket.${id}.id`,
        `versioning_configuration {\n  status = "${versioning ? 'Enabled' : 'Suspended'}"\n}`,
      ].join('\n'));

      const pabBody = indent([
        `bucket                  = aws_s3_bucket.${id}.id`,
        attr('block_public_acls', blockPublic),
        attr('block_public_policy', blockPublic),
        attr('ignore_public_acls', blockPublic),
        attr('restrict_public_buckets', blockPublic),
      ].join('\n'));

      const parts = [
        block('resource', ['aws_s3_bucket', id], bucketBody),
        block('resource', ['aws_s3_bucket_versioning', `${id}_versioning`], versioningBody),
        block('resource', ['aws_s3_bucket_public_access_block', `${id}_pab`], pabBody),
      ];

      if (lifecycleRules.length > 0) {
        const lcLines = lifecycleRules.map((r, i) => {
          return [
            `  rule {`,
            `    id     = "rule-${i}"`,
            `    status = "Enabled"`,
            r.prefix ? `    filter {\n      prefix = "${hclString(r.prefix)}"\n    }` : '',
            r.expireAfterDays ? `    expiration {\n      days = ${r.expireAfterDays}\n    }` : '',
            r.transitionToGlacierDays ? `    transition {\n      days          = ${r.transitionToGlacierDays}\n      storage_class = "GLACIER"\n    }` : '',
            `  }`,
          ].filter(Boolean).join('\n');
        }).join('\n');
        parts.push(block('resource', ['aws_s3_bucket_lifecycle_configuration', `${id}_lc`],
          indent(`bucket = aws_s3_bucket.${id}.id\n${lcLines}`)));
      }

      return parts.join('\n');
    }

    case 'Storage.FileSystem': {
      const fsBody = indent([
        attr('performance_mode', (props.performanceMode as string) ?? 'generalPurpose'),
        attr('throughput_mode', (props.throughputMode as string) ?? 'bursting'),
        attr('encrypted', (props.encrypted as boolean) ?? true),
        `lifecycle_policy {\n  transition_to_ia = "AFTER_30_DAYS"\n}`,
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const parts = [block('resource', ['aws_efs_file_system', id], fsBody)];

      const accessPoints = (props.accessPoints as Array<Record<string, unknown>>) ?? [];
      for (const ap of accessPoints) {
        const apId = `${id}_ap_${(ap.name as string).replace(/[^a-zA-Z0-9_]/g, '_')}`;
        const apBody = indent([
          `file_system_id = aws_efs_file_system.${id}.id`,
          `root_directory {\n  path = "${hclString(ap.path)}"\n}`,
          ap.uid ? `posix_user {\n  uid = ${ap.uid}\n  gid = ${ap.gid ?? ap.uid}\n}` : '',
        ].filter(Boolean).join('\n'));
        parts.push(block('resource', ['aws_efs_access_point', apId], apBody));
      }

      return parts.join('\n');
    }

    case 'Storage.Archive': {
      const body = indent([
        attr('bucket', `${construct.id.toLowerCase()}-archive`),
        `lifecycle_rule {\n  id      = "archive-rule"\n  enabled = true\n  transition {\n    days          = 0\n    storage_class = "DEEP_ARCHIVE"\n  }\n${props.retentionDays ? `  expiration {\n    days = ${props.retentionDays}\n  }\n` : ''}}`,
        `object_lock_enabled = ${(props.lockEnabled as boolean) ?? false}`,
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_s3_bucket', id], body);
    }

    // ── Network ───────────────────────────────────────────────────────────
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
        `vpc_id = "${hclString(props.vpcId)}"`,
        attr('cidr_block', props.cidr as string),
        attr('map_public_ip_on_launch', isPublic),
        ...(props.availabilityZone ? [attr('availability_zone', props.availabilityZone as string)] : []),
        '',
        tagsBlock(construct.id),
      ];
      return block('resource', ['aws_subnet', id], indent(lines.join('\n')));
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];

      const ingressBlocks = ingress.map((r, i) => {
        if (r.cidr === undefined) {
          console.warn(`[terraform] Security group rule sem CIDR; usando 0.0.0.0/0 — defina props.cidr explicitamente (${construct.id} ingress[${i}])`);
        }
        return indent([
          'ingress {',
          indent([
            attr('protocol', r.protocol as string),
            attr('from_port', r.fromPort as number),
            attr('to_port', r.toPort as number),
            `cidr_blocks = ["${hclString((r.cidr as string) ?? '0.0.0.0/0')}"]`,
            r.description ? attr('description', r.description as string) : '',
          ].filter(Boolean).join('\n')),
          '}',
        ].join('\n'));
      }).join('\n');

      const egressList = egress.length > 0 ? egress : [{ protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' }];
      const egressBlocks = egressList.map((r: Record<string, unknown>) => indent([
        'egress {',
        indent([
          attr('protocol', r.protocol as string),
          attr('from_port', r.fromPort as number),
          attr('to_port', r.toPort as number),
          `cidr_blocks = ["${hclString((r.cidr as string) ?? '0.0.0.0/0')}"]`,
        ].join('\n')),
        '}',
      ].join('\n'))).join('\n');

      const body = indent([
        `vpc_id      = "${hclString(props.vpcId)}"`,
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

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const scope = (props.scope as string) ?? 'REGIONAL';
      const defaultAction = (props.defaultAction as string) ?? 'allow';

      const ruleBlocks = rules.map((r, i) => {
        const action = (r.action as string) ?? 'allow';
        const ruleId = ((r.name as string) ?? `rule${i}`).replace(/[^a-zA-Z0-9_]/g, '_');
        const statement = r.managedGroup
          ? `statement {\n    managed_rule_group_statement {\n      name        = "${hclString(r.managedGroup)}"\n      vendor_name = "AWS"\n    }\n  }`
          : `statement {\n    byte_match_statement {\n      search_string = "${hclString(((r.matchValues as string[]) ?? ['BadBot'])[0])}"\n      field_to_match { single_header { name = "user-agent" } }\n      text_transformation { priority = 0 type = "NONE" }\n      positional_constraint = "CONTAINS"\n    }\n  }`;
        return indent([
          'rule {',
          indent([
            attr('name', (r.name as string) ?? `rule-${i}`),
            attr('priority', (r.priority as number) ?? (i + 1)),
            `action {\n  ${action === 'block' ? 'block' : action === 'count' ? 'count' : 'allow'} {}\n}`,
            statement,
            `visibility_config {\n  cloudwatch_metrics_enabled = true\n  metric_name                = "${ruleId}"\n  sampled_requests_enabled   = true\n}`,
          ].join('\n')),
          '}',
        ].join('\n'));
      }).join('\n');

      const body = indent([
        attr('name', id),
        attr('scope', scope),
        `default_action {\n  ${defaultAction === 'block' ? 'block' : 'allow'} {}\n}`,
        ruleBlocks,
        `visibility_config {\n  cloudwatch_metrics_enabled = true\n  metric_name                = "${id}"\n  sampled_requests_enabled   = true\n}`,
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      return block('resource', ['aws_wafv2_web_acl', id], body);
    }

    case 'Network.LoadBalancer': {
      const lbType = (props.type as string) ?? 'application';
      const listeners = (props.listeners as Array<Record<string, unknown>>) ?? [];
      const targetGroups = (props.targetGroups as Array<Record<string, unknown>>) ?? [];

      const lbBody = indent([
        attr('name', construct.id),
        attr('load_balancer_type', lbType),
        attr('internal', (props.scheme as string) === 'internal'),
        `subnets = ${JSON.stringify((props.subnetIds as string[]) ?? [])}`,
        ...(lbType === 'application' && props.securityGroupIds
          ? [`security_groups = ${JSON.stringify(props.securityGroupIds)}`] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const parts = [block('resource', ['aws_lb', id], lbBody)];

      for (const tg of targetGroups) {
        const tgId = `${id}_tg_${(tg.name as string).replace(/[^a-zA-Z0-9_]/g, '_')}`;
        const tgBody = indent([
          attr('name', tg.name as string),
          attr('port', tg.port as number),
          attr('protocol', tg.protocol as string),
          `vpc_id      = ""`,
          `target_type = "ip"`,
          `health_check {\n  path = "${hclString((tg.healthCheckPath as string) ?? '/')}"\n}`,
        ].join('\n'));
        parts.push(block('resource', ['aws_lb_target_group', tgId], tgBody));
      }

      for (let i = 0; i < listeners.length; i++) {
        const l = listeners[i];
        const listenerId = `${id}_listener_${i + 1}`;
        const redirectAction = `redirect {\n    port        = "443"\n    protocol    = "HTTPS"\n    status_code = "HTTP_301"\n  }`;
        const fixedAction = `fixed_response {\n    content_type = "text/plain"\n    message_body = "Not found"\n    status_code  = "404"\n  }`;
        const listenerBody = indent([
          `load_balancer_arn = aws_lb.${id}.arn`,
          attr('port', l.port as number),
          attr('protocol', l.protocol as string),
          ...(l.certificateArn ? [attr('certificate_arn', l.certificateArn as string)] : []),
          `default_action {\n  type = "${(l.redirectToHttps as boolean) ? 'redirect' : 'fixed-response'}"\n  ${(l.redirectToHttps as boolean) ? redirectAction : fixedAction}\n}`,
        ].join('\n'));
        parts.push(block('resource', ['aws_lb_listener', listenerId], listenerBody));
      }

      return parts.join('\n');
    }

    case 'Network.CDN': {
      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      const body = indent([
        `origin {\n  domain_name = "${hclString(origins[0]?.domainName ?? '')}"\n  origin_id   = "${hclString(origins[0]?.id ?? 'default')}"\n}`,
        `enabled             = true`,
        attr('default_root_object', (props.defaultRootObject as string) ?? 'index.html'),
        attr('price_class', (props.priceClass as string) ?? 'PriceClass_100'),
        `default_cache_behavior {\n  target_origin_id       = "${hclString(origins[0]?.id ?? 'default')}"\n  viewer_protocol_policy = "redirect-to-https"\n  allowed_methods        = ["GET", "HEAD"]\n  cached_methods         = ["GET", "HEAD"]\n  compress               = true\n  forwarded_values {\n    query_string = false\n    cookies { forward = "none" }\n  }\n}`,
        ...(props.certificateArn
          ? [`viewer_certificate {\n  acm_certificate_arn = "${hclString(props.certificateArn)}"\n  ssl_support_method  = "sni-only"\n}`]
          : [`viewer_certificate {\n  cloudfront_default_certificate = true\n}`]),
        `restrictions {\n  geo_restriction {\n    restriction_type = "none"\n  }\n}`,
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_cloudfront_distribution', id], body);
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const zoneBody = indent([
        attr('name', props.zoneName as string),
        tagsBlock(construct.id),
      ].join('\n'));

      const parts = [block('resource', ['aws_route53_zone', id], zoneBody)];

      for (const r of records) {
        const recId = `${id}_${(r.name as string).replace(/[^a-zA-Z0-9_]/g, '_')}_${r.type}`;
        const recBody = indent([
          `zone_id = aws_route53_zone.${id}.zone_id`,
          attr('name', r.name as string),
          attr('type', r.type as string),
          attr('ttl', (r.ttl as number) ?? 300),
          `records = ${JSON.stringify(r.values as string[])}`,
        ].join('\n'));
        parts.push(block('resource', ['aws_route53_record', recId], recBody));
      }

      return parts.join('\n');
    }

    // ── Database ──────────────────────────────────────────────────────────
    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const edition = (props.edition as string) ?? '';
      const licenseModel = (props.licenseModel as string) ?? '';

      const engineVersionMap: Record<string, string> = {
        mysql:     '8.0.36',
        postgres:  '15.4',
        mariadb:   '10.11.6',
        oracle:    '19.0.0.0.ru-2024-01.rur-2024-01.r1',
        sqlserver: '15.00.4365.2.v1',
      };
      const engineIdentMap: Record<string, string> = {
        mysql:     'mysql',
        postgres:  'postgres',
        mariadb:   'mariadb',
        oracle:    `oracle-${edition || 'se2'}`,
        sqlserver: `sqlserver-${edition || 'ex'}`,
      };
      const defaultInstanceMap: Record<string, string> = {
        mysql:     'db.t3.micro',
        postgres:  'db.t3.micro',
        mariadb:   'db.t3.micro',
        oracle:    'db.t3.small',
        sqlserver: 'db.t3.small',
      };
      const usernameMap: Record<string, string> = {
        mysql:     'dbadmin',
        postgres:  'dbadmin',
        mariadb:   'dbadmin',
        oracle:    'dbadmin',
        sqlserver: 'sqladmin',
      };

      const attrs = [
        attr('identifier', construct.id.toLowerCase()),
        attr('engine', engineIdentMap[engine] ?? engine),
        attr('engine_version', engineVersionMap[engine] ?? '8.0.36'),
        attr('instance_class', (props.instanceType as string) ?? defaultInstanceMap[engine] ?? 'db.t3.micro'),
        attr('allocated_storage', (props.storageGb as number) ?? 20),
        attr('username', usernameMap[engine] ?? 'dbadmin'),
        `password = var.db_password`,
        attr('multi_az', (props.multiAz as boolean) ?? false),
        attr('skip_final_snapshot', false),
        attr('storage_encrypted', true),
        attr('backup_retention_period', (props.backupRetentionDays as number) ?? 7),
        attr('deletion_protection', (props.deletionProtection as boolean) ?? false),
      ];
      if (licenseModel) attrs.push(attr('license_model', licenseModel));
      attrs.push('', tagsBlock(construct.id));

      return block('resource', ['aws_db_instance', id], indent(attrs.join('\n')));
    }

    case 'Database.DocumentDB': {
      const instances = (props.instances as number) ?? 1;

      const clusterBody = indent([
        attr('cluster_identifier', construct.id.toLowerCase()),
        attr('engine', 'docdb'),
        attr('master_username', 'docdbadmin'),
        `master_password = var.db_password`,
        attr('backup_retention_period', 7),
        attr('skip_final_snapshot', false),
        attr('storage_encrypted', true),
        attr('deletion_protection', (props.deletionProtection as boolean) ?? false),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const instanceBlocks = Array.from({ length: instances }, (_, i) =>
        block('resource', ['aws_docdb_cluster_instance', `${id}_instance_${i + 1}`], indent([
          attr('identifier', `${construct.id.toLowerCase()}-${i + 1}`),
          `cluster_id     = aws_docdb_cluster.${id}.id`,
          attr('instance_class', (props.instanceType as string) ?? 'db.t3.medium'),
        ].join('\n')))
      ).join('\n');

      return [block('resource', ['aws_docdb_cluster', id], clusterBody), instanceBlocks].join('\n');
    }

    case 'Database.DynamoDB': {
      const billingMode = (props.billingMode as string) ?? 'PAY_PER_REQUEST';
      const gsis = (props.globalSecondaryIndexes as Array<Record<string, unknown>>) ?? [];

      const gsiBlocks = gsis.map(g => indent([
        'global_secondary_index {',
        indent([
          attr('name', g.name as string),
          attr('hash_key', g.partitionKey as string),
          ...(g.sortKey ? [attr('range_key', g.sortKey as string)] : []),
          attr('projection_type', 'ALL'),
        ].join('\n')),
        '}',
      ].join('\n'))).join('\n');

      const body = indent([
        attr('name', construct.id),
        attr('billing_mode', billingMode),
        ...(billingMode === 'PROVISIONED' ? [
          attr('read_capacity', (props.readCapacity as number) ?? 5),
          attr('write_capacity', (props.writeCapacity as number) ?? 5),
        ] : []),
        attr('hash_key', props.partitionKey as string),
        ...(props.sortKey ? [attr('range_key', props.sortKey as string)] : []),
        `attribute {\n  name = "${hclString(props.partitionKey)}"\n  type = "S"\n}`,
        ...(props.sortKey ? [`attribute {\n  name = "${hclString(props.sortKey)}"\n  type = "S"\n}`] : []),
        ...gsis.map(g => `attribute {\n  name = "${hclString(g.partitionKey)}"\n  type = "S"\n}`),
        gsiBlocks,
        ...(props.ttlAttribute ? [`ttl {\n  attribute_name = "${hclString(props.ttlAttribute)}"\n  enabled        = true\n}`] : []),
        `point_in_time_recovery {\n  enabled = ${(props.pointInTimeRecovery as boolean) ?? true}\n}`,
        ...(props.streamEnabled ? [`stream_enabled   = true`, `stream_view_type = "NEW_AND_OLD_IMAGES"`] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_dynamodb_table', id], body);
    }

    // ── Cache ─────────────────────────────────────────────────────────────
    case 'Cache.Redis': {
      const numNodes = (props.numCacheNodes as number) ?? 1;
      const autoFailover = (props.automaticFailoverEnabled as boolean) ?? false;
      const body = indent([
        attr('replication_group_id', construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)),
        attr('description', `Redis ${construct.id}`),
        attr('node_type', CACHE_NODE_TYPE_MAP[(props.nodeType as string) ?? 'small'] ?? 'cache.t3.micro'),
        attr('num_cache_clusters', numNodes),
        attr('automatic_failover_enabled', autoFailover && numNodes > 1),
        attr('at_rest_encryption_enabled', (props.atRestEncryptionEnabled as boolean) ?? true),
        attr('transit_encryption_enabled', (props.transitEncryptionEnabled as boolean) ?? true),
        attr('engine_version', (props.version as string) ?? '7.0'),
        ...(props.subnetGroupName ? [attr('subnet_group_name', props.subnetGroupName as string)] : []),
        ...(props.securityGroupIds ? [`security_group_ids = ${JSON.stringify(props.securityGroupIds)}`] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_elasticache_replication_group', id], body);
    }

    case 'Cache.Memcached': {
      const body = indent([
        attr('cluster_id', construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)),
        attr('engine', 'memcached'),
        attr('node_type', CACHE_NODE_TYPE_MAP[(props.nodeType as string) ?? 'small'] ?? 'cache.t3.micro'),
        attr('num_cache_nodes', (props.numCacheNodes as number) ?? 2),
        ...(props.subnetGroupName ? [attr('subnet_group_name', props.subnetGroupName as string)] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_elasticache_cluster', id], body);
    }

    // ── Function ──────────────────────────────────────────────────────────
    case 'Function.Lambda': {
      const environment = props.environment as Record<string, string> | undefined;
      const runtimeMap: Record<string, string> = {
        'nodejs20': 'nodejs20.x', 'nodejs18': 'nodejs18.x',
        'python3.12': 'python3.12', 'python3.11': 'python3.11',
        'java21': 'java21', 'go1.x': 'go1.x', 'dotnet8': 'dotnet8',
      };

      const envBlock = environment && Object.keys(environment).length > 0
        ? '\n' + indent([
            'environment {',
            indent(`variables = {\n${Object.entries(environment).map(([k, v]) => `  ${k} = "${hclString(v)}"`).join('\n')}\n}`),
            '}',
          ].join('\n'))
        : '';

      const body = indent([
        attr('function_name', construct.id),
        attr('runtime', runtimeMap[(props.runtime as string) ?? 'nodejs20'] ?? 'nodejs20.x'),
        attr('handler', (props.handler as string) ?? 'index.handler'),
        attr('role', 'arn:aws:iam::ACCOUNT_ID:role/lambda-role'),
        `filename         = "function.zip"`,
        `source_code_hash = filebase64sha256("function.zip")`,
        ...(props.memory ? [attr('memory_size', props.memory as number)] : []),
        ...(props.timeout ? [attr('timeout', props.timeout as number)] : []),
        ...(props.reservedConcurrency !== undefined ? [attr('reserved_concurrent_executions', props.reservedConcurrency as number)] : []),
        envBlock,
        ...(props.vpcId ? [`vpc_config {\n  subnet_ids         = ${JSON.stringify((props.subnetIds as string[]) ?? [])}\n  security_group_ids = ${JSON.stringify((props.securityGroupIds as string[]) ?? [])}\n}`] : []),
        '',
        tagsBlock(construct.id),
      ].filter(l => l !== '').join('\n'));
      return block('resource', ['aws_lambda_function', id], body);
    }

    case 'Function.ApiGateway': {
      const apigwType = (props.type as string) ?? 'HTTP';
      const routes = (props.routes as Array<Record<string, unknown>>) ?? [];
      const stageName = (props.stageName as string) ?? '$default';

      const apiBody = indent([
        attr('name', props.name as string),
        attr('protocol_type', apigwType),
        ...(props.cors ? [`cors_configuration {\n  allow_origins = ["*"]\n  allow_methods = ["*"]\n  allow_headers = ["*"]\n}`] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const stageBody = indent([
        `api_id      = aws_apigatewayv2_api.${id}.id`,
        attr('name', stageName),
        attr('auto_deploy', true),
      ].join('\n'));

      const parts = [
        block('resource', ['aws_apigatewayv2_api', id], apiBody),
        block('resource', ['aws_apigatewayv2_stage', `${id}_stage`], stageBody),
      ];

      const authorizerLambdaId = props.authorizerLambdaId as string | undefined;
      if (authorizerLambdaId) {
        const authorizerBody = indent([
          `api_id           = aws_apigatewayv2_api.${id}.id`,
          attr('authorizer_type', 'REQUEST'),
          attr('name', `${(props.name as string)}-authorizer`),
          `authorizer_uri                    = aws_lambda_function.${authorizerLambdaId}.invoke_arn`,
          attr('authorizer_payload_format_version', '2.0'),
          `identity_sources = ["$request.header.Authorization"]`,
        ].join('\n'));
        parts.push(block('resource', ['aws_apigatewayv2_authorizer', `${id}_authorizer`], authorizerBody));
      }

      for (const r of routes) {
        const routeId = `${id}_${(r.method as string).toLowerCase()}_${(r.path as string).replace(/[^a-zA-Z0-9]/g, '_')}`;
        const routeBody = indent([
          `api_id    = aws_apigatewayv2_api.${id}.id`,
          attr('route_key', `${r.method} ${r.path}`),
          ...(r.lambdaId ? [`target    = "integrations/\${aws_apigatewayv2_integration.${routeId}_integ.id}"`] : []),
          ...(authorizerLambdaId ? [
            attr('authorization_type', 'CUSTOM'),
            `authorizer_id      = aws_apigatewayv2_authorizer.${id}_authorizer.id`,
          ] : []),
        ].join('\n'));
        parts.push(block('resource', ['aws_apigatewayv2_route', routeId], routeBody));

        if (r.lambdaId) {
          const integBody = indent([
            `api_id             = aws_apigatewayv2_api.${id}.id`,
            attr('integration_type', 'AWS_PROXY'),
            `integration_uri    = aws_lambda_function.${r.lambdaId}.invoke_arn`,
            attr('payload_format_version', '2.0'),
          ].join('\n'));
          parts.push(block('resource', ['aws_apigatewayv2_integration', `${routeId}_integ`], integBody));
        }
      }

      return parts.join('\n');
    }

    // ── Policy ────────────────────────────────────────────────────────────
    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachType = props.attachType as string;
      const attachTo = (props.attachTo as string).replace(/[^a-zA-Z0-9_]/g, '_');
      const principalService = attachType === 'lambda' ? 'lambda.amazonaws.com' : 'ec2.amazonaws.com';

      const policyStmts = statements.map(s => {
        const actions = (s.actions as string[]).map(a => `"${hclString(a)}"`).join(', ');
        const resources = ((s.resources as string[]) ?? ['*']).map(r => `"${hclString(r)}"`).join(', ');
        return `    {\n      "Effect": "${hclString(s.effect)}",\n      "Action": [${actions}],\n      "Resource": [${resources}]\n    }`;
      }).join(',\n');

      const roleBody = indent([
        attr('name', `${attachTo}-role`),
        `assume_role_policy = jsonencode({\n  Version = "2012-10-17"\n  Statement = [{\n    Effect    = "Allow"\n    Principal = { Service = "${principalService}" }\n    Action    = "sts:AssumeRole"\n  }]\n})`,
        '',
        tagsBlock(`${attachTo}-role`),
      ].join('\n'));

      const policyBody = indent([
        attr('name', `${id}-policy`),
        `policy = jsonencode({\n  Version = "2012-10-17"\n  Statement = [\n${policyStmts}\n  ]\n})`,
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
        parts.push(block('resource', ['aws_iam_instance_profile', `${id}_profile`], indent([
          attr('name', `${attachTo}-profile`),
          `role = aws_iam_role.${id}_role.name`,
        ].join('\n'))));
      }

      return parts.join('\n');
    }

    // ── Events ────────────────────────────────────────────────────────────
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
          `event_bus_name = "${hclString(busName)}"`,
          `event_pattern  = jsonencode(${JSON.stringify(pattern)})`,
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

    // ── Workflow ──────────────────────────────────────────────────────────
    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const definition = {
        Comment: (props.description as string) ?? `Workflow ${construct.id}`,
        StartAt: (steps[0]?.name as string) ?? 'Start',
        States: Object.fromEntries(steps.map((s, i) => [s.name as string, {
          Type: (s.type as string) ?? 'Task',
          Resource: (s.resource as string) ?? '',
          ...(i < steps.length - 1 ? { Next: steps[i + 1].name as string } : { End: true }),
        }])),
      };
      const body = indent([
        attr('name', construct.id),
        attr('type', (props.type as string) ?? 'STANDARD'),
        `definition   = jsonencode(${JSON.stringify(definition)})`,
        attr('role_arn', 'arn:aws:iam::ACCOUNT_ID:role/StepFunctionsExecutionRole'),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_sfn_state_machine', id], body);
    }

    // ── Messaging ─────────────────────────────────────────────────────────
    case 'Messaging.Queue': {
      const fifo = (props.fifo as boolean) ?? false;
      const body = indent([
        attr('name', fifo ? `${construct.id}.fifo` : construct.id),
        attr('visibility_timeout_seconds', (props.visibilityTimeoutSeconds as number) ?? 30),
        attr('message_retention_seconds', (props.messageRetentionSeconds as number) ?? 345600),
        attr('delay_seconds', (props.delaySeconds as number) ?? 0),
        attr('fifo_queue', fifo),
        attr('sqs_managed_sse_enabled', (props.encrypted as boolean) ?? true),
        ...(props.dlqArn ? [`redrive_policy = jsonencode({\n  deadLetterTargetArn = "${hclString(props.dlqArn)}"\n  maxReceiveCount     = ${(props.maxReceiveCount as number) ?? 3}\n})`] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_sqs_queue', id], body);
    }

    case 'Messaging.Topic': {
      const fifo = (props.fifo as boolean) ?? false;
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];

      const topicBody = indent([
        attr('name', fifo ? `${construct.id}.fifo` : construct.id),
        attr('display_name', (props.displayName as string) ?? construct.id),
        attr('fifo_topic', fifo),
        ...(props.encrypted ? [attr('kms_master_key_id', 'alias/aws/sns')] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const subBlocks = subscriptions.map((s, i) =>
        block('resource', ['aws_sns_topic_subscription', `${id}_sub_${i}`], indent([
          `topic_arn = aws_sns_topic.${id}.arn`,
          attr('protocol', s.protocol),
          attr('endpoint', s.endpoint),
        ].join('\n')))
      ).join('\n');

      return [block('resource', ['aws_sns_topic', id], topicBody), subBlocks].filter(Boolean).join('\n');
    }

    // ── Secret / Certificate ──────────────────────────────────────────────
    case 'Secret.Vault': {
      const body = indent([
        attr('name', construct.id),
        attr('description', (props.description as string) ?? `Secret ${construct.id}`),
        ...(props.kmsKeyId ? [attr('kms_key_id', props.kmsKeyId as string)] : []),
        ...(props.rotationDays ? [`rotation_rules {\n  automatically_after_days = ${props.rotationDays}\n}`] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_secretsmanager_secret', id], body);
    }

    case 'Certificate.TLS': {
      const sans = (props.subjectAlternativeNames as string[]) ?? [];
      const body = indent([
        attr('domain_name', props.domainName as string),
        attr('validation_method', (props.validationMethod as string) ?? 'DNS'),
        ...(sans.length > 0 ? [`subject_alternative_names = ${JSON.stringify(sans)}`] : []),
        `lifecycle {\n  create_before_destroy = true\n}`,
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_acm_certificate', id], body);
    }

    // ── Monitoring ────────────────────────────────────────────────────────
    case 'Monitoring.Alarm': {
      const dimensions = props.dimensions as Record<string, string> | undefined;
      const dimBlock = dimensions
        ? `dimensions = {\n${Object.entries(dimensions).map(([k, v]) => `  ${k} = "${hclString(v)}"`).join('\n')}\n}`
        : '';

      const body = indent([
        attr('alarm_name', construct.id),
        attr('metric_name', props.metricName as string),
        attr('namespace', (props.namespace as string) ?? 'AWS/Lambda'),
        attr('threshold', props.threshold as number),
        attr('evaluation_periods', (props.evaluationPeriods as number) ?? 2),
        attr('period', (props.periodSeconds as number) ?? 60),
        attr('comparison_operator', (props.comparisonOperator as string) ?? 'GreaterThanThreshold'),
        attr('statistic', (props.statistic as string) ?? 'Average'),
        attr('treat_missing_data', (props.treatMissingData as string) ?? 'notBreaching'),
        ...(props.alarmActions ? [`alarm_actions = ${JSON.stringify(props.alarmActions)}`] : []),
        ...(props.okActions ? [`ok_actions = ${JSON.stringify(props.okActions)}`] : []),
        dimBlock,
      ].filter(Boolean).join('\n'));
      return block('resource', ['aws_cloudwatch_metric_alarm', id], body);
    }

    case 'Monitoring.Dashboard': {
      const widgets = (props.widgets as Array<Record<string, unknown>>) ?? [];
      const dashBody = {
        widgets: widgets.map((w, i) => ({
          type: w.type === 'text' ? 'text' : 'metric',
          x: (i % 3) * 8, y: Math.floor(i / 3) * 6, width: 8, height: 6,
          properties: w.type === 'text'
            ? { markdown: w.markdown ?? w.title }
            : { title: w.title, metrics: [[(w.namespace as string) ?? 'AWS/Lambda', w.metricName]], period: (w.period as number) ?? 60, stat: (w.stat as string) ?? 'Average', view: 'timeSeries' },
        })),
      };
      const body = indent([
        attr('dashboard_name', construct.id),
        `dashboard_body = jsonencode(${JSON.stringify(dashBody)})`,
      ].join('\n'));
      return block('resource', ['aws_cloudwatch_dashboard', id], body);
    }

    case 'Logging.Stream': {
      const filters = (props.subscriptionFilters as Array<Record<string, unknown>>) ?? [];
      const lgBody = indent([
        attr('name', `/iacmp/${construct.id}`),
        attr('retention_in_days', (props.retentionDays as number) ?? 30),
        ...(props.kmsKeyId ? [attr('kms_key_id', props.kmsKeyId as string)] : []),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const parts = [block('resource', ['aws_cloudwatch_log_group', id], lgBody)];

      for (const f of filters) {
        const filterId = `${id}_${(f.name as string).replace(/[^a-zA-Z0-9_]/g, '_')}_filter`;
        const filterBody = indent([
          `log_group_name  = aws_cloudwatch_log_group.${id}.name`,
          attr('name', f.name as string),
          attr('filter_pattern', f.filterPattern as string),
          attr('destination_arn', f.destinationArn as string),
        ].join('\n'));
        parts.push(block('resource', ['aws_cloudwatch_log_subscription_filter', filterId], filterBody));
      }

      return parts.join('\n');
    }

    case 'Custom.Resource': {
      const tf = props.terraform as { type: string; body: Record<string, unknown> } | undefined;
      if (!tf) return '';
      const body = indent(Object.entries(tf.body).map(([k, v]) => `${k} = ${hclValue(v)}`).join('\n'));
      return block('resource', [tf.type, id], body);
    }

    default:
      console.warn(`[terraform] Construct type '${construct.type}' nao suportado — descartado.`);
      return '';
  }
}

export function synthesize(stack: Stack): string {
  const awsBlock = block('aws', [], indent(`source  = "hashicorp/aws"\nversion = "~> 5.0"`));
  const requiredProvidersBlock = block('required_providers', [], indent(awsBlock));
  const terraformBlock = block('terraform', [], indent(requiredProvidersBlock));
  const providerBlock = block('provider', ['aws'], indent(attr('region', 'us-east-1')));

  const needsDbPassword = stack.constructs.some(
    c => c.type === 'Database.SQL' || c.type === 'Database.DocumentDB',
  );
  const dbPasswordVar = needsDbPassword
    ? block('variable', ['db_password'], indent([
        'type        = string',
        'sensitive   = true',
        attr('description', 'Senha do administrador do banco de dados (Database.SQL/DocumentDB). Forneca via TF_VAR_db_password ou tfvars.'),
      ].join('\n')))
    : '';

  const header = [terraformBlock, providerBlock, dbPasswordVar].filter(Boolean).join('\n');

  const resources = stack.constructs
    .map(c => synthesizeConstruct(c))
    .filter(Boolean)
    .join('\n');

  return [header, resources].filter(Boolean).join('\n');
}
