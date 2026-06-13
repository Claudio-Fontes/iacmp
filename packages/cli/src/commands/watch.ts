import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

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
    const configPath = path.join(cwd, 'iacmp.json');

    if (!fs.existsSync(configPath)) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const provider = flags.provider ?? config.provider ?? 'aws';
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
      const name = filename ?? 'arquivo';
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSynth(name), 300);
    });

    // Mantém o processo vivo
    await new Promise<void>(() => {});
  }
}
