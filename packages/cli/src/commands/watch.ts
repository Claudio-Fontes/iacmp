import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { errMessage, loadIacmpConfig, resolveProvider, IacmpConfig } from '../utils';

// Editores (vim/jetbrains/vscode) geram swap/temporários durante o salvamento;
// dispará-los re-sintetiza com arquivos meio-gravados. Filtramos esse ruído.
function isTempArtifact(name: string): boolean {
  if (!name) return true;
  const base = path.basename(name);
  return (
    base.endsWith('.swp') ||
    base.endsWith('.swx') ||
    base.endsWith('.tmp') ||
    base.endsWith('~') ||
    base.startsWith('.#') ||
    base.startsWith('#') ||
    base.startsWith('.DS_Store')
  );
}

function isStackSource(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.js');
}

export default class Watch extends Command {
  static description = 'Monitora stacks/ e sintetiza automaticamente ao detectar mudanças';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo (aws, azure, gcp, terraform)', default: 'aws' }),
  };

  static examples = [
    '$ iacmp watch',
    '$ iacmp watch --provider azure',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Watch);
    const cwd = process.cwd();

    let config: IacmpConfig | null;
    try {
      config = loadIacmpConfig(cwd);
    } catch (err) {
      this.error(errMessage(err));
    }
    if (!config) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }
    const provider = resolveProvider(config, flags.provider);
    const stacksDir = path.join(cwd, 'stacks');

    if (!fs.existsSync(stacksDir)) {
      this.error('Diretório stacks/ não encontrado.');
    }

    this.log(`Monitorando stacks/ — pressione Ctrl+C para parar`);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const runSynth = (changedFile: string) => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      this.log(`[${hh}:${mm}:${ss}] Mudança detectada em ${changedFile} — sintetizando...`);

      const cliBin = path.resolve(__dirname, '../../bin/run.js');
      const cmd = `node "${cliBin}" synth --provider ${provider}`;

      try {
        execSync(cmd, { cwd, stdio: 'pipe' });
        this.log(`✓ Sintetizado em synth-out/`);
      } catch (err) {
        this.log(`✗ Erro ao sintetizar — veja acima`);
        const output = (err as { stdout?: Buffer; stderr?: Buffer });
        if (output.stderr) process.stderr.write(output.stderr);
        if (output.stdout) process.stdout.write(output.stdout);
      }
    };

    fs.watch(stacksDir, { recursive: true }, (_event, filename) => {
      const name = (filename ?? '').toString();
      if (!name) return;
      if (isTempArtifact(name)) return;
      if (!isStackSource(name)) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSynth(name), 300);
    });

    // Mantém o processo vivo
    await new Promise<void>(() => {});
  }
}
