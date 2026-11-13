const { execFile } = require('node:child_process');
const { access, readFile } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const git = promisify(execFile);
const commitHash = /^[0-9a-f]{40}$/i;
const github = 'https://api.github.com/repos/spark108/telegram-anime-catalog';

async function localRevision(root) {
  try {
    await access(path.join(root, '.git'));
    const { stdout } = await git('git', ['rev-parse', 'HEAD'], {
      cwd: root, timeout: 3000, windowsHide: true
    });
    const hash = stdout.trim();
    if (commitHash.test(hash)) return hash;
  } catch {
    // ZIP installations carry the commit in revision.txt.
  }
  const hash = (await readFile(path.join(root, 'revision.txt'), 'utf8').catch(() => '')).trim();
  return commitHash.test(hash) ? hash : null;
}

async function githubRequest(endpoint, accept) {
  const response = await fetch(github + endpoint, {
    headers: { Accept: accept, 'User-Agent': 'TelegramAnimeCatalog' },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('GitHub: ' + response.status);
  return response;
}

function createUpdateCheck(root) {
  // Keep the revision of the running server even if git pull runs before a restart.
  const revision = localRevision(root);
  let result;
  let expires = 0;
  let pending;

  async function check() {
    const current = await revision;
    if (!current) return { status: 'unknown', current };
    try {
      const response = await githubRequest('/commits/main', 'application/vnd.github.sha');
      const latest = (await response.text()).trim();
      if (!commitHash.test(latest)) throw new Error('GitHub returned an invalid revision');
      if (latest === current) return { status: 'current', current, latest };
      const comparison = await githubRequest('/compare/' + current + '...' + latest + '?per_page=1',
        'application/vnd.github+json');
      const { status, ahead_by: ahead } = await comparison.json();
      if (!['ahead', 'behind', 'diverged', 'identical'].includes(status)) throw new Error('Invalid comparison');
      return { status: ahead > 0 ? 'available' : 'current', current, latest };
    } catch {
      return { status: 'unavailable', current };
    }
  }

  return async () => {
    if (Date.now() < expires) return result;
    if (!pending) {
      pending = check().then(next => {
        result = next;
        expires = Date.now() + (next.status === 'unavailable' ? 60_000 : 15 * 60_000);
        return next;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
}

module.exports = { createUpdateCheck };
