# iacmp — Manual de Uso

CLI unificado para provisionamento de infraestrutura em AWS, Azure, GCP e Terraform.

---

## Instalação

**Requisitos:** Node.js 20+, npm 10+

### Via npm (quando publicado)

```bash
npm install -g iacmp
```

### Local (desenvolvimento / pré-publicação)

```bash
npm install -g /caminho/para/iacmp/packages/cli
```

Exemplo:

```bash
npm install -g /Users/cmelo/Projetos/iacmp/packages/cli
```

Verificar se está funcionando:

```bash
iacmp --version
iacmp doctor
```

---

## Fluxo básico

```
1. iacmp init          → cria o projeto
2. Escreve sua stack   → arquivo em stacks/
3. iacmp synth         → gera o template nativo (CloudFormation, Bicep, etc.)
4. iacmp deploy        → faz o deploy no provider
```

---

## Comandos

Rodar `iacmp` sozinho (ou `iacmp --help`) já lista todos os comandos com um
exemplo de uso embaixo de cada um — não precisa entrar em `iacmp <comando>
--help` só para descobrir a sintaxe básica. O `--help` por comando continua
disponível para ver todas as flags e todos os exemplos.

### `iacmp init [nome]`

Com nome: cria a pasta do projeto e inicializa dentro dela.  
Sem nome: inicializa no diretório atual.

```bash
# Cria a pasta 'meu-projeto' e inicializa dentro dela
iacmp init meu-projeto
cd meu-projeto

# Ou inicializa no diretório atual
mkdir meu-projeto && cd meu-projeto
iacmp init
```

Cria:
- `iacmp.json` — configuração do projeto (provider, região, linguagem)
- `stacks/` — diretório onde ficam as stacks

`iacmp.json` gerado:
```json
{
  "name": "meu-projeto",
  "provider": "aws",
  "region": "us-east-1",
  "language": "typescript"
}
```

---

### `iacmp synth [--provider aws]`

Sintetiza as stacks para o formato nativo do provider configurado.

```bash
iacmp synth
iacmp synth --provider aws
```

Lê as stacks em `stacks/` (`.ts` direto via ts-node ou `.js` compiladas) e gera
os templates em `synth-out/<provider>/<stack>.<ext>`. Exemplos:
`synth-out/aws/minha-stack.json`, `synth-out/terraform/minha-stack.tf`.

> `ts-node` é instalado como devDependency pelo `iacmp init`. Se você criou o
> projeto manualmente, rode `npm i -D ts-node` antes do primeiro synth.

---

### `iacmp deploy [--provider aws] [--stack nome] [--dry-run]`

Faz deploy real da infraestrutura — chama a CLI nativa de cada nuvem por
trás (`aws`, `az`, `gcloud` ou `terraform`, conforme o provider configurado).
Você não precisa saber qual ferramenta é usada por baixo: o comando é sempre
`iacmp deploy`.

```bash
iacmp deploy                              # usa o provider do iacmp.json
iacmp deploy --provider aws
iacmp deploy --stack minha-stack
iacmp deploy --dry-run                    # mostra os comandos sem executar nada
```

Pré-requisito: a stack precisa estar sintetizada (`iacmp synth --provider <provider>`
antes) e a CLI nativa do provider escolhido precisa estar instalada e
autenticada — rode `iacmp doctor` para checar (`--fix` instala o que faltar).

O que cada provider faz de fato:

| Provider | O que roda por trás | Particularidade |
|---|---|---|
| `aws` | `aws cloudformation package` + `aws cloudformation deploy` | O `package` zipa e sobe o código de Lambdas automaticamente. O iacmp cria (uma vez) e usa um bucket S3 próprio, `iacmp-deploy-artifacts-<conta>-<região>` — sem precisar configurar nada manualmente. |
| `azure` | `az stack group create` (Deployment Stacks) | Exige `resourceGroup` no `iacmp.json`. Se o resource group não existir, o comando pergunta antes de criar. |
| `gcp` | `gcloud deployment-manager deployments create` ou `update` | Decide automaticamente entre criar ou atualizar (Deployment Manager não atualiza por cima de um deployment existente). Usa `projectId` do `iacmp.json`, ou o projeto default do `gcloud` se omitido. |
| `terraform` | `terraform init` + `terraform apply -auto-approve` | Opera no diretório `synth-out/terraform/` inteiro (todas as stacks compartilham um único state) — `--stack` não é aplicável aqui. O provider AWS é gerado automaticamente em `_provider.tf`. |

