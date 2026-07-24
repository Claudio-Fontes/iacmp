import { BaseConstruct } from '@iacmp/core';
import { INSTANCE_TYPE_MAP, K8S_MACHINE_MAP, resolveGcpImage } from '../common.js';
import { TFOutput, toTfId, addResource, gcpName } from './common.js';

export function synthCompute(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Compute.Instance': {
      ctx.needsZoneVar = true;
      addResource(r, 'google_compute_instance', id, {
        name: gcpName(construct.id),
        machine_type: INSTANCE_TYPE_MAP[(props.instanceType as string) ?? 'small'] ?? 'e2-small',
        zone: '${var.gcp_zone}',
        boot_disk: [{ initialize_params: [{ image: resolveGcpImage(props.image as string) }] }],
        network_interface: [{ network: 'default' }],
      });
      return true;
    }

    case 'Compute.AutoScaling': {
      ctx.needsZoneVar = true;
      const machineType = INSTANCE_TYPE_MAP[(props.instanceType as string) ?? 'small'] ?? 'e2-small';
      const templateId = `${id}_template`;
      addResource(r, 'google_compute_instance_template', templateId, {
        name: `${gcpName(construct.id)}-template`,
        machine_type: machineType,
        disk: [{ source_image: resolveGcpImage(props.image as string) }],
        network_interface: [{ network: 'default' }],
      });
      addResource(r, 'google_compute_region_instance_group_manager', id, {
        name: gcpName(construct.id),
        base_instance_name: gcpName(construct.id),
        region: '${var.gcp_region}',
        version: [{ instance_template: `\${google_compute_instance_template.${templateId}.id}` }],
        target_size: (props.desiredCapacity as number) ?? (props.minCapacity as number) ?? 1,
      });
      if (props.minCapacity !== undefined || props.targetCpuUtilization) {
        const autoscalerId = `${id}_autoscaler`;
        addResource(r, 'google_compute_region_autoscaler', autoscalerId, {
          name: `${gcpName(construct.id)}-autoscaler`,
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
      return true;
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
      return true;
    }

    case 'Compute.Kubernetes': {
      const machineType = K8S_MACHINE_MAP[(props.nodeInstanceType as string) ?? 'medium'] ?? 'e2-standard-4';
      const clusterProps: Record<string, unknown> = {
        name: gcpName(construct.id),
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
      return true;
    }

    default:
      return false;
  }
}
