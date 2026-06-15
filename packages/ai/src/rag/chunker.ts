import * as fs from 'fs';
import * as path from 'path';

export interface Chunk {
  id: string;
  content: string;
  contextualContent?: string; // preenchido pelo contextualizer após enriquecimento
  metadata: {
    source: 'project-stack' | 'iacmp-docs' | 'platform-knowledge';
    file?: string;
    stackName?: string;
    constructType?: string;
    constructId?: string;
    section?: string;
    platform?: 'aws' | 'azure' | 'gcp' | 'cross-cloud';
  };
}

// Divide um arquivo .ts de stack em chunks por construct
export function chunkStackFile(filePath: string, projectDir: string): Chunk[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rel = path.relative(projectDir, filePath);
  const stackName = path.basename(filePath, '.ts');
  const chunks: Chunk[] = [];

  // Extrai blocos new Xxx.Yyy(stack, 'Id', { ... })
  const constructRegex = /new\s+([\w]+\.[\w]+)\s*\(\s*\w+\s*,\s*'([\w-]+)'\s*,\s*(\{[\s\S]*?\})\s*\)/g;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = constructRegex.exec(content)) !== null) {
    const constructType = match[1];
    const constructId = match[2];
    const propsRaw = match[3];

    chunks.push({
      id: `stack:${rel}:${constructId}`,
      content: `[construct] ${constructType} "${constructId}" em ${rel}\n${propsRaw}`,
      metadata: {
        source: 'project-stack',
        file: rel,
        stackName,
        constructType,
        constructId,
      },
    });
    index++;
  }

  // Se nenhum construct foi encontrado, chunk do arquivo inteiro
  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push({
      id: `stack:${rel}:full`,
      content: `[stack] ${stackName} em ${rel}\n${content}`,
      metadata: {
        source: 'project-stack',
        file: rel,
        stackName,
      },
    });
  }

  return chunks;
}

// Divide o system-prompt em chunks por seção de construct
export function chunkIacmpDocs(systemPromptTemplate: string): Chunk[] {
  const chunks: Chunk[] = [];

  // Divide por blocos ### NomeConstruct
  const sections = systemPromptTemplate.split(/(?=^### )/m);

  for (const section of sections) {
    const titleMatch = section.match(/^### (.+)/);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    const trimmed = section.trim();
    if (trimmed.length < 30) continue;

    chunks.push({
      id: `docs:${title.replace(/[^a-zA-Z0-9]/g, '-')}`,
      content: trimmed,
      metadata: {
        source: 'iacmp-docs',
        section: title,
      },
    });
  }

  return chunks;
}

// Divide um arquivo markdown de conhecimento de plataforma em chunks por seção
export function chunkKnowledgeFile(
  filePath: string,
  platform: 'aws' | 'azure' | 'gcp' | 'cross-cloud',
): Chunk[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath, '.md');
  const chunks: Chunk[] = [];

  // Divide por seções ## ou ###
  const sections = content.split(/(?=^#{1,3} )/m);

  for (const section of sections) {
    const titleMatch = section.match(/^#{1,3} (.+)/);
    const title = titleMatch ? titleMatch[1].trim() : fileName;
    const trimmed = section.trim();

    // Ignora seções muito curtas
    if (trimmed.length < 50) continue;

    // Seções grandes (>2000 chars) são subdivididas por parágrafo
    if (trimmed.length > 2000) {
      const paragraphs = trimmed.split(/\n\n+/);
      let buffer = '';
      let bufferIndex = 0;

      for (const para of paragraphs) {
        buffer += para + '\n\n';
        if (buffer.length > 800) {
          chunks.push({
            id: `knowledge:${platform}:${fileName}:${title.replace(/[^a-zA-Z0-9]/g, '-')}-${bufferIndex}`,
            content: `[${platform.toUpperCase()}] ${title}\n\n${buffer.trim()}`,
            metadata: {
              source: 'platform-knowledge',
              platform,
              file: path.basename(filePath),
              section: title,
            },
          });
          buffer = '';
          bufferIndex++;
        }
      }

      if (buffer.trim().length > 50) {
        chunks.push({
          id: `knowledge:${platform}:${fileName}:${title.replace(/[^a-zA-Z0-9]/g, '-')}-${bufferIndex}`,
          content: `[${platform.toUpperCase()}] ${title}\n\n${buffer.trim()}`,
          metadata: {
            source: 'platform-knowledge',
            platform,
            file: path.basename(filePath),
            section: title,
          },
        });
      }
    } else {
      chunks.push({
        id: `knowledge:${platform}:${fileName}:${title.replace(/[^a-zA-Z0-9]/g, '-')}`,
        content: `[${platform.toUpperCase()}] ${title}\n\n${trimmed}`,
        metadata: {
          source: 'platform-knowledge',
          platform,
          file: path.basename(filePath),
          section: title,
        },
      });
    }
  }

  return chunks;
}
