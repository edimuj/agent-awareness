import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGitHubRepoSlug } from './session-context.ts';

test('parseGitHubRepoSlug parses https remotes', () => {
  assert.equal(
    parseGitHubRepoSlug('https://github.com/Owner/My-Repo.git'),
    'owner/my-repo',
  );
});

test('parseGitHubRepoSlug parses ssh remotes', () => {
  assert.equal(
    parseGitHubRepoSlug('git@github.com:Owner/My-Repo.git'),
    'owner/my-repo',
  );
});

test('parseGitHubRepoSlug rejects non-github remotes', () => {
  assert.equal(
    parseGitHubRepoSlug('git@gitlab.com:Owner/My-Repo.git'),
    null,
  );
});
