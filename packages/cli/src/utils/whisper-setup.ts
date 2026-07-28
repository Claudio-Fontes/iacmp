import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

// Modelo "base" balanceia tamanho de download (~148MB) com qualidade suficiente
// para detectar pt/en/es — é o mesmo mirror usado pelo script oficial
// models/download-ggml-model.sh do whisper.cpp.
export const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';

export function defaultWhisperModelPath(): string {
  return path.join(os.homedir(), '.iacmp', 'whisper-models', 'ggml-base.bin');
}

// Só cria o arquivo de destino depois de confirmar um 200 — evita criar/remover/recriar
// o write stream no mesmo caminho a cada redirecionamento (HuggingFace redireciona para a CDN).
export function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (currentUrl: string) => {
      https
        .get(currentUrl, response => {
          const { statusCode, headers } = response;
          if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
            request(headers.location);
            return;
          }
          if (statusCode !== 200) {
            reject(new Error(`download falhou: HTTP ${statusCode}`));
            return;
          }

          const file = fs.createWriteStream(dest);
          response.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', err => {
            fs.rmSync(dest, { force: true });
            reject(err);
          });
        })
        .on('error', reject);
    };
    request(url);
  });
}

export function upsertEnvVar(cwd: string, key: string, value: string): void {
  const envPath = path.join(cwd, '.env');
  const examplePath = path.join(cwd, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
  }

  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const lineRegex = new RegExp(`^${key}=.*$`, 'm');
  const newContent = lineRegex.test(content)
    ? content.replace(lineRegex, `${key}=${value}`)
    : content + (content === '' || content.endsWith('\n') ? '' : '\n') + `${key}=${value}\n`;

  fs.writeFileSync(envPath, newContent);
}

export async function downloadDefaultWhisperModel(cwd: string): Promise<string> {
  const dest = defaultWhisperModelPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) {
    await downloadFile(WHISPER_MODEL_URL, dest);
  }
  upsertEnvVar(cwd, 'IACMP_WHISPER_MODEL', dest);
  return dest;
}
