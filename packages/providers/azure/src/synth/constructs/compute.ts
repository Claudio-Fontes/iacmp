import { BaseConstruct } from '@iacmp/core';
import { expr, tag, toSym, resolveValue, crossParamName, outputName, SynthContext } from './shared';

const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 'Standard_B1s',
  medium: 'Standard_B2s',
  large: 'Standard_B4ms',
};

interface AzureImageRef {
  publisher: string;
  offer: string;
  sku: string;
  version: string;
  isWindows: boolean;
}

const IMAGE_MAP: Record<string, AzureImageRef> = {
  'ubuntu':        { publisher: 'Canonical', offer: 'UbuntuServer', sku: '22_04-lts', version: 'latest', isWindows: false },
  'ubuntu-22.04':  { publisher: 'Canonical', offer: 'UbuntuServer', sku: '22_04-lts', version: 'latest', isWindows: false },
  'ubuntu-20.04':  { publisher: 'Canonical', offer: 'UbuntuServer', sku: '20_04-lts', version: 'latest', isWindows: false },
  'windows-2022':  { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2022-Datacenter', version: 'latest', isWindows: true },
  'windows-2019':  { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2019-Datacenter', version: 'latest', isWindows: true },
  'windows-2016':  { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2016-Datacenter', version: 'latest', isWindows: true },
};

function resolveAzureImage(image: string): { imageReference: Record<string, unknown>; isWindows: boolean } {
  const mapped = IMAGE_MAP[image];
  if (mapped) {
    const { isWindows, ...ref } = mapped;
    return { imageReference: ref, isWindows };
  }
  return { imageReference: { offer: image }, isWindows: false };
}

export function synthesizeCompute(construct: BaseConstruct, ctx: SynthContext): void {
  const { resources, outputs, crossParams, functionImageParams } = ctx;
  const props = (construct.props ?? {}) as Record<string, unknown>;
  const sym = toSym(construct.id);

  switch (construct.type) {
    case 'Compute.Instance': {
      const { imageReference, isWindows } = resolveAzureImage(props.image as string ?? 'ubuntu');
      resources.push({
        sym,
        type: 'Microsoft.Compute/virtualMachines',
        apiVersion: '2023-03-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        properties: {
          hardwareProfile: { vmSize: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 'Standard_B1s' },
          storageProfile: { imageReference },
          osProfile: {
            computerName: construct.id,
            adminUsername: isWindows ? 'adminuser' : 'azureuser',
            ...(isWindows
              ? { windowsConfiguration: { provisionVMAgent: true, enableAutomaticUpdates: true } }
              : { linuxConfiguration: { disablePasswordAuthentication: true } }),
          },
        },
      });
      break;
    }

    case 'Compute.AutoScaling': {
      const { imageReference: asImageRef, isWindows: asIsWindows } = resolveAzureImage(props.image as string ?? 'ubuntu');
      const vmssSym = sym;
      const autoscaleSym = `${sym}Autoscale`;
      resources.push({
        sym: vmssSym,
        type: 'Microsoft.Compute/virtualMachineScaleSets',
        apiVersion: '2023-03-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        sku: {
          name: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 'Standard_B1s',
          tier: 'Standard',
          capacity: (props.desiredCapacity as number) ?? (props.minCapacity as number),
        },
        properties: {
          overprovision: true,
          upgradePolicy: { mode: 'Automatic' },
          virtualMachineProfile: {
            storageProfile: { imageReference: asImageRef },
            osProfile: {
              computerNamePrefix: construct.id.slice(0, 9),
              adminUsername: asIsWindows ? 'adminuser' : 'azureuser',
              ...(asIsWindows
                ? { windowsConfiguration: { provisionVMAgent: true, enableAutomaticUpdates: true } }
                : { linuxConfiguration: { disablePasswordAuthentication: true } }),
            },
          },
        },
      });
      resources.push({
        sym: autoscaleSym,
        type: 'Microsoft.Insights/autoscaleSettings',
        apiVersion: '2022-10-01',
        name: `${construct.id}-autoscale`,
        location: 'location',
        properties: {
          enabled: true,
          targetResourceUri: expr(`${vmssSym}.id`),
          profiles: [{
            name: 'default',
            capacity: {
              minimum: String(props.minCapacity ?? 1),
              maximum: String(props.maxCapacity ?? 10),
              default: String(props.desiredCapacity ?? props.minCapacity ?? 1),
            },
            rules: props.targetCpuUtilization ? [{
              metricTrigger: {
                metricName: 'Percentage CPU',
                metricResourceUri: expr(`${vmssSym}.id`),
                timeGrain: 'PT1M',
                statistic: 'Average',
                timeWindow: 'PT5M',
                timeAggregation: 'Average',
                operator: 'GreaterThan',
                threshold: props.targetCpuUtilization,
              },
              scaleAction: { direction: 'Increase', type: 'ChangeCount', value: '1', cooldown: 'PT5M' },
            }] : [],
          }],
        },
      });
      break;
    }

    case 'Compute.Container': {
      const imageParamName = `${sym}Image`;
      functionImageParams.set(imageParamName, (props.image as string) || 'node:20-alpine');

      const environment = (props.environment as Record<string, string | unknown>) ?? {};
      const envVars = Object.entries(environment).map(([k, v]) => {
        const value = resolveValue(v, ctx.idx, crossParams);
        if (value === undefined || value === null) {
          throw new Error(
            `Compute.Container "${construct.id}": env var "${k}" resolveu para undefined. ` +
            `O valor deve ser string literal ou ref() — nunca process.env.${k} (runtime).`,
          );
        }
        return { name: k, value };
      });

      const cpuUnits = (props.cpu as number) ?? 256;
      const cpuVCores = Math.max(0.25, Math.min(2.0, Math.round(cpuUnits / 1024 * 4) / 4));
      const cpuExpr = expr(`json('${cpuVCores}')`);

      const memMB = (props.memory as number) ?? 512;
      const memGiRaw = Math.max(0.5, Math.round(memMB / 512) / 2);
      const memStr = `${memGiRaw}Gi`;

      const minReplicas = (props.minCapacity as number) ?? (props.desiredCount as number) ?? 0;
      const maxReplicas = (props.maxCapacity as number) ?? 10;
      const targetPort = (props.port as number) ?? 80;

      resources.push({
        sym,
        type: 'Microsoft.App/containerApps',
        apiVersion: '2023-05-01',
        name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        location: 'location',
        tags: tag(construct.id),
        identity: { type: 'SystemAssigned' },
        properties: {
          managedEnvironmentId: expr(`empty(sharedCaeId) ? sharedContainerEnv.id : sharedCaeId`),
          configuration: {
            ingress: { external: true, targetPort },
            registries: expr(`empty(acrServer) ? [] : [{\n    server: acrServer\n    username: acrUser\n    passwordSecretRef: 'acr-pwd'\n  }]`),
            secrets: expr(`empty(acrPassword) ? [] : [{\n    name: 'acr-pwd'\n    value: acrPassword\n  }]`),
          },
          template: {
            containers: [{
              name: construct.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
              image: expr(imageParamName),
              resources: { cpu: cpuExpr, memory: memStr },
              env: envVars,
              probes: [{ type: 'Startup', tcpSocket: { port: targetPort }, periodSeconds: 5, failureThreshold: 30 }],
            }],
            scale: { minReplicas, maxReplicas },
          },
        },
      });
      outputs.push({ name: outputName(construct.id, 'Id'), type: 'string', value: `${sym}.id` });
      outputs.push({ name: outputName(construct.id, 'PrincipalId'), type: 'string', value: `${sym}.identity.principalId` });
      outputs.push({ name: crossParamName(construct.id, 'Fqdn'), type: 'string', value: `${sym}.properties.configuration.ingress.fqdn` });
      break;
    }

    case 'Compute.Kubernetes': {
      const nodeType = INSTANCE_TYPE_MAP[props.nodeInstanceType as string] ?? 'Standard_B2s';
      resources.push({
        sym,
        type: 'Microsoft.ContainerService/managedClusters',
        apiVersion: '2023-05-01',
        name: construct.id,
        location: 'location',
        tags: tag(construct.id),
        identity: { type: 'SystemAssigned' },
        properties: {
          kubernetesVersion: (props.version as string) ?? '1.29',
          dnsPrefix: construct.id,
          enableRBAC: true,
          agentPoolProfiles: [{
            name: 'nodepool1',
            count: (props.desiredNodes as number) ?? 2,
            minCount: (props.minNodes as number) ?? 1,
            maxCount: (props.maxNodes as number) ?? 3,
            enableAutoScaling: true,
            vmSize: nodeType,
            mode: 'System',
          }],
          apiServerAccessProfile: { enablePrivateCluster: (props.privateCluster as boolean) ?? false },
          networkProfile: { networkPlugin: 'kubenet', loadBalancerSku: 'standard' },
        },
      });
      break;
    }
  }
}
