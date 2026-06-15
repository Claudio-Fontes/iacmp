import { Stack, BaseConstruct } from '@iacmp/core';

export interface GCPResource {
  name: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface GCPDeployment {
  resources: GCPResource[];
}

const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 'e2-small',
  medium: 'e2-medium',
  large: 'e2-standard-4',
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

function gcpRegion(regionOrZone: string | undefined): string {
  if (!regionOrZone) return 'us-central1';
  const parts = regionOrZone.split('-');
  if (parts.length >= 3 && parts[parts.length - 1].match(/^[a-z]$/)) {
    return parts.slice(0, -1).join('-');
  }
  return regionOrZone;
}

function synthesizeConstruct(construct: BaseConstruct): GCPResource[] {
  const props = construct.props as Record<string, unknown>;
  const zone = (props.region as string) ?? 'us-central1-a';
  const region = gcpRegion(props.region as string);

  switch (construct.type) {

    // ── Compute ──────────────────────────────────────────────────────────
    case 'Compute.Instance':
      return [{
        name: construct.id,
        type: 'compute.v1.instance',
        properties: {
          zone,
          machineType: `zones/${zone}/machineTypes/${INSTANCE_TYPE_MAP[props.instanceType as string] ?? 'e2-small'}`,
          disks: [{
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage: `global/images/${(props.image as string) ?? 'ubuntu-2204-lts'}`,
            },
          }],
          networkInterfaces: [{ network: 'global/networks/default' }],
        },
      }];

    case 'Compute.AutoScaling': {
      const machineType = INSTANCE_TYPE_MAP[props.instanceType as string] ?? 'e2-small';
      const templateName = `${construct.id}-template`;
      const resources: GCPResource[] = [
        {
          name: templateName,
          type: 'compute.v1.instanceTemplate',
          properties: {
            properties: {
              machineType,
              disks: [{
                boot: true,
                autoDelete: true,
                initializeParams: {
                  sourceImage: `global/images/${(props.image as string) ?? 'ubuntu-2204-lts'}`,
                },
              }],
              networkInterfaces: [{ network: 'global/networks/default' }],
            },
          },
        },
        {
          name: construct.id,
          type: 'compute.v1.regionInstanceGroupManager',
          properties: {
            region,
            baseInstanceName: construct.id,
            instanceTemplate: `global/instanceTemplates/${templateName}`,
            targetSize: (props.desiredCapacity as number) ?? (props.minCapacity as number) ?? 1,
          },
        },
      ];

      if (props.minCapacity !== undefined || props.targetCpuUtilization) {
        resources.push({
          name: `${construct.id}-autoscaler`,
          type: 'compute.v1.regionAutoscaler',
          properties: {
            region,
            target: `regions/${region}/instanceGroupManagers/${construct.id}`,
            autoscalingPolicy: {
              minNumReplicas: (props.minCapacity as number) ?? 1,
              maxNumReplicas: (props.maxCapacity as number) ?? 10,
              coolDownPeriodSec: 60,
              ...(props.targetCpuUtilization ? {
                cpuUtilization: { utilizationTarget: (props.targetCpuUtilization as number) / 100 },
              } : {}),
            },
          },
        });
      }

      return resources;
    }

    case 'Compute.Container': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const envVars = Object.entries(environment).map(([k, v]) => ({ name: k, value: v }));
      return [{
        name: construct.id,
        type: 'run.v2.service',
        properties: {
          location: region,
          template: {
            containers: [{
              image: props.image as string,
              resources: {
                limits: {
                  cpu: String(Math.round((props.cpu as number ?? 256) / 1000)),
                  memory: `${props.memory ?? 512}Mi`,
                },
              },
              ports: props.port ? [{ containerPort: props.port }] : [],
              env: envVars,
            }],
            scaling: {
              minInstanceCount: (props.minInstances as number) ?? 0,
              maxInstanceCount: (props.desiredCount as number) ?? 10,
            },
          },
          ingress: (props.publicIp as boolean) ? 'INGRESS_TRAFFIC_ALL' : 'INGRESS_TRAFFIC_INTERNAL_ONLY',
        },
      }];
    }

