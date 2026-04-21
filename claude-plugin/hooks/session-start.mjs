import { ensureServer, gatherFromDaemon } from '../dist/daemon/client.js';
import { run } from '../dist/providers/claude-code/adapter.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// Read stdin to get source (startup|resume|compact|clear) and prevent EPIPE
let source = 'startup';
if (!process.stdin.isTTY) {
  const chunks = [];
  await new Promise(resolve => {
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', resolve);
    setTimeout(resolve, 500);
  });
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input.source) source = input.source;
  } catch { /* no valid JSON — default to startup */ }
}

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  ?? dirname(fileURLToPath(import.meta.url)).replace(/\/hooks$/, '');

let output = '';
let daemonAvailable = false;

try {
  const daemon = await ensureServer();
  if (daemon) {
    daemonAvailable = true;
    output = await gatherFromDaemon(daemon, 'session-start');
  }
} catch {
  // Daemon failed — fall through to Tier 1
}

if (!output) {
  output = await run('session-start');
}

if (output) process.stdout.write(output);

// Only emit Monitor instruction on fresh start/resume — not compact/clear
// (the Monitor from the original startup is still running)
if (daemonAvailable && (source === 'startup' || source === 'resume')) {
  const monitorScript = join(pluginRoot, 'hooks', 'awareness-monitor.mjs');
  process.stdout.write([
    '',
    '',
    `IMPORTANT: Start a persistent Monitor NOW for real-time awareness updates:`,
    `  Monitor({ command: "node \\"${monitorScript}\\"", description: "Agent awareness real-time updates", persistent: true })`,
    `You MUST start this Monitor immediately at session start. Do not wait for the user to ask.`,
  ].join('\n'));
}
