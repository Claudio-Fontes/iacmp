import { Stack, BaseConstruct } from '@iacmp/core';

const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 'e2-small',
  medium: 'e2-medium',
  large: 'e2-standard-4',
};

const GCP_IMAGE_MAP: Record<string, string> = {
  'ubuntu': 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts',
  'ubuntu-22.04': 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts',
  'ubuntu-20.04': 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2004-lts',
  'windows-2022': 'projects/windows-cloud/global/images/family/windows-2022',
  'windows-2019': 'projects/windows-cloud/global/images/family/windows-2019',
};

const CACHE_TIER_MAP: Record<string, string> = {
  small: 'BASIC',
  medium: 'STANDARD_HA',
  large: 'STANDARD_HA',
};

const CACHE_CAPACITY_MAP: Record<string, number> = {
  small: 1,
  medium: 5,
  large: 16,
};

const K8S_MACHINE_MAP: Record<string, string> = {
  small: 'e2-medium',
  medium: 'e2-standard-4',
  large: 'n2-standard-8',
};

const RUNTIME_MAP: Record<string, string> = {
  'nodejs20': 'nodejs20',
  'nodejs18': 'nodejs18',
  'python3.12': 'python312',
  'python3.11': 'python311',
  'java21': 'java21',
  'go1.x': 'go121',
  'dotnet8': 'dotnet8',
};

export function toTfId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

function resolveGcpImage(image: string | undefined): string {
  if (!image) return 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts';
  return GCP_IMAGE_MAP[image] ?? `global/images/${image}`;
}

function gcpRegion(regionOrZone?: string): string {
  if (!regionOrZone) return '${var.gcp_region}';
  const parts = regionOrZone.split('-');
  if (parts.length >= 3 && /^[a-z]$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('-');
  }
  return regionOrZone;
}

interface TFOutput {
  resources: Record<string, Record<string, unknown>>;
  outputs: Record<string, { value: string }>;
  needsZoneVar: boolean;
}

function addResource(
  resources: Record<string, Record<string, unknown>>,
  tfType: string,
  tfId: string,
  props: Record<string, unknown>,
): void {
  if (!resources[tfType]) resources[tfType] = {};
  resources[tfType][tfId] = props;
}