Com `--dry-run`, nenhum comando é de fato executado — o iacmp ainda faz as
verificações de leitura necessárias (ex: se o deployment já existe no GCP)
para mostrar o plano real, mas nunca pede confirmação nem chama a nuvem.

**Stacks em arquivos diferentes (AWS):** é comum (e é o padrão recomendado)
ter o `Function.Lambda` em `stacks/compute/` e o `Function.ApiGateway` que
referencia ela em `stacks/network/`, em arquivos/stacks separados. O `iacmp
synth`/`deploy`/`destroy` resolvem isso automaticamente: a Lambda exporta seu
ARN e o API Gateway importa via `Fn::ImportValue`, e o `deploy` sempre sobe a
stack da Lambda antes da do API Gateway (o `destroy` derruba na ordem
inversa). Você não precisa fazer nada manual pra isso funcionar.

> **Limitação conhecida:** apenas o provider **AWS** tem o empacotamento de
> código de função (`Function.Lambda`) corrigido nesta versão — o `package`
> zipa e sobe o conteúdo de `code` automaticamente. Em **Azure** (Function
> App) e **GCP** (Cloud Functions) o recurso de infraestrutura é criado, mas
> sem código funcional anexado; no **Terraform**, o recurso espera um arquivo
> `function.zip` que ainda não é gerado automaticamente. Os demais recursos
> (VPC, S3, RDS, DynamoDB, IAM etc.) fazem deploy real e completo nos 4
> providers. Corrigir esse gap para Azure/GCP/Terraform é a próxima etapa
> planejada, a ser feita depois da validação manual desta entrega.

---

### `iacmp destroy [--provider aws] [--stack nome] [--dry-run]`

Destrói a infraestrutura provisionada de verdade. Pede confirmação antes de
executar (a menos que use `--force`) — a pergunta acontece antes de qualquer
chamada à CLI nativa, então cancelar nunca depende de ter a ferramenta
instalada.

```bash
iacmp destroy
iacmp destroy --stack minha-stack
iacmp destroy --force                     # pula a confirmação
iacmp destroy --dry-run                   # mostra os comandos sem executar nada
```

Mesma lógica de comandos nativos do `iacmp deploy` (CloudFormation
delete-stack, Azure Deployment Stacks delete, Deployment Manager delete,
`terraform destroy`). Para terraform, `--stack` não é suportado pelo mesmo
motivo do deploy (state compartilhado).

---

### `iacmp ls`

Lista as stacks disponíveis no projeto atual.

```bash
iacmp ls
```

---

### `iacmp ai [prompt]`

Gera stacks de infraestrutura em TypeScript via IA (Claude ou GitHub Copilot).

**Pré-requisito:** defina uma das variáveis de ambiente:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # Anthropic Claude (prioridade)
# ou
export GITHUB_TOKEN=ghp_...           # GitHub Copilot
```

#### Modo comando único

```bash
iacmp ai "cria uma Lambda com API Gateway e DynamoDB"
iacmp ai "cria uma VPC com subnets públicas e privadas"
iacmp ai "documenta a stack ecommerce-stack em português"
iacmp ai "migra a stack para azure" --provider azure
iacmp ai "otimiza a stack para reduzir custos"
```

Fluxo:
1. Lê o contexto do projeto (`iacmp.json` + stacks existentes)
2. Envia o prompt para a IA em streaming
3. Extrai o JSON do response
4. Valida o TypeScript gerado (`tsc --noEmit`)
5. Exibe diff colorido dos arquivos que serão criados/modificados
6. Pede aprovação antes de salvar (`[y/n]`)
7. Pergunta se quer rodar `iacmp synth` imediatamente

#### Modo chat interativo

```bash
iacmp ai --chat
```

Loop interativo que mantém o histórico da conversa:

```
iacmp ai — Modo Chat Interativo

