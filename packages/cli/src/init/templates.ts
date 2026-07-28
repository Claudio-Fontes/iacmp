// Templates de stack do `iacmp init` — embutidos no CLI, funcionam após npm install -g iacmp

interface TemplateFile {
  path: string;   // relativo à raiz do projeto, ex: 'stacks/compute/hello-fn.ts'
  content: (projectName: string) => string;
}

export interface Template {
  description: string;
  constructs: string[];    // lista para exibir no --list
  stackSubDir?: string;    // subpasta dentro de stacks/ para o arquivo principal (ex: 'stacks/compute')
  stackContent?: (projectName: string) => string; // arquivo principal — ausente = projeto vazio (ex: blank)
  extraFiles?: TemplateFile[];                     // arquivos adicionais
}

export const TEMPLATES: Record<string, Template> = {
  // Template padrão (sem --template): projeto vazio, só estrutura base. Pensado
  // para o fluxo `iacmp ai`, que preenche stacks/ com exatamente o que foi
  // pedido — sem scaffold de exemplo que vire referência órfã ou ruído.
  blank: {
    description: 'Projeto vazio (sem scaffold) — ideal para usar com `iacmp ai`',
    constructs: [],
  },

  hello: {
    description: 'Lambda Hello World exposta via API Gateway REST (arquivos separados)',
    constructs: ['Fn.Lambda', 'Fn.ApiGateway'],
    stackSubDir: 'stacks/compute',
    stackContent: (name) => `import { Stack, Fn } from '@iacmp/core';

const stack = new Stack('${name}-lambda');

new Fn.Lambda(stack, 'HelloWorldFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 128,
  timeout: 10,
});

export default stack;
`,
    extraFiles: [
      {
        path: 'stacks/network/api-gateway-stack.ts',
        content: (name) => `import { Stack, Fn } from '@iacmp/core';

const stack = new Stack('${name}-api');

new Fn.ApiGateway(stack, 'HelloWorldApi', {
  name: '${name}-api',
  type: 'REST',
  stageName: 'prod',
  cors: true,
  authType: 'NONE',
  routes: [
    {
      method: 'GET',
      path: '/hello',
      lambdaId: 'HelloWorldFn',
    },
  ],
});

export default stack;
`,
      },
      {
        path: 'src/index.ts',
        content: () => helloHandlerContent(),
      },
    ],
  },

  rds: {
    description: 'Banco de dados RDS (postgres) com VPC Multi-AZ e réplica de leitura',
    constructs: ['Network.VPC', 'Database.SQL (principal)', 'Database.SQL (replica)'],
    stackContent: (name) => `import { Stack, Network, Database } from '@iacmp/core';

const stack = new Stack('${name}');

new Network.VPC(stack, 'VPC', {
  cidr: '10.0.0.0/16',
  maxAzs: 3,
});

new Database.SQL(stack, 'Principal', {
  engine: 'postgres',
  instanceType: 'medium',
  multiAz: true,
});

new Database.SQL(stack, 'Replica', {
  engine: 'postgres',
  instanceType: 'small',
  multiAz: false,
});

export default stack;
`,
  },

  webapp: {
    description: 'Site estático com VPC, bucket público e bucket privado de assets',
    constructs: ['Network.VPC', 'Storage.Bucket (site público)', 'Storage.Bucket (assets privados)'],
    stackContent: (name) => `import { Stack, Network, Storage } from '@iacmp/core';

const stack = new Stack('${name}');

new Network.VPC(stack, 'Rede', {
  cidr: '10.0.0.0/16',
});

new Storage.Bucket(stack, 'SiteBucket', {
  versioning: false,
  publicAccess: true,
});

new Storage.Bucket(stack, 'AssetsBucket', {
  versioning: true,
  publicAccess: false,
});

export default stack;
`,
  },

  network: {
    description: 'Infraestrutura de rede completa com VPC multi-AZ, bastion e app server',
    constructs: ['Network.VPC', 'Compute.Instance (bastion)', 'Compute.Instance (app server)'],
    stackContent: (name) => `import { Stack, Network, Compute } from '@iacmp/core';

const stack = new Stack('${name}');

new Network.VPC(stack, 'VpcPrincipal', {
  cidr: '10.0.0.0/8',
  maxAzs: 3,
});

new Compute.Instance(stack, 'Bastion', {
  instanceType: 'small',
  image: 'ubuntu-22.04',
});

new Compute.Instance(stack, 'AppServer', {
  instanceType: 'large',
  image: 'ubuntu-22.04',
});

export default stack;
`,
  },

  serverless: {
    description: 'API serverless com múltiplas Lambdas e API Gateway',
    constructs: ['Fn.Lambda', 'Fn.ApiGateway'],
    stackSubDir: 'stacks/compute',
    stackContent: (name) => `import { Stack, Fn } from '@iacmp/core';

const stack = new Stack('${name}');

new Fn.Lambda(stack, 'HelloFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 256,
  timeout: 30,
});

new Fn.Lambda(stack, 'UsersFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 256,
  timeout: 30,
});

export default stack;
`,
    extraFiles: [
      {
        path: 'stacks/network/api-gateway-stack.ts',
        content: (name) => `import { Stack, Fn } from '@iacmp/core';

const stack = new Stack('${name}-api');

new Fn.ApiGateway(stack, 'Api', {
  name: '${name}-api',
  type: 'REST',
  stageName: 'prod',
  cors: true,
  authType: 'NONE',
  routes: [
    { method: 'GET', path: '/hello', lambdaId: 'HelloFn' },
    { method: 'GET', path: '/users', lambdaId: 'UsersFn' },
    { method: 'POST', path: '/users', lambdaId: 'UsersFn' },
  ],
});

export default stack;
`,
      },
      {
        path: 'src/index.ts',
        content: () => helloHandlerContent(),
      },
    ],
  },

  fullstack: {
    description: 'Aplicação completa (uma stack por domínio): VPC, compute, banco postgres e bucket',
    constructs: ['Network.VPC', 'Compute.Instance', 'Database.SQL', 'Storage.Bucket'],
    // Uma stack por domínio (convenção do iacmp) — não um main-stack.ts com tudo
    // junto (o synth rejeita monólito). Cada camada em sua subpasta de stacks/.
    stackSubDir: 'stacks/network',
    stackContent: (name) => `import { Stack, Network } from '@iacmp/core';

const stack = new Stack('${name}-network');

new Network.VPC(stack, 'VPC', {
  cidr: '10.0.0.0/16',
  maxAzs: 3,
});

export default stack;
`,
    extraFiles: [
      {
        path: 'stacks/database/db-stack.ts',
        content: (name) => `import { Stack, Database } from '@iacmp/core';

const stack = new Stack('${name}-database');

new Database.SQL(stack, 'DB', {
  engine: 'postgres',
  instanceType: 'medium',
  multiAz: true,
});

export default stack;
`,
      },
      {
        path: 'stacks/compute/app-stack.ts',
        content: (name) => `import { Stack, Compute } from '@iacmp/core';

const stack = new Stack('${name}-compute');

new Compute.Instance(stack, 'App', {
  instanceType: 'medium',
  image: 'ubuntu-22.04',
});

export default stack;
`,
      },
      {
        path: 'stacks/storage/uploads-stack.ts',
        content: (name) => `import { Stack, Storage } from '@iacmp/core';

const stack = new Stack('${name}-storage');

new Storage.Bucket(stack, 'Uploads', {
  versioning: true,
  publicAccess: false,
});

export default stack;
`,
      },
    ],
  },
};

function helloHandlerContent(): string {
  return `export async function handler(): Promise<{ statusCode: number; body: string }> {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Hello, World!' }),
  };
}
`;
}
