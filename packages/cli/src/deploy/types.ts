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
  /**
   * Callback executado quando o comando falha. Se não lançar exceção, o erro
   * é suprimido e a execução continua — útil para recuperar de falhas locais
   * do CLI quando a operação real já foi iniciada no provider (ex: az CLI 2.87.0
   * crash com "content already consumed" enquanto deploy stack já está rodando no ARM).
   */
  onError?: (err: Error) => void;
  /** Número de retentativas após falha (default 0 = sem retry). */
  retries?: number;
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
  /** Path do template sintetizado desta stack (Azure: usado para achar o `.iacmp-meta.json` sidecar — ex: limpar repositórios de ACR criados por `Compute.Container` com `build`). */
  templatePath?: string;
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
  /**
   * Consulta o status atual de uma stack durante o deploy e retorna uma string
   * para exibição em tempo real no terminal (ex: "CREATE_IN_PROGRESS → motivo").
   * Retorna null quando não há atualização a exibir (stack não existe ainda,
   * erro transiente, etc.). Chamado pelo polling loop em exec.ts a cada 5s.
   * Opcional: executores sem suporte simplesmente não implementam o método.
   */
  pollStatus?(stackName: string, ctx: DeployContext): Promise<string | null>;
}