> Você: preciso de uma arquitetura serverless para e-commerce
> (IA gera e exibe a stack)
> Você: adiciona SQS para processamento de pedidos
> (IA modifica a stack mantendo o contexto)
> Você: /sair
```

Comandos especiais no modo chat:
- `/sair` ou `/quit` — encerra o chat
- `/limpar` — limpa o histórico da conversa
- `/lang pt|en|es` — troca o idioma da interface e da resposta do Claude em tempo real (default: `pt`, ou o valor de `IACMP_LANG` no `.env`)
- `/voz` — grava um áudio e transcreve para texto (veja "Entrada por voz" abaixo)

#### Entrada por voz

O comando `/voz` grava um áudio do microfone e transcreve automaticamente em português, inglês ou espanhol, sem substituir a digitação — a qualquer momento você pode continuar digitando normalmente.

Pré-requisitos:
- Binário `sox` no PATH — usado para gravar o áudio.
- Binário do [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (`whisper-cli` ou `main`) no PATH, ou apontado em `IACMP_WHISPER_BIN`.
- Um modelo `ggml` do whisper.cpp baixado localmente, com o caminho configurado em `IACMP_WHISPER_MODEL` no `.env`.

Rode `iacmp doctor --fix` para checar e instalar automaticamente o que faltar (sox via brew/apt/winget/choco conforme o sistema, whisper.cpp via brew no macOS, e o modelo `ggml-base` baixado e configurado em `IACMP_WHISPER_MODEL`) — ele pede confirmação antes de cada ação e nunca instala nada sem você aprovar. Em plataformas sem instalação automática conhecida (ex: whisper.cpp no Linux/Windows), o `doctor` mostra o link e o caminho manual. Rode só `iacmp doctor` (sem `--fix`) para apenas checar o que está faltando.

Fluxo:
```
> Você: /voz
gravando... pressione Enter para parar
[Enter]
Você disse (pt): cria uma fila SQS para processar pedidos
[Enter] usar, /voz regravar, ou digite para corrigir:
```

Pressione Enter para aceitar a transcrição, digite `/voz` para regravar, ou digite um texto para corrigir/substituir antes de enviar. A resposta do Claude sai no mesmo idioma detectado na fala (pt/en/es); se a detecção falhar, usa o idioma atual da interface.

Se `sox` ou o whisper.cpp não estiverem configurados, o `/voz` mostra uma mensagem de erro clara e o chat continua funcionando normalmente por texto.

#### Modo dry-run

```bash
iacmp ai --dry-run "cria uma stack com RDS e EC2"
```

Exibe os arquivos que seriam gerados sem salvar nada em disco. Útil para prévia.

#### Flags

| Flag | Descrição | Padrão |
|------|-----------|--------|
| `--chat` | Modo chat interativo | `false` |
| `--dry-run` | Exibe sem salvar | `false` |
| `--provider` | Provider alvo | Lido do `iacmp.json` |

---

### `iacmp watch [--provider aws]`

Monitora `stacks/` e roda `iacmp synth` automaticamente ao detectar mudanças.

```bash
iacmp watch
iacmp watch --provider azure
```

Ao iniciar, imprime `Monitorando stacks/ — pressione Ctrl+C para parar`. A cada mudança detectada imprime o timestamp, o arquivo alterado e se o synth foi bem-sucedido.

| Flag | Descrição | Padrão |
|------|-----------|--------|
| `--provider`, `-p` | Provider para sintetizar | Lido do `iacmp.json` |

---

### `iacmp dashboard`

Inicia um servidor HTTP local com visualização das stacks sintetizadas.

```bash
iacmp dashboard
iacmp dashboard --port 3000
iacmp dashboard --open
```

Lê os arquivos de `synth-out/` e exibe um dashboard com tema escuro no browser. Cada stack aparece em um card com a lista de recursos (tipo e ID lógico).

| Flag | Descrição | Padrão |
|------|-----------|--------|
| `--port`, `-p` | Porta do servidor | `4000` |
| `--open` | Abre o browser automaticamente | `false` |

---

### `iacmp registry`

Acessa o registry de constructs da comunidade.

```bash
iacmp registry list                 # lista todos os constructs
iacmp registry search cognito       # filtra por nome ou descrição
```

Imprime tabela com: Nome | Pacote | Providers | Descrição.

---

### `iacmp diagram`

Gera diagramas de arquitetura a partir das stacks do projeto.

```bash
iacmp diagram                              # Structurizr DSL (padrão)
iacmp diagram --format mermaid             # Mermaid em Markdown
iacmp diagram --stack database             # apenas uma stack
iacmp diagram --format mermaid --out docs/diagrams
```

Gera um único arquivo com todas as stacks em `diagrams/`:

| Formato | Arquivo gerado | Onde abrir |
|---|---|---|
| `structurizr` | `diagrams/workspace.dsl` | https://structurizr.com/dsl |
| `mermaid` | `diagrams/workspace.md` | GitHub, GitLab, Notion (renderizado automaticamente) |

O Structurizr DSL inclui estilos por tipo de construct (Compute, Storage, Network, Database, Function) e `autoLayout`. O Mermaid inclui emojis por tipo e legenda de recursos.

Relações entre constructs são **inferidas** com base na topologia da stack (ex: VPC única → seta tracejada para os demais) e marcadas explicitamente como inferidas. Nenhuma seta funcional é inventada.

| Flag | Descrição | Padrão |
|------|-----------|--------|
| `--format`, `-f` | Formato de saída (`structurizr`, `mermaid`) | `structurizr` |
| `--stack`, `-s` | Nome de uma stack específica | todas |
| `--out`, `-o` | Diretório de saída | `diagrams` |

---

### `iacmp doctor`

Verifica se o ambiente tem tudo que o iacmp precisa.

```bash
iacmp doctor
```

Verifica:
- Node.js 20+
- iacmp instalado
- AWS CLI, Azure CLI, gcloud CLI e Terraform CLI (necessários para `iacmp deploy`/`destroy` real em cada provider)
- ANTHROPIC_API_KEY (necessário para `iacmp ai`)
- sox, whisper.cpp e modelo ggml (necessários para `/voz` no chat — veja "Entrada por voz")

Use `--fix` para tentar corrigir automaticamente os itens que estiverem faltando (pede confirmação antes de cada ação — inclui instalar as CLIs de nuvem via brew/apt/winget, conforme o sistema):

```bash
iacmp doctor --fix
```

---

## Escrevendo uma stack

As stacks ficam em `stacks/` e usam os constructs do `@iacmp/core`.

### Exemplo: servidor web simples

```typescript
// stacks/web-server.ts
import { Stack, Compute, Storage } from '@iacmp/core';

