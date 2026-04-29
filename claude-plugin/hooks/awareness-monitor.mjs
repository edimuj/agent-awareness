import { ensureServer, connectSSE } from '../dist/daemon/client.js';
import { createHash } from 'node:crypto';

const SESSION_ID = `monitor-${process.pid}-${Date.now()}`;
const seen = new Map();
const MAX_RETRIES = 5;
let retries = 0;

async function connect() {
  let daemon;
  try {
    daemon = await ensureServer();
  } catch {
    daemon = null;
  }

  if (!daemon) {
    retries++;
    if (retries >= MAX_RETRIES) {
      console.log('[agent-awareness] daemon unavailable after retries, falling back to hook-only mode');
      process.exit(0);
    }
    setTimeout(connect, 10_000);
    return;
  }
  retries = 0;

  const stream = await connectSSE(daemon, SESSION_ID, 'claude-code');
  if (!stream) {
    setTimeout(connect, 10_000);
    return;
  }

  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const lines = part.split('\n');
      let eventType = '';
      let data = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
        else if (line.startsWith(':')) continue;
      }

      if (eventType === 'plugin-result' && data) {
        try {
          const result = JSON.parse(data);
          const fp = createHash('sha1').update(`${result.plugin}:${result.text}`).digest('hex');
          if (seen.get(result.plugin) === fp) continue;
          seen.set(result.plugin, fp);
          console.log(`[awareness:${result.plugin}] ${result.text}`);
        } catch { /* skip bad JSON */ }
      }
    }
  });

  stream.on('end', () => setTimeout(connect, 5_000));
  stream.on('error', () => setTimeout(connect, 5_000));
}

connect();
