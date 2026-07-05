/** Um comando nativo (aws/az/gcloud/terraform) a ser executado — args sempre separados, nunca concatenados em string, para evitar problemas de shell-escaping. */
export interface NativeCommand {
  bin: string;
  args: string[];
  /** Diretório de trabalho do subprocess; default: process.cwd(). */
  cwd?: string;
  /**
   * Versão dos args para exibição em --dry-run e mensagens de erro.
   * Presente quando args contém valores de secrets — substitui a exibição por versão mascarada (ex: adminPassword=***).
   */
  displayArgs?: string[];
  /**
   * Callback executado após o comando (sucesso ou falha).
   * Usado para remover arquivos temporários de parâmetros com secrets, garantindo
   * que o arquivo seja apagado mesmo que o deploy falhe.
   */
  cleanup?: () => void;
  /**
   * Callback executado ANTES do comando. Pode bloquear (ex: polling até recurso
   * em estado não-terminal ficar pronto). Erro lançado aqui aborta o deploy.
   */
  preRun?: () => void;
}

export interface DeployContext {
  cwd: string;
  stackName: string;
  templatePath: string;
  region: string;
  resourceGroup?: string;
  projectId?: string;
  /** true em --dry-run: planDeploy não deve executar efeitos locais (ex: build). */
  dryRun?: boolean;
  /** Outputs de stacks anteriores — usados para preencher parâmetros cross-stack (Azure Bicep). */
  outputParams?: Record<string, string>;
}

export interface DestroyContext {
  cwd: string;
  stackName: string;
  region: string;
  resourceGroup?: string;
  projectId?: string;
}

export interface StackStatus {
  /** true se a stack/recurso já existe de fato no provider. */
  deployed: boolean;
  /** Status nativo (ex: CREATE_COMPLETE, Succeeded) quando deployed=true. */
  status?: string;
}

export interface DeployExecutor {
  /** Nome do provider (aws|azure|gcp|terraform) — usado em mensagens de erro. */
  readonly provider: string;
  /** Binário nativo que este executor depende de ter no PATH (checado antes de planejar/executar). */
  readonly requiredBinary: string;
  /**
   * Monta a sequência de comandos nativos para o deploy. Pode rodar
   * verificações read-only (ex: `describe`/`exists`) para decidir a sequência
   * real — essas leituras acontecem mesmo em --dry-run, só a etapa final que
   * efetivamente cria/altera recursos é que fica condicionada ao dry-run.
   */
  planDeploy(ctx: DeployContext): Promise<NativeCommand[]>;
  planDestroy(ctx: DestroyContext): Promise<NativeCommand[]>;
  /**
   * Consulta se uma stack já está deployada de verdade e seu status nativo —
   * usado por `iacmp ls --status` pra distinguir stacks só definidas
   * localmente das que já existem na nuvem. Opcional: nem todo provider tem
   * um conceito de "stack" individual (ex: terraform opera no diretório
   * inteiro como um state único, sem mapear 1:1 pra uma stack do projeto).
   */
  describeStatus?(stackName: string, ctx: { region?: string; resourceGroup?: string; projectId?: string }): StackStatus;
}
