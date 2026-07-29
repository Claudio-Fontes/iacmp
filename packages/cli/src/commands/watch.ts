import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { t } from '../i18n';
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
  static description = t('Monitora stacks/ e sintetiza automaticamente ao detectar mudanças', 'Watches stacks/ and synthesizes automatically when changes are detected');

  static flags = {
    provider: Flags.string({ char: 'p', description: t('Provider alvo (aws, azure, gcp, terraform)', 'Target provider (aws, azure, gcp, terraform)'), default: 'aws' }),
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
      this.error(t('Projeto não inicializado. Rode: iacmp init', 'Project not initialized. Run: iacmp init'));
    }
    const provider = resolveProvider(config, flags.provider);
    const stacksDir = path.join(cwd, 'stacks');

    if (!fs.existsSync(stacksDir)) {
      this.error(t('Diretório stacks/ não encontrado.', 'stacks/ directory not found.'));
    }

    this.log(t(`Monitorando stacks/ — pressione Ctrl+C para parar`, `Watching stacks/ — press Ctrl+C to stop`));

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const runSynth = (changedFile: string) => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      this.log(t(`[${hh}:${mm}:${ss}] Mudança detectada em ${changedFile} — sintetizando...`, `[${hh}:${mm}:${ss}] Change detected in ${changedFile} — synthesizing...`));

      const cliBin = path.resolve(__dirname, '../../bin/run.js');
      const cmd = `node "${cliBin}" synth --provider ${provider}`;

      try {
        execSync(cmd, { cwd, stdio: 'pipe' });
        this.log(t(`✓ Sintetizado em synth-out/`, `✓ Synthesized to synth-out/`));
      } catch (err) {
        this.log(t(`✗ Erro ao sintetizar — veja acima`, `✗ Error synthesizing — see above`));
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