const stack = new Stack('web-server');

const servidor = new Compute.Instance(stack, 'Servidor', {
  instanceType: 'small',   // small = t3.small na AWS
  image: 'ubuntu-22.04',
  region: 'us-east-1',
});

const assets = new Storage.Bucket(stack, 'Assets', {
  versioning: true,
  publicAccess: false,
});

export default stack;
```

### Exemplo: API serverless

```typescript
// stacks/api-serverless.ts
import { Stack, Fn, Network } from '@iacmp/core';

const stack = new Stack('api-serverless');

const vpc = new Network.VPC(stack, 'Rede', {
  cidr: '10.0.0.0/16',
  maxAzs: 2,
});

const api = new Fn.Lambda(stack, 'Handler', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: 'dist/',
  memory: 512,
  timeout: 30,
});

export default stack;
```

---

## Constructs disponíveis

Todos os constructs são agnósticos ao provider — o mesmo código funciona em AWS, Azure ou GCP.

| Construct | O que cria | AWS | Azure | GCP |
|---|---|---|---|---|
| `Compute.Instance` | Máquina virtual | EC2 | Azure VM | Compute Engine |
| `Storage.Bucket` | Object storage | S3 | Blob Storage | Cloud Storage |
| `Network.VPC` | Rede privada virtual | VPC | Virtual Network | VPC Network |
| `Database.SQL` | Banco de dados relacional | RDS | Azure SQL | Cloud SQL |
| `Fn.Lambda` | Função serverless | Lambda | Azure Functions | Cloud Functions |

### Tamanhos de instância

O `instanceType` é mapeado automaticamente por provider:

| Valor | AWS | Azure | GCP |
|---|---|---|---|
| `small` | t3.small | B1s | e2-small |
| `medium` | t3.medium | B2s | e2-medium |
| `large` | t3.large | B4s | e2-standard-4 |

---

## Configuração

O `iacmp.json` na raiz do projeto controla o comportamento padrão:

```json
{
  "name": "meu-projeto",
  "provider": "aws",
  "region": "us-east-1",
  "language": "typescript"
}
```

| Campo | Valores aceitos | Padrão |
|---|---|---|
| `provider` | `aws`, `azure`, `gcp`, `terraform` | `aws` |
| `region` | qualquer região válida do provider | `us-east-1` |
| `language` | `typescript`, `python` | `typescript` |
| `resourceGroup` | nome de um resource group Azure | — (obrigatório para `iacmp deploy`/`destroy --provider azure`) |
| `projectId` | ID de um projeto GCP | — (opcional para `iacmp deploy`/`destroy --provider gcp`; usa o projeto default do `gcloud` se omitido) |

---

## Plugin system

O iacmp suporta providers customizados via plugins npm. Para usar um plugin:

1. Instale o pacote: `npm install iacmp-plugin-digitalocean`
2. Adicione ao `iacmp.json`:
   ```json
   {
     "plugins": ["iacmp-plugin-digitalocean"]
   }
   ```
3. Use o provider normalmente: `iacmp synth --provider digitalocean`

Para criar um plugin, use `@iacmp/plugin-sdk`:

```javascript
const { definePlugin } = require('@iacmp/plugin-sdk');

