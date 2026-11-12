const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { setTimeout: wait } = require('node:timers/promises');

const root = __dirname;
const defaultPort = 8187;
const windows = process.platform === 'win32';

async function askPort() {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  input.setPrompt(`Порт [${defaultPort}]: `);
  input.prompt();
  try {
    for await (const line of input) {
      const value = line.trim();
      if (!value) return defaultPort;
      const port = Number(value);
      if (/^\d+$/.test(value) && Number.isInteger(port) && port >= 1 && port <= 65535) return port;
      console.error('Введите порт от 1 до 65535 или нажмите Enter.');
      input.prompt();
    }
    throw new Error('Ввод порта прерван.');
  } finally {
    input.close();
  }
}

async function runNpm(args, stdio) {
  // npm is a CMD script on Windows. The arguments here are fixed by the launcher.
  const child = windows
    ? spawn('cmd.exe', ['/d', '/c', 'npm', ...args], { cwd: root, stdio, windowsHide: true })
    : spawn('npm', args, { cwd: root, stdio });
  const [code] = await once(child, 'exit');
  return code === 0;
}

async function ensureDependencies() {
  const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
  const fingerprint = createHash('sha256').update(lock).update(process.versions.modules).digest('hex');
  const stamp = path.join(root, 'node_modules', '.catalog-dependencies');
  const installed = fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === fingerprint;
  if (installed && await runNpm(['ls', '--all', '--omit=dev', '--silent'], 'ignore')) return;

  console.log('Устанавливаем зависимости…');
  if (!await runNpm(['ci', '--no-audit', '--no-fund'], 'inherit')) {
    throw new Error('Не удалось установить зависимости. Проверьте вывод npm.');
  }
  fs.writeFileSync(stamp, fingerprint);
}

async function catalogReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    if (!response.ok) return false;
    const html = await response.text();
    return html.includes('<title>Аниме из Telegram</title>') && html.includes('id="catalog-filters"');
  } catch {
    return false;
  }
}

async function startServer(port, url) {
  const data = path.resolve(root, process.env.ANIME_CATALOG_DATA || 'data');
  fs.mkdirSync(data, { recursive: true });
  const log = path.join(data, 'server.log');
  const output = fs.openSync(log, 'a');
  let child;
  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: root, env: { ...process.env, ANIME_CATALOG_PORT: String(port) },
      detached: true, windowsHide: true, stdio: ['ignore', output, output]
    });
    await once(child, 'spawn');
  } finally {
    fs.closeSync(output);
  }

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await catalogReady(url)) {
      child.unref();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await wait(200);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
  throw new Error(`Каталог не запустился на порту ${port}. Журнал: ${log}`);
}

async function openBrowser(url) {
  let commands;
  if (windows) commands = [['rundll32.exe', 'url.dll,FileProtocolHandler']];
  else if (process.platform === 'darwin') commands = [['open']];
  else if (process.env.WSL_DISTRO_NAME) commands = [['wslview'], ['explorer.exe']];
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) commands = [['xdg-open'], ['gio', 'open']];
  else return;

  for (const [command, ...args] of commands) {
    try {
      const child = spawn(command, [...args, url], { detached: true, windowsHide: true, stdio: 'ignore' });
      await once(child, 'spawn');
      child.unref();
      return;
    } catch {
      // Try the next available system opener.
    }
  }
}

async function main() {
  const port = await askPort();
  await ensureDependencies();
  const url = `http://127.0.0.1:${port}/`;
  if (!await catalogReady(url)) await startServer(port, url);
  console.log(`Каталог доступен: ${url}`);
  await openBrowser(url);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
