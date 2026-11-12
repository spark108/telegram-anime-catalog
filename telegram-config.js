const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseEnv } = require('node:util');

const filename = path.join(__dirname, '.env');

function readEnvFile() {
  try { return fs.readFileSync(filename, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function parseCredentials(apiId, apiHash) {
  const id = Number(apiId);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof apiHash !== 'string' || !/^[\da-f]{32}$/i.test(apiHash)) return null;
  return { apiId: id, apiHash: apiHash.toLowerCase() };
}

function readCredentials() {
  const values = parseEnv(readEnvFile());
  return parseCredentials(values.TELEGRAM_API_ID, values.TELEGRAM_API_HASH);
}

function saveCredentials({ apiId, apiHash }) {
  const previous = readCredentials();
  if (previous?.apiId === apiId && previous.apiHash === apiHash) return;
  const otherLines = readEnvFile().split(/\r?\n/)
    .filter(line => !/^\s*(?:export\s+)?TELEGRAM_API_(?:ID|HASH)\s*=/.test(line)).join('\n');
  const separator = otherLines && !otherLines.endsWith('\n') ? '\n' : '';
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, `${otherLines}${separator}TELEGRAM_API_ID=${apiId}\nTELEGRAM_API_HASH=${apiHash}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function credentialFingerprint({ apiId, apiHash }) {
  return createHash('sha256').update(`${apiId}:${apiHash}`).digest('hex');
}

module.exports = { parseCredentials, readCredentials, saveCredentials, credentialFingerprint };
