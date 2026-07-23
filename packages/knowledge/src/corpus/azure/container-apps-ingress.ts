import type { Example } from '../index.js';

export const containerAppsIngress: Example = {
  id: 'azure-container-apps-ingress',
  title: 'Azure Container Apps público com ingress externo e autoscale',
  tags: ['azure', 'container', 'container-apps', 'ingress', 'autoscale', 'public'],
  // validado em deploy real (ciclo p10az2): Container App Succeeded/Running,
  // ingress external:3000, scale min/max = autoscaling registrado
  validated: true,
  stacks: {
    'stacks/compute/api-stack.ts': `import { Stack, Compute } from '@iacmp/core';
const stack = new Stack('web-api');
// SEM subnets de VNet — Container App Environment COMPARTILHADO da região (free
// tier: só 1 CAE por região por subscription). Para VNet integration dedicada,
// ver o exemplo azure-postgres-private-vnet (subnets ganham CAE DEDICADO).
new Compute.Container(stack, 'WebApiContainer', {
  image: 'myapp:latest',
  port: 3000,
  minCapacity: 1,
  maxCapacity: 5,
});
export default stack;`,
  },
  handlers: {
    'src/server.js': `const express = require('express');
const app = express();
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
const port = 3000;
app.listen(port, () => console.log(\`listening on \${port}\`));
`,
  },
  notes: [
    'Compute.Container sem subnets de rede no Azure → Container App público, ingress externo automático (ingress: { external: true, targetPort: port }) — sempre que "port" é declarado',
    'minCapacity/maxCapacity → scale: { minReplicas, maxReplicas } do Container App — mesmas props que no Fargate (AWS), o synth Azure traduz pro conceito equivalente',
    'Sem a prop de subnets, usa o Container App Environment COMPARTILHADO da região (free tier permite só 1 CAE por região por subscription) — declarar essa prop cria um CAE DEDICADO (ver azure-postgres-private-vnet)',
    'ref(WebApiContainer,"Fqdn") expõe o hostname público (properties.configuration.ingress.fqdn) para outras stacks consumirem a URL — não hardcode domínio',
    'image: "myapp:latest" é placeholder — em projeto real use build: { context: "src/api" } (ver azure-postgres-private-vnet) para o deploy buildar e empurrar pro ACR de bootstrap',
    'Sem VNet, sem Database.SQL — este exemplo é o caso PÚBLICO simples; para privado use a integração de rede em Compute.Container e Database.SQL',
  ],
};