function synthesizeConstruct(construct: BaseConstruct, ctx: TFOutput): void {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Compute.Instance': {
      ctx.needsZoneVar = true;
      addResource(r, 'google_compute_instance', id, {
        name: construct.id,
        machine_type: INSTANCE_TYPE_MAP[(props.instanceType as string) ?? 'small'] ?? 'e2-small',
        zone: '${var.gcp_zone}',
        boot_disk: [{ initialize_params: [{ image: resolveGcpImage(props.image as string) }] }],
        network_interface: [{ network: 'default' }],
      });
      break;
    }

    case 'Compute.AutoScaling': {
      ctx.needsZoneVar = true;
      const machineType = INSTANCE_TYPE_MAP[(props.instanceType as string) ?? 'small'] ?? 'e2-small';
      const templateId = `${id}_template`;
      addResource(r, 'google_compute_instance_template', templateId, {
        name: `${construct.id}-template`,
        machine_type: machineType,
        disk: [{ source_image: resolveGcpImage(props.image as string) }],
        network_interface: [{ network: 'default' }],
      });
      addResource(r, 'google_compute_region_instance_group_manager', id, {
        name: construct.id,
        base_instance_name: construct.id,
        region: '${var.gcp_region}',
        version: [{ instance_template: `\${google_compute_instance_template.${templateId}.id}` }],
        target_size: (props.desiredCapacity as number) ?? (props.minCapacity as number) ?? 1,
      });
      if (props.minCapacity !== undefined || props.targetCpuUtilization) {
        const autoscalerId = `${id}_autoscaler`;
        addResource(r, 'google_compute_region_autoscaler', autoscalerId, {
          name: `${construct.id}-autoscaler`,
          region: '${var.gcp_region}',
          target: `\${google_compute_region_instance_group_manager.${id}.id}`,
          autoscaling_policy: [{
            min_replicas: (props.minCapacity as number) ?? 1,
            max_replicas: (props.maxCapacity as number) ?? 10,
            cooldown_period: 60,
            ...(props.targetCpuUtilization ? {
              cpu_utilization: [{ target: (props.targetCpuUtilization as number) / 100 }],
            } : {}),
          }],
        });
      }
      break;
    }

    case 'Compute.Container': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const envVars = Object.entries(environment).map(([k, v]) => ({ name: k, value: v }));
      addResource(r, 'google_cloud_run_v2_service', id, {
        name: construct.id,
        location: '${var.gcp_region}',
        template: [{
          containers: [{
            image: props.image as string,
            resources: [{ limits: { cpu: String(Math.round(((props.cpu as number) ?? 256) / 1000) || 1), memory: `${(props.memory as number) ?? 512}Mi` } }],
            ports: props.port ? [{ container_port: props.port }] : [],
            env: envVars,
          }],
          scaling: [{
            min_instance_count: (props.minInstances as number) ?? 0,
            max_instance_count: (props.desiredCount as number) ?? 10,
          }],
        }],
        ingress: (props.publicIp as boolean) ? 'INGRESS_TRAFFIC_ALL' : 'INGRESS_TRAFFIC_INTERNAL_ONLY',
      });
      break;
    }

    case 'Compute.Kubernetes': {
      const machineType = K8S_MACHINE_MAP[(props.nodeInstanceType as string) ?? 'medium'] ?? 'e2-standard-4';
      const clusterProps: Record<string, unknown> = {
        name: construct.id,
        location: '${var.gcp_region}',
        initial_node_count: (props.desiredNodes as number) ?? 2,
        node_config: [{ machine_type: machineType }],
        enable_autopilot: false,
      };
      if (props.privateCluster) {
        clusterProps.private_cluster_config = [{
          enable_private_nodes: true,
          enable_private_endpoint: false,
          master_ipv4_cidr_block: '172.16.0.32/28',
        }];
      }
      addResource(r, 'google_container_cluster', id, clusterProps);
      break;
    }

    case 'Storage.Bucket': {
      const lifecycleRules = (props.lifecycleRules as Array<Record<string, unknown>>) ?? [];
      const tfRules: Array<Record<string, unknown>> = [];
      for (const lr of lifecycleRules) {
        const prefixCond = lr.prefix ? { with_state: 'ANY', matches_prefix: [lr.prefix as string] } : {};
        if (lr.transitionToGlacierDays) {
          tfRules.push({
            action: [{ type: 'SetStorageClass', storage_class: 'ARCHIVE' }],
            condition: [{ age: lr.transitionToGlacierDays as number, ...prefixCond }],
          });
        }
        if (lr.expireAfterDays) {
          tfRules.push({
            action: [{ type: 'Delete' }],
            condition: [{ age: lr.expireAfterDays as number, ...prefixCond }],
          });
        }
      }
      addResource(r, 'google_storage_bucket', id, {
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        location: (props.location as string) ?? 'US',
        versioning: [{ enabled: (props.versioning as boolean) ?? false }],
        uniform_bucket_level_access: !(props.publicAccess as boolean),
        ...(tfRules.length > 0 ? { lifecycle_rule: tfRules } : {}),
      });
      ctx.outputs[`${construct.id}BucketName`] = { value: `\${google_storage_bucket.${id}.name}` };
      ctx.outputs[`${construct.id}BucketUrl`] = { value: `\${google_storage_bucket.${id}.url}` };
      break;
    }

    case 'Storage.FileSystem': {
      addResource(r, 'google_filestore_instance', id, {
        name: construct.id,
        location: '${var.gcp_region}-a',
        tier: 'STANDARD',
        networks: [{ network: 'default', modes: ['MODE_IPV4'] }],
        file_shares: [{ name: construct.id, capacity_gb: 1024 }],
      });
      break;
    }

    case 'Storage.Archive': {
      const archiveRules: Array<Record<string, unknown>> = [];
      if (props.retentionDays) {
        archiveRules.push({
          action: [{ type: 'Delete' }],
          condition: [{ age: props.retentionDays as number }],
        });
      }
      addResource(r, 'google_storage_bucket', id, {
        name: `${construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-archive`,
        location: 'US',
        storage_class: 'ARCHIVE',
        uniform_bucket_level_access: true,
        ...(archiveRules.length > 0 ? { lifecycle_rule: archiveRules } : {}),
      });
      break;
    }

    case 'Network.VPC': {
      addResource(r, 'google_compute_network', id, {
        name: construct.id,
        auto_create_subnetworks: false,
        routing_mode: 'REGIONAL',
      });
      break;
    }

    case 'Network.Subnet': {
      const vpcId = props.vpcId as string | undefined;
      let networkRef: string;
      if (vpcId && r['google_compute_network'] && r['google_compute_network'][toTfId(vpcId)]) {
        networkRef = `\${google_compute_network.${toTfId(vpcId)}.id}`;
      } else {
        networkRef = vpcId ?? 'default';
      }
      addResource(r, 'google_compute_subnetwork', id, {
        name: construct.id,
        network: networkRef,
        ip_cidr_range: props.cidr as string,
        region: '${var.gcp_region}',
        private_ip_google_access: !(props.public as boolean),
      });
      break;
    }

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];
      const vpcId = props.vpcId as string | undefined;
      let networkRef: string;
      if (vpcId && r['google_compute_network'] && r['google_compute_network'][toTfId(vpcId)]) {
        networkRef = `\${google_compute_network.${toTfId(vpcId)}.id}`;
      } else {
        networkRef = vpcId ?? 'default';
      }

      ingress.forEach((rule, i) => {
        if (rule.cidr === undefined) {
          console.warn(`[gcp] Security group rule sem CIDR; usando 0.0.0.0/0 — defina props.cidr explicitamente (${construct.id} ingress[${i}])`);
        }
        const fwId = `${id}_ingress_${i}`;
        const protocol = (rule.protocol as string) === '-1' ? 'all' : rule.protocol as string;
        const allow: Record<string, unknown> = { protocol };
        if (protocol !== 'all') {
          allow.ports = rule.fromPort === rule.toPort
            ? [`${rule.fromPort}`]
            : [`${rule.fromPort}-${rule.toPort}`];
        }
        addResource(r, 'google_compute_firewall', fwId, {
          name: `${construct.id}-ingress-${i}`,
          network: networkRef,
          direction: 'INGRESS',
          priority: 1000 + i,
          allow: [allow],
          source_ranges: [(rule.cidr as string) ?? '0.0.0.0/0'],
        });
      });

      const egressList = egress.length > 0 ? egress : [
        { protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' },
      ];
      egressList.forEach((rule, i) => {
        const fwId = `${id}_egress_${i}`;
        const protocol = (rule.protocol as string) === '-1' ? 'all' : rule.protocol as string;
        const allow: Record<string, unknown> = { protocol };
        if (protocol !== 'all' && rule.fromPort !== 0) {
          allow.ports = rule.fromPort === rule.toPort
            ? [`${rule.fromPort}`]
            : [`${rule.fromPort}-${rule.toPort}`];
        }
        addResource(r, 'google_compute_firewall', fwId, {
          name: `${construct.id}-egress-${i}`,
          network: networkRef,
          direction: 'EGRESS',
          priority: 1000 + i,
          allow: [allow],
          destination_ranges: [(rule.cidr as string) ?? '0.0.0.0/0'],
        });
      });
      break;
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const securityRules = rules.map((rule, i) => ({
        priority: (rule.priority as number) ?? (i + 1),
        action: (rule.action as string) ?? 'allow',
        match: rule.managedGroup
          ? { expr: [{ expression: 'evaluatePreconfiguredExpr("sqli-stable")' }] }
          : { versioned_expr: 'SRC_IPS_V1', config: [{ src_ip_ranges: (rule.sourceIps as string[]) ?? ['*'] }] },
        description: (rule.description as string) ?? '',
      }));
      addResource(r, 'google_compute_security_policy', id, {
        name: construct.id,
        rule: [
          ...securityRules,
          {
            priority: 2147483647,
            action: (props.defaultAction as string) ?? 'allow',
            match: { versioned_expr: 'SRC_IPS_V1', config: [{ src_ip_ranges: ['*'] }] },
            description: 'Default rule',
          },
        ],
      });
      break;
    }

    case 'Network.LoadBalancer': {
      const lbType = (props.type as string) ?? 'application';
      addResource(r, 'google_compute_backend_service', `${id}_backend`, {
        name: `${construct.id}-backend`,
        protocol: lbType === 'network' ? 'TCP' : 'HTTP',
        load_balancing_scheme: (props.scheme as string) === 'internal' ? 'INTERNAL' : 'EXTERNAL',
      });
      if (lbType === 'application') {
        addResource(r, 'google_compute_url_map', `${id}_url_map`, {
          name: `${construct.id}-url-map`,
          default_service: `\${google_compute_backend_service.${id}_backend.id}`,
        });
        addResource(r, 'google_compute_target_http_proxy', `${id}_http_proxy`, {
          name: `${construct.id}-http-proxy`,
          url_map: `\${google_compute_url_map.${id}_url_map.id}`,
        });
        addResource(r, 'google_compute_global_forwarding_rule', `${id}_forwarding_rule`, {
          name: `${construct.id}-forwarding-rule`,
          target: `\${google_compute_target_http_proxy.${id}_http_proxy.id}`,
          port_range: '80',
          load_balancing_scheme: 'EXTERNAL',
        });
      }
      break;
    }

    case 'Network.CDN': {
      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      const bucketName = (origins[0]?.bucketName as string) ?? (origins[0]?.domainName as string) ?? construct.id;
      addResource(r, 'google_compute_backend_bucket', `${id}_backend_bucket`, {
        name: `${construct.id}-backend-bucket`,
        bucket_name: bucketName,
        enable_cdn: true,
      });
      addResource(r, 'google_compute_url_map', `${id}_url_map`, {
        name: `${construct.id}-url-map`,
        default_service: `\${google_compute_backend_bucket.${id}_backend_bucket.id}`,
      });
      break;
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const zoneName = (props.zoneName as string).replace(/\./g, '-').replace(/-+$/, '');
      const zoneId = toTfId(`${zoneName}_zone`);
      addResource(r, 'google_dns_managed_zone', zoneId, {
        name: `${zoneName}-zone`,
        dns_name: `${props.zoneName as string}.`,
        visibility: 'public',
      });
      if (records.length > 0) {
        const recId = toTfId(`${zoneName}_records`);
        addResource(r, 'google_dns_record_set', recId, {
          name: `${(records[0].name as string)}.`,
          managed_zone: `\${google_dns_managed_zone.${zoneId}.name}`,
          type: records[0].type as string,
          ttl: (records[0].ttl as number) ?? 300,
          rrdatas: records[0].values as string[],
        });
      }
      break;
    }

    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const edition = (props.edition as string) ?? '';
      const dbVersionMap: Record<string, string> = {
        mysql: 'MYSQL_8_0',
        postgres: 'POSTGRES_15',
        mariadb: 'MYSQL_8_0',
        sqlserver: `SQLSERVER_2019_${(edition || 'EXPRESS').toUpperCase()}`,
        oracle: 'POSTGRES_15',
      };
      const dbVersion = dbVersionMap[engine] ?? 'MYSQL_8_0';
      addResource(r, 'google_sql_database_instance', id, {
        name: construct.id,
        database_version: dbVersion,
        region: '${var.gcp_region}',
        settings: [{
          tier: (props.instanceType as string) ?? 'db-f1-micro',
          backup_configuration: [{ enabled: true }],
          availability_type: (props.multiAz as boolean) ? 'REGIONAL' : 'ZONAL',
        }],
        deletion_protection: false,
      });
      ctx.outputs[`${construct.id}ConnectionName`] = { value: `\${google_sql_database_instance.${id}.connection_name}` };
      break;
    }

    case 'Database.DocumentDB': {
      addResource(r, 'google_firestore_database', id, {
        project: '${var.project_id}',
        name: '(default)',
        location_id: '${var.gcp_region}',
        type: 'FIRESTORE_NATIVE',
        deletion_policy: (props.deletionProtection as boolean)
          ? 'DELETE_PROTECTION_ENABLED'
          : 'DELETE_PROTECTION_DISABLED',
      });
      break;
    }

    case 'Database.DynamoDB': {
      addResource(r, 'google_bigtable_instance', id, {
        name: construct.id.toLowerCase(),
        cluster: [{
          cluster_id: 'cluster-1',
          zone: '${var.gcp_zone}',
          num_nodes: 1,
          storage_type: 'SSD',
        }],
        instance_type: 'PRODUCTION',
        display_name: construct.id,
      });
      ctx.needsZoneVar = true;
      break;
    }

    case 'Cache.Redis': {
      const nodeType = (props.nodeType as string) ?? 'small';
      addResource(r, 'google_redis_instance', id, {
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        tier: CACHE_TIER_MAP[nodeType] ?? 'BASIC',
        memory_size_gb: CACHE_CAPACITY_MAP[nodeType] ?? 1,
        region: '${var.gcp_region}',
        redis_version: 'REDIS_7_0',
        auth_enabled: true,
        transit_encryption_mode: 'SERVER_AUTHENTICATION',
      });
      ctx.outputs[`${construct.id}RedisHost`] = { value: `\${google_redis_instance.${id}.host}` };
      ctx.outputs[`${construct.id}RedisPort`] = { value: `\${google_redis_instance.${id}.port}` };
      break;
    }

    case 'Cache.Memcached': {
      addResource(r, 'google_memcache_instance', id, {
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        region: '${var.gcp_region}',
        node_count: (props.numCacheNodes as number) ?? 2,
        node_config: [{ cpu_count: 1, memory_size_mb: 1024 }],
      });
      break;
    }

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
      break;
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
      break;
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
      break;
    }

    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const busName = props.busName as string | undefined;
      if (busName && busName !== 'default') {
        const busId = toTfId(busName);
        addResource(r, 'google_pubsub_topic', busId, {
          name: busName,
          message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
        });
      }
      for (const rule of rules) {
        const topicName = `${construct.id}-${(rule.name as string) ?? 'rule'}`;
        const topicId = toTfId(topicName);
        addResource(r, 'google_pubsub_topic', topicId, {
          name: topicName,
          message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
        });
        if (rule.targetArn) {
          addResource(r, 'google_pubsub_subscription', `${topicId}_sub`, {
            name: `${topicName}-sub`,
            topic: `\${google_pubsub_topic.${topicId}.id}`,
            push_config: [{ push_endpoint: rule.targetArn as string }],
            ack_deadline_seconds: 30,
          });
        }
      }
      break;
    }

    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const definition = {
        main: {
          steps: steps.map((s) => ({
            [s.name as string]: {
              call: 'http.post',
              args: { url: (s.resource as string) ?? '' },
            },
          })),
        },
      };
      addResource(r, 'google_workflows_workflow', id, {
        name: construct.id,
        region: '${var.gcp_region}',
        source_contents: JSON.stringify(definition, null, 2),
      });
      break;
    }

    case 'Messaging.Queue': {
      addResource(r, 'google_pubsub_topic', id, {
        name: construct.id,
        message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
      });
      addResource(r, 'google_pubsub_subscription', `${id}_sub`, {
        name: `${construct.id}-sub`,
        topic: `\${google_pubsub_topic.${id}.id}`,
        ack_deadline_seconds: (props.visibilityTimeoutSeconds as number) ?? 30,
        message_retention_duration: `${(props.messageRetentionSeconds as number) ?? 345600}s`,
      });
      break;
    }

    case 'Messaging.Topic': {
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];
      addResource(r, 'google_pubsub_topic', id, {
        name: construct.id,
        message_storage_policy: [{ allowed_persistence_regions: ['${var.gcp_region}'] }],
      });
      subscriptions.forEach((s, i) => {
        const subProps: Record<string, unknown> = {
          name: `${construct.id}-sub-${i}`,
          topic: `\${google_pubsub_topic.${id}.id}`,
          ack_deadline_seconds: 30,
        };
        if (s.protocol === 'https' || s.protocol === 'http') {
          subProps.push_config = [{ push_endpoint: s.endpoint }];
        }
        addResource(r, 'google_pubsub_subscription', `${id}_sub_${i}`, subProps);
      });
      break;
    }

    case 'Secret.Vault': {
      const secretId = construct.id.replace(/[^a-zA-Z0-9_-]/g, '-');
      addResource(r, 'google_secret_manager_secret', id, {
        secret_id: secretId,
        replication: [{ auto: [{}] }],
      });
      ctx.outputs[`${construct.id}SecretName`] = { value: `\${google_secret_manager_secret.${id}.secret_id}` };
      break;
    }

    case 'Certificate.TLS': {
      const sans = (props.subjectAlternativeNames as string[]) ?? [];
      addResource(r, 'google_certificate_manager_certificate', id, {
        name: construct.id.replace(/[^a-zA-Z0-9-]/g, '-'),
        managed: [{ domains: [props.domainName as string, ...sans] }],
      });
      break;
    }

    case 'Monitoring.Alarm': {
      const dimensions = props.dimensions as Record<string, string> | undefined;
      const operatorMap: Record<string, string> = {
        GreaterThanThreshold: 'COMPARISON_GT',
        LessThanThreshold: 'COMPARISON_LT',
        GreaterThanOrEqualToThreshold: 'COMPARISON_GE',
        LessThanOrEqualToThreshold: 'COMPARISON_LE',
      };
      const dimFilter = dimensions
        ? Object.entries(dimensions).map(([k, v]) => `metric.labels.${k}="${v}"`).join(' AND ')
        : '';
      const filter = [
        `metric.type="cloudfunctions.googleapis.com/function/${props.metricName}"`,
        dimFilter,
      ].filter(Boolean).join(' AND ');

      addResource(r, 'google_monitoring_alert_policy', id, {
        display_name: construct.id,
        conditions: [{
          display_name: `${props.metricName} condition`,
          condition_threshold: [{
            filter,
            comparison: operatorMap[(props.comparisonOperator as string) ?? 'GreaterThanThreshold'] ?? 'COMPARISON_GT',
            threshold_value: props.threshold as number,
            duration: `${((props.periodSeconds as number) ?? 60) * ((props.evaluationPeriods as number) ?? 2)}s`,
            aggregations: [{
              alignment_period: `${(props.periodSeconds as number) ?? 60}s`,
              per_series_aligner: 'ALIGN_MEAN',
            }],
          }],
        }],
        combiner: 'OR',
        enabled: true,
        notification_channels: (props.alarmActions as string[]) ?? [],
      });
      break;
    }

    case 'Monitoring.Dashboard': {
      const widgets = (props.widgets as Array<Record<string, unknown>>) ?? [];
      const dashboardJson = JSON.stringify({
        displayName: construct.id,
        gridLayout: {
          columns: 3,
          widgets: widgets.map(w => ({
            title: w.title as string,
          })),
        },
      });
      addResource(r, 'google_monitoring_dashboard', id, {
        dashboard_json: dashboardJson,
      });
      break;
    }

    case 'Logging.Stream': {
      const filters = (props.subscriptionFilters as Array<Record<string, unknown>>) ?? [];
      const bucketId = construct.id.replace(/[^a-zA-Z0-9_-]/g, '-');
      addResource(r, 'google_logging_project_bucket_config', id, {
        project: '${var.project_id}',
        location: '${var.gcp_region}',
        bucket_id: bucketId,
        retention_days: (props.retentionDays as number) ?? 30,
      });
      for (const f of filters) {
        const sinkId = toTfId(`${construct.id}_sink_${f.name}`);
        addResource(r, 'google_logging_project_sink', sinkId, {
          name: `${construct.id}-sink-${(f.name as string).replace(/[^a-zA-Z0-9-]/g, '-')}`,
          destination: (f.destinationArn as string) ?? '',
          filter: f.filterPattern as string,
        });
      }
      break;
    }

    case 'Custom.Resource': {
      const tf = props.terraform as { type: string; name: string; properties: Record<string, unknown> } | undefined;
      if (!tf) return;
      const customId = toTfId(tf.name ?? construct.id);
      addResource(r, tf.type, customId, tf.properties);
      break;
    }

    default:
      console.warn(`[gcp] Construct type '${construct.type}' nao suportado — descartado.`);
  }
}

export function emitGCPTerraform(stack: Stack): string {
  const ctx: TFOutput = {
    resources: {},
    outputs: {},
    needsZoneVar: false,
  };

  for (const construct of stack.constructs) {
    synthesizeConstruct(construct, ctx);
  }

  const variables: Record<string, unknown> = {
    project_id: { type: 'string' },
    gcp_region: { type: 'string', default: 'us-central1' },
  };

  if (ctx.needsZoneVar) {
    variables.gcp_zone = { type: 'string', default: 'us-central1-a' };
  }

  const tfJson: Record<string, unknown> = {
    terraform: {
      required_providers: {
        google: { source: 'hashicorp/google', version: '~> 5.0' },
      },
    },
    provider: {
      google: {
        project: '${var.project_id}',
        region: '${var.gcp_region}',
      },
    },
    variable: variables,
  };

  if (Object.keys(ctx.resources).length > 0) {
    tfJson.resource = ctx.resources;
  }

  if (Object.keys(ctx.outputs).length > 0) {
    tfJson.output = ctx.outputs;
  }

  return JSON.stringify(tfJson, null, 2) + '\n';
}
