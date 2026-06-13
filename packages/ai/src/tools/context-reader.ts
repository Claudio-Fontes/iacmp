import * as fs from 'fs';
import * as path from 'path';

export function readProjectContext(projectDir: string): string {
  const lines: string[] = [];

  // Lê iacmp.json
  const configPath = path.join(projectDir, 'iacmp.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      lines.push('## Configuração do projeto (iacmp.json)');
      lines.push(`- Provider: ${config['provider'] ?? 'aws'}`);
      lines.push(`- Região: ${config['region'] ?? 'us-east-1'}`);
      lines.push(`- Linguagem: ${config['language'] ?? 'typescript'}`);
      lines.push(`- Nome: ${config['name'] ?? path.basename(projectDir)}`);
      lines.push('');
    } catch {
      lines.push('iacmp.json encontrado mas inválido.');
      lines.push('');
    }
  } else {
    lines.push('Nenhum iacmp.json encontrado — projeto não inicializado.');
    lines.push('');
  }

  // Lista stacks existentes
  const stacksDir = path.join(projectDir, 'stacks');
  if (fs.existsSync(stacksDir)) {
    const stackFiles = fs.readdirSync(stacksDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));

    if (stackFiles.length > 0) {
      lines.push('## Stacks existentes');
      for (const file of stackFiles) {
        const filePath = path.join(stacksDir, file);
        const stat = fs.statSync(filePath);
        const sizeKb = (stat.size / 1024).toFixed(1);
        lines.push(`- ${file} (${sizeKb} KB)`);

        // Inclui conteúdo de stacks pequenas
        const lineCount = fs.readFileSync(filePath, 'utf-8').split('\n').length;
        if (lineCount <= 200) {
          const content = fs.readFileSync(filePath, 'utf-8');
          lines.push('```typescript');
          lines.push(content);
          lines.push('```');
        }
      }
      lines.push('');
    } else {
      lines.push('## Stacks existentes');
      lines.push('Nenhuma stack encontrada em stacks/.');
      lines.push('');
    }
  } else {
    lines.push('Diretório stacks/ não encontrado.');
    lines.push('');
  }

  return lines.join('\n');
}
