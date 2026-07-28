/**
 * Interface mínima de saída que os módulos de synth recebem do comando oclif.
 * Mantém os módulos desacoplados do Command (testáveis sem oclif) e preserva a
 * semântica de `error` (lança, nunca retorna).
 */
export interface SynthUI {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): never;
}