module.exports = definePlugin({
  providers: [{
    name: 'meu-provider',
    synthesize(stack) {
      return { /* template nativo */ };
    },
  }],
});
```

Veja o exemplo completo em `examples/plugin-exemplo/`.

---

## CI/CD

O `iacmp init` gera automaticamente:

- `.github/workflows/iacmp.yml` — pipeline GitHub Actions que roda `iacmp synth` em cada push/PR
- `.gitlab-ci.yml` — pipeline GitLab CI equivalente

---

## Roadmap

| Fase | O que vem | Status |
|---|---|---|
| Fase 1 | CLI base + constructs + Provider AWS | Disponível |
| Fase 2 | Providers Azure, GCP e Terraform | Disponível |
| Fase 3 | `iacmp ai` — geração de stacks via IA (Claude/Copilot) | Disponível |
| Fase 4 | Plugin system, watch, dashboard, registry, CI/CD | Disponível |
| Fase 5 | Testes de integração, documentação, exemplos, publicação npm | Disponível |
| Fase 6 | Templates no `init`, auditorias, diagramas de arquitetura | Disponível |
| Fase 7 | `iacmp deploy`/`destroy` real (AWS completo; Azure/GCP/Terraform sem código de função) | Disponível — aguardando validação manual |
| Fase 8 | Empacotamento de código de função (`Function.Lambda`) em Azure, GCP e Terraform | Planejado — próxima etapa após a validação da Fase 7 |
| Fase 9 | Estudo: suportar stacks escritas em outra linguagem além de TypeScript, sem alterar a API do `@iacmp/core` (exigiria um SDK paralelo emitindo um JSON equivalente, consumido pelo `synth.ts`) | A estudar — sem decisão de implementação ainda |

---

*iacmp v1.1.0 — IaC Multi Plataforma*

Para configurar `ANTHROPIC_API_KEY` (e opcionalmente `GITHUB_TOKEN`), copie o
`.env.example` da raiz para `.env` e preencha. O `iacmp` lê do ambiente — você
pode também exportar a variável no seu shell.
