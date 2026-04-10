import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const candidates = [
  join(__dirname, '..', 'dist', 'hooks', 'codex-prompt-submit.js'),
  join(__dirname, '..', '..', 'dist', 'hooks', 'codex-prompt-submit.js'),
  join(__dirname, '..', '..', 'src', 'hooks', 'codex-prompt-submit.ts'),
];

let target = null;
for (const candidate of candidates) {
  try {
    await access(candidate);
    target = candidate;
    break;
  } catch {
    // Try the next packaged or repo-local fallback.
  }
}

if (!target) {
  throw new Error('Unable to resolve Codex prompt-submit hook entrypoint.');
}

await import(pathToFileURL(target).href);
