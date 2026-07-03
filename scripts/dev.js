// =========================================================================
// Moravo Launcher (dev local)
// Roda `npm run dev` na raiz e abre o site no navegador.
// =========================================================================
const path = require('path');
const { spawn, execSync, exec } = require('child_process');

const rootDir = path.join(__dirname, '..');
const nodeModulesExist = require('fs').existsSync(path.join(rootDir, 'node_modules'));

// 1. Instala dependências se necessário
if (!nodeModulesExist) {
  console.log('\n[Moravo Launcher] node_modules não encontrado. Instalando dependências...\n');
  try {
    execSync('npm install', { cwd: rootDir, stdio: 'inherit', shell: true });
    console.log('\n[Moravo Launcher] Dependências instaladas com sucesso!\n');
  } catch (err) {
    console.error('[Moravo Launcher] Erro ao instalar dependências:', err.message);
    process.exit(1);
  }
}

// 2. Inicia o servidor em modo watch
console.log('[Moravo Launcher] Iniciando o servidor...');
const server = spawn('npm', ['run', 'dev'], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: true
});

server.on('error', (err) => {
  console.error('[Moravo Launcher] Falha ao iniciar o servidor:', err);
});

// 3. Aguarda 2s e abre o site no navegador
setTimeout(() => {
  const port = process.env.PORT || '3000';
  const url = `http://127.0.0.1:${port}`;
  console.log(`\n[Moravo Launcher] Abrindo: ${url}\n`);

  let command;
  if (process.platform === 'win32') {
    command = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      console.warn('[Moravo Launcher] Não foi possível abrir o navegador automaticamente:', err.message);
      console.log(`Abra manualmente em: ${url}`);
    }
  });
}, 2000);
