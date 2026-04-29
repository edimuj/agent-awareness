import test from 'node:test';
import assert from 'node:assert/strict';
import { removeAgentAwarenessHooksFromConfigTomlText, resolveCodexHome, resolveHooksJsonPath } from './codex-hooks.ts';

test('resolveCodexHome prefers CODEX_HOME when set', () => {
  const resolved = resolveCodexHome({ CODEX_HOME: '/tmp/custom-codex-home' }, '/home/example');
  assert.equal(resolved, '/tmp/custom-codex-home');
});

test('resolveCodexHome falls back to ~/.codex when CODEX_HOME is unset', () => {
  const resolved = resolveCodexHome({}, '/home/example');
  assert.equal(resolved, '/home/example/.codex');
});

test('resolveHooksJsonPath returns global path under CODEX_HOME', () => {
  const resolved = resolveHooksJsonPath(
    'global',
    '/work/repo',
    { CODEX_HOME: '/tmp/codex-home' },
    '/home/example',
  );
  assert.equal(resolved, '/tmp/codex-home/hooks.json');
});

test('resolveHooksJsonPath returns project hooks.json for project scope', () => {
  const resolved = resolveHooksJsonPath(
    'project',
    '/work/repo',
    { CODEX_HOME: '/tmp/codex-home' },
    '/home/example',
  );
  assert.equal(resolved, '/work/repo/.codex/hooks.json');
});

test('removeAgentAwarenessHooksFromConfigTomlText removes partial managed hook tables only', () => {
  const input = [
    '[[hooks.UserPromptSubmit]]',
    '[[hooks.UserPromptSubmit.hooks]]',
    'type = "command"',
    'command = "node \\"/repo/codex-plugin/hooks/codex-prompt-submit.mjs\\""',
    'timeout = 10',
    '# agent-awareness hooks: end',
    '',
    '[[hooks.SessionStart]]',
    'matcher = "startup|resume"',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    'command = "bun \'/agent-relay/codex/hooks/session-start.ts\'"',
    'timeout = 10',
    '',
  ].join('\n');

  const output = removeAgentAwarenessHooksFromConfigTomlText(input);

  assert.doesNotMatch(output, /codex-prompt-submit/);
  assert.doesNotMatch(output, /agent-awareness hooks/);
  assert.match(output, /agent-relay\/codex\/hooks\/session-start\.ts/);
  assert.match(output, /\[\[hooks\.SessionStart\.hooks\]\]/);
});