    case 'Compute.Kubernetes': {
      const machineType = K8S_MACHINE_MAP[(props.nodeInstanceType as string) ?? 'medium'] ?? 'e2-standard-4';
      return [{
        name: construct.id,
        type: 'container.v1.cluster',
        properties: {
          location: region,
          cluster: {
            name: construct.id,
            currentMasterVersion: (props.version as string) ?? '1.29',
            initialNodeCount: (props.desiredNodes as number) ?? 2,
            nodePools: [{
              name: 'default-pool',
              config: {
                machineType,
                diskSizeGb: 100,
                oauthScopes: ['https://www.googleapis.com/auth/cloud-platform'],
              },
              autoscaling: {
                enabled: true,
                minNodeCount: (props.minNodes as number) ?? 1,
                maxNodeCount: (props.maxNodes as number) ?? 3,
              },
              initialNodeCount: (props.desiredNodes as number) ?? 2,
            }],
            masterAuth: { clientCertificateConfig: { issueClientCertificate: false } },
            networkConfig: {
              enableIntraNodeVisibility: true,
              datapathProvider: 'ADVANCED_DATAPATH',
            },
            privateClusterConfig: (props.privateCluster as boolean) ? {
              enablePrivateNodes: true,
              enablePrivateEndpoint: true,
              masterIpv4CidrBlock: '172.16.0.32/28',
            } : {},
          },
        },
      }];
    }

    // ── Storage ───────────────────────────────────────────────────────────
    case 'Storage.Bucket': {
      const lifecycleRules = (props.lifecycleRules as Array<Record<string, unknown>>) ?? [];
      return [{
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        type: 'storage.v1.bucket',
        properties: {
          location: (props.region as string) ?? 'US',
          versioning: { enabled: (props.versioning as boolean) ?? false },
          iamConfiguration: {
            uniformBucketLevelAccess: { enabled: !(props.publicAccess as boolean) },
          },
          ...(lifecycleRules.length > 0 ? {
            lifecycle: {
              rule: lifecycleRules.map(r => ({
                action: r.expireAfterDays
                  ? { type: 'Delete' }
                  : { type: 'SetStorageClass', storageClass: 'ARCHIVE' },
                condition: {
                  ...(r.expireAfterDays ? { age: r.expireAfterDays } : {}),
                  ...(r.transitionToGlacierDays ? { age: r.transitionToGlacierDays } : {}),
                  ...(r.prefix ? { matchesPrefix: [r.prefix] } : {}),
                },
              })),
            },
          } : {}),
        },
      }];
    }

    case 'Storage.FileSystem':
      return [{
        name: construct.id.toLowerCase(),
        type: 'file.v1.instance',
        properties: {
          location: `${region}-a`,
          tier: (props.performanceMode as string) === 'maxIO' ? 'HIGH_SCALE_SSD' : 'STANDARD',
          networks: [{ network: 'default', modes: ['MODE_IPV4'] }],
          fileShares: [{
            name: construct.id,
            capacityGb: 1024,
          }],
        },
      }];

    case 'Storage.Archive':
      return [{
        name: `${construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-archive`,
        type: 'storage.v1.bucket',
        properties: {
          location: (props.region as string) ?? 'US',
          storageClass: 'ARCHIVE',
          iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
          lifecycle: {
            rule: props.retentionDays ? [{
              action: { type: 'Delete' },
              condition: { age: props.retentionDays },
            }] : [],
          },
        },
      }];

    // ── Network ───────────────────────────────────────────────────────────
    case 'Network.VPC':
      return [{
        name: construct.id,
        type: 'compute.v1.network',
        properties: {
          autoCreateSubnetworks: false,
          routingConfig: { routingMode: 'REGIONAL' },
          description: `VPC ${construct.id}`,
        },
      }];

    case 'Network.Subnet':
      return [{
        name: construct.id,
        type: 'compute.v1.subnetwork',
        properties: {
          network: `global/networks/${props.vpcId as string}`,
          ipCidrRange: props.cidr as string,
          region,
          privateIpGoogleAccess: !(props.public as boolean),
          ...(props.availabilityZone ? { description: `AZ: ${props.availabilityZone}` } : {}),
        },
      }];

