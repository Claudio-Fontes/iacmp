# MVP Status — Fase 1

## O que foi implementado

- Monorepo com Turborepo (npm workspaces)
- Package `@iacmp/core` — abstrações Stack + 5 constructs agnósticos (Compute, Storage, Network, Database, Function)
- Package `@iacmp/provider-aws` — síntese CloudFormation a partir dos constructs
- Package `iacmp` (CLI) — 6 comandos via oclif v4: init, synth, deploy, destroy, ls, doctor
- Suporte a TypeScript em todo o monorepo

## Como rodar

```bash
# 1. Instalar dependências
cd /Users/cmelo/Projetos/iacmp
npm install

# 2. Compilar todos os pacotes
npm run build

# 3. Testar o CLI
node packages/cli/bin/run.js --help
node packages/cli/bin/run.js doctor

# 4. Inicializar um projeto teste
mkdir -p /tmp/iacmp-test && cd /tmp/iacmp-test
node /Users/cmelo/Projetos/iacmp/packages/cli/bin/run.js init teste-mvp

# 5. Ver stacks disponíveis
node /Users/cmelo/Projetos/iacmp/packages/cli/bin/run.js ls
```

## Limitações conhecidas do MVP

- `iacmp synth` requer stacks compiladas (`.js`) — stacks `.ts` precisam de `ts-node` ou compilação prévia
- `iacmp deploy` e `iacmp destroy` são simulados (não chamam AWS real)
- Apenas o provider AWS está implementado (Azure, GCP, Terraform são Fase 2)
- Sem `ts-node` embutido — stacks TypeScript precisam ser compiladas antes do `synth`
