export interface StackInfo {
  name: string;
  provider: string;
  resources: Array<{ type: string; id: string }>;
}

export interface ProjectInfo {
  name: string;
  provider: string;
  region: string;
  stacks: StackInfo[];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStackCard(stack: StackInfo): string {
  const resourceRows = stack.resources.map(r => `
        <tr>
          <td class="res-type">${escapeHtml(r.type)}</td>
          <td class="res-id">${escapeHtml(r.id)}</td>
        </tr>`).join('');

  const resourceTable = stack.resources.length > 0 ? `
      <table class="res-table">
        <thead>
          <tr><th>Tipo</th><th>ID lógico</th></tr>
        </thead>
        <tbody>${resourceRows}
        </tbody>
      </table>` : `<p class="empty">Nenhum recurso sintetizado.</p>`;

  return `
    <div class="card">
      <div class="card-header">
        <span class="stack-name">${escapeHtml(stack.name)}</span>
        <span class="badge">${stack.resources.length} recurso(s)</span>
      </div>
      ${resourceTable}
    </div>`;
}

export function generateHtml(info: ProjectInfo): string {
  const cards = info.stacks.length > 0
    ? info.stacks.map(renderStackCard).join('\n')
    : '<p class="empty-project">Nenhuma stack sintetizada. Rode <code>iacmp synth</code>.</p>';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iacmp Dashboard — ${escapeHtml(info.name)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f1117;
      color: #e2e8f0;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      min-height: 100vh;
    }
    header {
      background: #1a1f2e;
      border-bottom: 1px solid #2d3748;
      padding: 16px 32px;
      display: flex;
      align-items: center;
      gap: 24px;
    }
    .logo {
      font-size: 18px;
      font-weight: 700;
      color: #63b3ed;
      letter-spacing: -0.5px;
    }
    .logo span { color: #e2e8f0; }
    .meta {
      display: flex;
      gap: 16px;
      color: #718096;
      font-size: 13px;
    }
    .meta strong { color: #a0aec0; }
    main {
      padding: 32px;
      max-width: 960px;
      margin: 0 auto;
    }
    h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #718096;
      margin-bottom: 16px;
    }
    .card {
      background: #1a1f2e;
      border: 1px solid #2d3748;
      border-radius: 8px;
      margin-bottom: 20px;
      overflow: hidden;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      border-bottom: 1px solid #2d3748;
      background: #161b27;
    }
    .stack-name {
      font-weight: 600;
      font-size: 15px;
      color: #e2e8f0;
    }
    .badge {
      background: #2d3748;
      color: #a0aec0;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 12px;
    }
    .res-table {
      width: 100%;
      border-collapse: collapse;
    }
    .res-table thead tr {
      background: #141820;
    }
    .res-table th {
      text-align: left;
      padding: 8px 20px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #4a5568;
      font-weight: 600;
    }
    .res-table tbody tr {
      border-top: 1px solid #1e2533;
    }
    .res-table tbody tr:hover { background: #1e2533; }
    .res-type {
      padding: 10px 20px;
      color: #68d391;
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 13px;
    }
    .res-id {
      padding: 10px 20px;
      color: #a0aec0;
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 13px;
    }
    .empty { padding: 20px; color: #4a5568; }
    .empty-project { color: #4a5568; padding: 16px 0; }
    .empty-project code {
      background: #1a1f2e;
      padding: 2px 6px;
      border-radius: 4px;
      color: #63b3ed;
    }
    footer {
      text-align: center;
      padding: 24px;
      color: #2d3748;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div class="logo">iacmp <span>Dashboard</span></div>
    <div class="meta">
      <span><strong>Projeto:</strong> ${escapeHtml(info.name)}</span>
      <span><strong>Provider:</strong> ${escapeHtml(info.provider)}</span>
      <span><strong>Região:</strong> ${escapeHtml(info.region)}</span>
      <span><strong>Stacks:</strong> ${info.stacks.length}</span>
    </div>
  </header>
  <main>
    <h2>Stacks sintetizadas</h2>
    ${cards}
  </main>
  <footer>iacmp v0.4.0 — atualizado em ${new Date().toLocaleString('pt-BR')}</footer>
</body>
</html>
`;
}