    case 'Network.SecurityGroup': {
      const ingress = (props.ingressRules as Array<Record<string, unknown>>) ?? [];
      const egress = (props.egressRules as Array<Record<string, unknown>>) ?? [];

      const ingressResources: GCPResource[] = ingress.map((r, i) => ({
        name: `${construct.id}-ingress-${i}`,
        type: 'compute.v1.firewall',
        properties: {
          network: `global/networks/${props.vpcId as string}`,
          direction: 'INGRESS',
          priority: 1000 + i,
          allowed: [{
            IPProtocol: (r.protocol as string) === '-1' ? 'all' : r.protocol as string,
            ...((r.protocol as string) !== '-1' ? {
              ports: r.fromPort === r.toPort ? [`${r.fromPort}`] : [`${r.fromPort}-${r.toPort}`],
            } : {}),
          }],
          sourceRanges: [(r.cidr as string) ?? '0.0.0.0/0'],
          description: (r.description as string) ?? '',
        },
      }));

      const egressList = egress.length > 0 ? egress : [{
        protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0', description: 'Allow all egress',
      }];
      const egressResources: GCPResource[] = egressList.map((r: Record<string, unknown>, i) => ({
        name: `${construct.id}-egress-${i}`,
        type: 'compute.v1.firewall',
        properties: {
          network: `global/networks/${props.vpcId as string}`,
          direction: 'EGRESS',
          priority: 1000 + i,
          allowed: [{
            IPProtocol: (r.protocol as string) === '-1' ? 'all' : r.protocol as string,
            ...((r.protocol as string) !== '-1' && r.fromPort !== 0 ? {
              ports: r.fromPort === r.toPort ? [`${r.fromPort}`] : [`${r.fromPort}-${r.toPort}`],
            } : {}),
          }],
          destinationRanges: [(r.cidr as string) ?? '0.0.0.0/0'],
          description: (r.description as string) ?? '',
        },
      }));

      return [...ingressResources, ...egressResources];
    }

    case 'Network.WAF': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const securityRules = rules.map((r, i) => ({
        priority: (r.priority as number) ?? (i + 1),
        action: (r.action as string) ?? 'allow',
        match: r.managedGroup
          ? { expr: { expression: 'evaluatePreconfiguredExpr("sqli-stable")' } }
          : {
              versionedExpr: 'SRC_IPS_V1',
              config: { srcIpRanges: (r.sourceIps as string[]) ?? ['*'] },
            },
        description: (r.description as string) ?? '',
      }));

