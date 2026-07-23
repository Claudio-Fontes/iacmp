import type { Example } from '../index.js';

export const fargateAlbAutoscale: Example = {
  id: 'aws-fargate-alb-autoscale',
  title: 'ECS Fargate atrás de ALB com autoscaling',
  tags: ['aws', 'fargate', 'ecs', 'alb', 'autoscaling', 'container'],
  // validado em deploy real (ciclo 10 da bateria): ALB->TG->2 tasks Fargate saudáveis->200,
  // autoscaling 2-10 registrado. Deploy usou subnet PÚBLICA + publicIp + imagem pública real
  // (Fargate em subnet privada sem NAT Gateway não consegue puxar a imagem do ECR/registry)
  validated: true,
  stacks: {
    'stacks/network/vpc-stack.ts': `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('app-vpc');
new Network.VPC(stack, 'AppVpc', { cidr: '10.60.0.0/16', maxAzs: 0 });
new Network.Subnet(stack, 'PublicSubnet1', { vpcId: 'AppVpc', cidr: '10.60.0.0/24', availabilityZone: 'us-east-1a', public: true });
new Network.Subnet(stack, 'PublicSubnet2', { vpcId: 'AppVpc', cidr: '10.60.1.0/24', availabilityZone: 'us-east-1b', public: true });
new Network.SecurityGroup(stack, 'AlbSG', { vpcId: 'AppVpc', description: 'ALB', ingressRules: [{ protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0' }] });
new Network.SecurityGroup(stack, 'ServiceSG', { vpcId: 'AppVpc', description: 'Fargate service', ingressRules: [{ protocol: 'tcp', fromPort: 3000, toPort: 3000, sourceSecurityGroupId: 'AlbSG' }] });
export default stack;`,

    'stacks/network/lb-stack.ts': `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('app-lb');
new Network.LoadBalancer(stack, 'AppLB', {
  type: 'application',
  scheme: 'internet-facing',
  vpcId: 'AppVpc',
  subnetIds: ['PublicSubnet1', 'PublicSubnet2'],
  securityGroupIds: ['AlbSG'],
  listeners: [{ port: 80, protocol: 'HTTP' }],
  targetGroups: [{ name: 'app-tg', port: 3000, protocol: 'HTTP', healthCheckPath: '/' }],
});
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Compute, ref } from '@iacmp/core';
const stack = new Stack('app-service');
new Compute.Container(stack, 'ApiService', {
  // Placeholder público real (echo-server) — Fargate em subnet privada sem NAT
  // Gateway não consegue puxar imagem nenhuma (nem do ECR). Em produção, use
  // build:{context} (o deploy builda e faz push pro ECR/ACR de bootstrap) ou
  // uma imagem privada num registry alcançável pela subnet.
  image: 'ealen/echo-server:latest',
  port: 3000,
  cpu: 256,
  memory: 512,
  desiredCount: 2,
  publicIp: true,
  subnetIds: ['PublicSubnet1', 'PublicSubnet2'],
  securityGroupIds: ['ServiceSG'],
  targetGroupArn: ref('AppLB', 'TargetGroupArn'),
  minCapacity: 2,
  maxCapacity: 10,
  cpuTargetPercent: 60,
});
export default stack;`,
  },
  handlers: {},
  notes: [
    'targetGroupArn: ref("AppLB","TargetGroupArn") resolve pro PRIMEIRO target group da LB (o "default") — registra as tasks Fargate no Service.LoadBalancers',
    'minCapacity/maxCapacity/cpuTargetPercent no Compute.Container geram ApplicationAutoScaling::ScalableTarget+ScalingPolicy — NÃO é Compute.AutoScaling (isso é ASG de EC2, construct diferente)',
    'publicIp: true + subnets PÚBLICAS — decisão de deploy real: Fargate numa subnet privada sem NAT Gateway não consegue fazer pull da imagem (do ECR nem de registry público) e a task nunca fica RUNNING',
    'Network.SecurityGroup com ingressRules[] explícito — AlbSG libera 80 de 0.0.0.0/0, ServiceSG libera 3000 SÓ do AlbSG via sourceSecurityGroupId (nunca 0.0.0.0/0 direto na task)',
    'Network.Subnet public:true na mesma stack da VPC gera Internet Gateway + rota 0.0.0.0/0 automaticamente — sem isso o ALB internet-facing falha "VPC has no internet gateway"',
    'Compute.Container cria automaticamente o LogGroup /ecs/<id> (awslogs) — a execution role padrão só tem PutLogEvents, não CreateLogGroup',
    'listeners[] sem certificateArn deve ser HTTP (porta 80) — HTTPS/TLS sem certificateArn é pulado pelo synth com warning, nunca gera listener quebrado',
    'healthCheckPath: "/" — a imagem placeholder (echo-server) responde 200 em qualquer path; em produção aponte pro endpoint de health real da aplicação',
    'Network.VPC/Subnet/SecurityGroup, Network.LoadBalancer e Compute.Container em stacks SEPARADAS (network/vpc, network/lb, compute/api) — evita monolito',
  ],
};