      return [{
        name: construct.id,
        type: 'compute.v1.securityPolicy',
        properties: {
          description: (props.description as string) ?? `WAF ${construct.id}`,
          rules: [
            ...securityRules,
            {
              priority: 2147483647,
              action: (props.defaultAction as string) ?? 'allow',
              match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
              description: 'Default rule',
            },
          ],
        },
      }];
    }

    case 'Network.LoadBalancer': {
      const targetGroups = (props.targetGroups as Array<Record<string, unknown>>) ?? [];
      const lbType = (props.type as string) ?? 'application';

      const resources: GCPResource[] = [{
        name: `${construct.id}-backend`,
        type: 'compute.v1.backendService',
        properties: {
          backends: [],
          healthChecks: [],
          protocol: lbType === 'network' ? 'TCP' : 'HTTP',
          loadBalancingScheme: (props.scheme as string) === 'internal' ? 'INTERNAL' : 'EXTERNAL',
        },
      }];

      if (lbType === 'application') {
        resources.push({
          name: `${construct.id}-url-map`,
          type: 'compute.v1.urlMap',
          properties: {
            defaultService: `global/backendServices/${construct.id}-backend`,
          },
        });
        resources.push({
          name: `${construct.id}-http-proxy`,
          type: 'compute.v1.targetHttpProxy',
          properties: {
            urlMap: `global/urlMaps/${construct.id}-url-map`,
          },
        });
        resources.push({
          name: `${construct.id}-forwarding-rule`,
          type: 'compute.v1.globalForwardingRule',
          properties: {
            target: `global/targetHttpProxies/${construct.id}-http-proxy`,
            portRange: '80',
            loadBalancingScheme: 'EXTERNAL',
          },
        });
      }

      return resources;
    }

    case 'Network.CDN': {
      const origins = (props.origins as Array<Record<string, unknown>>) ?? [];
      return [
        {
          name: `${construct.id}-backend-bucket`,
          type: 'compute.v1.backendBucket',
          properties: {
            bucketName: (origins[0]?.bucketName as string) ?? (origins[0]?.domainName as string) ?? construct.id,
            enableCdn: true,
            cdnPolicy: {
              cacheMode: 'CACHE_ALL_STATIC',
              defaultTtl: 3600,
              maxTtl: 86400,
            },
          },
        },
        {
          name: `${construct.id}-url-map`,
          type: 'compute.v1.urlMap',
          properties: {
            defaultService: `global/backendBuckets/${construct.id}-backend-bucket`,
          },
        },
      ];
    }

    case 'Network.Dns': {
      const records = (props.records as Array<Record<string, unknown>>) ?? [];
      const zoneName = (props.zoneName as string).replace(/\./g, '-').replace(/-+$/, '');
      const resources: GCPResource[] = [{
        name: `${zoneName}-zone`,
        type: 'dns.v1.managedZone',
        properties: {
          dnsName: `${props.zoneName as string}.`,
          description: `DNS zone for ${props.zoneName}`,
          visibility: 'public',
        },
      }];

      if (records.length > 0) {
        resources.push({
          name: `${zoneName}-records`,
          type: 'dns.v1.resourceRecordSet',
          properties: {
            managedZone: `${zoneName}-zone`,
            name: `${(records[0].name as string)}.`,
            type: records[0].type as string,
            ttl: (records[0].ttl as number) ?? 300,
            rrdatas: records[0].values as string[],
          },
        });
      }

      return resources;
    }

    // ── Database ──────────────────────────────────────────────────────────
    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const dbVersion = engine === 'postgres' ? 'POSTGRES_15' : 'MYSQL_8_0';
      return [{
        name: construct.id,
        type: 'sqladmin.v1beta4.instance',
        properties: {
          databaseVersion: dbVersion,
          region,
          settings: {
            tier: 'db-f1-micro',
            backupConfiguration: { enabled: true, binaryLogEnabled: engine === 'mysql' },
            storageAutoResize: true,
            storageAutoResizeLimit: (props.storageGb as number) ?? 20,
            availabilityType: (props.multiAz as boolean) ? 'REGIONAL' : 'ZONAL',
          },
        },
      }];
    }

    case 'Database.DocumentDB':
      // GCP equivalent: Firestore
      return [{
        name: construct.id,
        type: 'firestore.v1.database',
        properties: {
          locationId: region,
          type: 'FIRESTORE_NATIVE',
          concurrencyMode: 'PESSIMISTIC',
          appEngineIntegrationMode: 'DISABLED',
          deleteProtectionState: (props.deletionProtection as boolean) ? 'DELETE_PROTECTION_ENABLED' : 'DELETE_PROTECTION_DISABLED',
        },
      }];

    case 'Database.DynamoDB':
      // GCP equivalent: Bigtable or Firestore — using Bigtable for key-value workloads
      return [{
        name: construct.id.toLowerCase(),
        type: 'bigtableadmin.v2.instance',
        properties: {
          parent: 'projects/PROJECT_ID',
          instanceId: construct.id.toLowerCase(),
          instance: {
            displayName: construct.id,
            type: 'PRODUCTION',
          },
          clusters: {
            'cluster-1': {
              location: `projects/PROJECT_ID/locations/${region}-a`,
              serveNodes: 1,
              defaultStorageType: 'SSD',
            },
          },
        },
      }];

    // ── Cache ─────────────────────────────────────────────────────────────
    case 'Cache.Redis': {
      const nodeType = (props.nodeType as string) ?? 'small';
      return [{
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        type: 'redis.v1.instance',
        properties: {
          region,
          tier: CACHE_TIER_MAP[nodeType] ?? 'BASIC',
          memorySizeGb: CACHE_CAPACITY_MAP[nodeType] ?? 1,
          redisVersion: `REDIS_${((props.version as string) ?? '7.0').replace('.', '_')}`,
          authEnabled: (props.transitEncryptionEnabled as boolean) ?? true,
          transitEncryptionMode: (props.transitEncryptionEnabled as boolean) ? 'SERVER_AUTHENTICATION' : 'DISABLED',
          ...(props.subnetGroupName ? { authorizedNetwork: `projects/PROJECT_ID/global/networks/${props.subnetGroupName}` } : {}),
        },
      }];
    }

    case 'Cache.Memcached': {
      const numNodes = (props.numCacheNodes as number) ?? 2;
      return [{
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        type: 'memcache.v1.instance',
        properties: {
          region,
          nodeCount: numNodes,
          nodeConfig: {
            cpuCount: 1,
            memorySizeMb: 1024,
          },
          ...(props.subnetGroupName ? { authorizedNetwork: `projects/PROJECT_ID/global/networks/${props.subnetGroupName}` } : {}),
        },
      }];
    }

    // ── Function ──────────────────────────────────────────────────────────
    case 'Function.Lambda': {
      const environment = (props.environment as Record<string, string>) ?? {};
      const runtimeMap: Record<string, string> = {
        'nodejs20': 'nodejs20', 'nodejs18': 'nodejs18',
        'python3.12': 'python312', 'python3.11': 'python311',
        'java21': 'java21', 'go1.x': 'go121', 'dotnet8': 'dotnet8',
      };
      return [{
        name: construct.id,
        type: 'cloudfunctions.v2.function',
        properties: {
          location: region,
          description: `Function ${construct.id}`,
          buildConfig: {
            runtime: runtimeMap[(props.runtime as string) ?? 'nodejs20'] ?? 'nodejs20',
            entryPoint: (props.handler as string) ?? 'handler',
          },
          serviceConfig: {
            availableMemory: `${(props.memory as number) ?? 128}Mi`,
            timeoutSeconds: (props.timeout as number) ?? 30,
            ...(props.reservedConcurrency ? { maxInstanceCount: props.reservedConcurrency } : {}),
            ...(Object.keys(environment).length > 0 ? { environmentVariables: environment } : {}),
          },
        },
      }];
    }

    case 'Function.ApiGateway': {
      const routes = (props.routes as Array<Record<string, unknown>>) ?? [];
      return [
        {
          name: (props.name as string) ?? construct.id,
          type: 'apigateway.v1.api',
          properties: {
            displayName: (props.name as string) ?? construct.id,
          },
        },
        {
          name: `${construct.id}-config`,
          type: 'apigateway.v1.apiConfig',
          properties: {
            api: (props.name as string) ?? construct.id,
            displayName: `${construct.id} config`,
            openapiDocuments: [{
              document: {
                path: 'openapi.yaml',
                contents: Buffer.from(JSON.stringify({
                  openapi: '3.0.0',
                  info: { title: (props.name as string) ?? construct.id, version: '1.0' },
                  paths: Object.fromEntries(routes.map(r => [r.path as string, {
                    [(r.method as string).toLowerCase()]: {
                      'x-google-backend': { address: `https://${region}-PROJECT_ID.cloudfunctions.net/${r.lambdaId ?? 'function'}` },
                      responses: { '200': { description: 'OK' } },
                    },
                  }])),
                })).toString('base64'),
              },
            }],
          },
        },
      ];
    }

    // ── Policy ────────────────────────────────────────────────────────────
    case 'Policy.IAM': {
      const statements = (props.statements as Array<Record<string, unknown>>) ?? [];
      const attachTo = props.attachTo as string;
      const serviceAccount = `${attachTo.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30)}@PROJECT_ID.iam.gserviceaccount.com`;

      return [
        {
          name: `${construct.id}-sa`,
          type: 'iam.v1.serviceAccount',
          properties: {
            accountId: attachTo.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30),
            displayName: `Service Account for ${attachTo}`,
            description: (props.description as string) ?? '',
          },
        },
        ...statements.map((s, i) => ({
          name: `${construct.id}-binding-${i}`,
          type: 'gcp-types/cloudresourcemanager-v1:virtual.projects.iamMemberBinding',
          properties: {
            resource: 'PROJECT_ID',
            role: (s.actions as string[])[0]?.startsWith('roles/')
              ? (s.actions as string[])[0]
              : `roles/custom.${construct.id.replace(/[^a-zA-Z0-9]/g, '')}`,
            member: `serviceAccount:${serviceAccount}`,
          },
        })),
      ];
    }

    // ── Events ────────────────────────────────────────────────────────────
    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const resources: GCPResource[] = [];

      if ((props.busName as string) && (props.busName as string) !== 'default') {
        resources.push({
          name: props.busName as string,
          type: 'pubsub.v1.topic',
          properties: {
            messageStoragePolicy: {
              allowedPersistenceRegions: [region],
            },
          },
        });
      }

      for (const r of rules) {
        const topicName = `${construct.id}-${(r.name as string) ?? 'rule'}`;
        resources.push({
          name: topicName,
          type: 'pubsub.v1.topic',
          properties: {
            messageStoragePolicy: {
              allowedPersistenceRegions: [region],
            },
          },
        });

        if (r.targetArn) {
          resources.push({
            name: `${topicName}-sub`,
            type: 'pubsub.v1.subscription',
            properties: {
              topic: topicName,
              pushConfig: { pushEndpoint: r.targetArn as string },
              ackDeadlineSeconds: 30,
            },
          });
        }
      }

      return resources;
    }

    // ── Workflow ──────────────────────────────────────────────────────────
    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const definition = {
        main: {
          steps: steps.map((s, i) => ({
            [s.name as string]: {
              call: 'http.post',
              args: { url: (s.resource as string) ?? '' },
              ...(i < steps.length - 1 ? { next: steps[i + 1].name as string } : {}),
            },
          })),
        },
      };

      return [{
        name: construct.id,
        type: 'workflows.v1.workflow',
        properties: {
          region,
          description: (props.description as string) ?? '',
          sourceContents: JSON.stringify(definition, null, 2),
        },
      }];
    }

    // ── Messaging ─────────────────────────────────────────────────────────
    case 'Messaging.Queue': {
      const topicName = construct.id;
      const subName = `${construct.id}-sub`;
      return [
        {
          name: topicName,
          type: 'pubsub.v1.topic',
          properties: {
            messageStoragePolicy: { allowedPersistenceRegions: [region] },
            ...(props.encrypted ? { kmsKeyName: `projects/PROJECT_ID/locations/${region}/keyRings/default/cryptoKeys/default` } : {}),
          },
        },
        {
          name: subName,
          type: 'pubsub.v1.subscription',
          properties: {
            topic: topicName,
            ackDeadlineSeconds: (props.visibilityTimeoutSeconds as number) ?? 30,
            messageRetentionDuration: `${(props.messageRetentionSeconds as number) ?? 345600}s`,
            retainAckedMessages: false,
            ...(props.dlqArn ? {
              deadLetterPolicy: {
                deadLetterTopic: props.dlqArn as string,
                maxDeliveryAttempts: (props.maxReceiveCount as number) ?? 5,
              },
            } : {}),
          },
        },
      ];
    }

    case 'Messaging.Topic': {
      const subscriptions = (props.subscriptions as Array<Record<string, string>>) ?? [];
      const resources: GCPResource[] = [{
        name: construct.id,
        type: 'pubsub.v1.topic',
        properties: {
          messageStoragePolicy: { allowedPersistenceRegions: [region] },
          ...(props.encrypted ? { kmsKeyName: `projects/PROJECT_ID/locations/${region}/keyRings/default/cryptoKeys/default` } : {}),
        },
      }];

      subscriptions.forEach((s, i) => {
        resources.push({
          name: `${construct.id}-sub-${i}`,
          type: 'pubsub.v1.subscription',
          properties: {
            topic: construct.id,
            ackDeadlineSeconds: 30,
            ...(s.protocol === 'https' || s.protocol === 'http'
              ? { pushConfig: { pushEndpoint: s.endpoint } }
              : {}),
          },
        });
      });

      return resources;
    }

    // ── Secret / Certificate ──────────────────────────────────────────────
    case 'Secret.Vault': {
      const resources: GCPResource[] = [{
        name: construct.id.replace(/[^a-zA-Z0-9_-]/g, '-'),
        type: 'secretmanager.v1.secret',
        properties: {
          parent: 'projects/PROJECT_ID',
          secretId: construct.id.replace(/[^a-zA-Z0-9_-]/g, '-'),
          secret: {
            replication: {
              automatic: {},
            },
            ...(props.kmsKeyId ? { customerManagedEncryption: { kmsKeyName: props.kmsKeyId } } : {}),
            ...(props.rotationDays ? {
              rotation: {
                nextRotationTime: new Date(Date.now() + (props.rotationDays as number) * 86400000).toISOString(),
                rotationPeriod: `${(props.rotationDays as number) * 86400}s`,
              },
            } : {}),
          },
        },
      }];
      return resources;
    }

    case 'Certificate.TLS': {
      const sans = (props.subjectAlternativeNames as string[]) ?? [];
      return [{
        name: construct.id.replace(/[^a-zA-Z0-9-]/g, '-'),
        type: 'certificatemanager.v1.certificate',
        properties: {
          name: construct.id.replace(/[^a-zA-Z0-9-]/g, '-'),
          managed: {
            domains: [props.domainName as string, ...sans],
          },
          scope: (props.region as string) ? 'REGIONAL' : 'DEFAULT',
        },
      }];
    }

    // ── Monitoring ────────────────────────────────────────────────────────
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

      return [{
        name: construct.id,
        type: 'monitoring.v3.alertPolicy',
        properties: {
          displayName: construct.id,
          conditions: [{
            displayName: `${props.metricName} condition`,
            conditionThreshold: {
              filter: [
                `metric.type="${(props.namespace as string) ?? 'cloudfunctions.googleapis.com/function'}/${props.metricName}"`,
                dimFilter,
              ].filter(Boolean).join(' AND '),
              comparison: operatorMap[(props.comparisonOperator as string) ?? 'GreaterThanThreshold'] ?? 'COMPARISON_GT',
              thresholdValue: props.threshold as number,
              duration: `${((props.periodSeconds as number) ?? 60) * ((props.evaluationPeriods as number) ?? 2)}s`,
              aggregations: [{
                alignmentPeriod: `${(props.periodSeconds as number) ?? 60}s`,
                perSeriesAligner: 'ALIGN_MEAN',
              }],
            },
          }],
          alertStrategy: { notificationRateLimit: { period: '300s' } },
          combiner: 'OR',
          enabled: true,
          notificationChannels: (props.alarmActions as string[]) ?? [],
        },
      }];
    }

    case 'Monitoring.Dashboard': {
      const widgets = (props.widgets as Array<Record<string, unknown>>) ?? [];
      return [{
        name: construct.id,
        type: 'monitoring.v1.dashboard',
        properties: {
          displayName: construct.id,
          gridLayout: {
            columns: 3,
            widgets: widgets.map(w => ({
              title: w.title as string,
              ...(w.type === 'text' ? {
                text: { content: w.markdown as string ?? w.title as string, format: 'MARKDOWN' },
              } : {
                xyChart: {
                  dataSets: [{
                    timeSeriesQuery: {
                      timeSeriesFilter: {
                        filter: `metric.type="${(w.namespace as string) ?? 'cloudfunctions.googleapis.com'}/${w.metricName}"`,
                        aggregation: { alignmentPeriod: `${(w.period as number) ?? 60}s`, perSeriesAligner: 'ALIGN_MEAN' },
                      },
                    },
                  }],
                },
              }),
            })),
          },
        },
      }];
    }

    case 'Logging.Stream': {
      const filters = (props.subscriptionFilters as Array<Record<string, unknown>>) ?? [];
      const resources: GCPResource[] = [{
        name: construct.id.replace(/[^a-zA-Z0-9_-]/g, '-'),
        type: 'logging.v2.logBucket',
        properties: {
          parent: `projects/PROJECT_ID/locations/${region}`,
          bucketId: construct.id.replace(/[^a-zA-Z0-9_-]/g, '-'),
          retentionDays: (props.retentionDays as number) ?? 30,
        },
      }];

      for (const f of filters) {
        resources.push({
          name: `${construct.id}-sink-${(f.name as string).replace(/[^a-zA-Z0-9-]/g, '-')}`,
          type: 'logging.v2.sink',
          properties: {
            parent: `projects/PROJECT_ID`,
            uniqueWriterIdentity: true,
            filter: f.filterPattern as string,
            destination: f.destinationArn as string,
          },
        });
      }

      return resources;
    }

    default:
      return [];
  }
}

export function synthesize(stack: Stack): GCPDeployment {
  const resources: GCPResource[] = [];

  for (const construct of stack.constructs) {
    const result = synthesizeConstruct(construct);
    resources.push(...result);
  }

  return { resources };
}
