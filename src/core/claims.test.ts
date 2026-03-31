import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createClaimContext, pruneExpiredClaims, CLAIMS_DIR } from './claims.ts';

afterEach(async () => {
  await rm(CLAIMS_DIR, { recursive: true, force: true });
});

describe('createClaimContext', () => {
  it('claims an unclaimed event', async () => {
    const ctx = createClaimContext('test-plugin');
    const result = await ctx.tryClaim('event-1');
    assert.equal(result.claimed, true);
  });

  it('allows re-claiming own event (TTL refresh)', async () => {
    const ctx = createClaimContext('test-plugin');
    await ctx.tryClaim('event-1');
    const result = await ctx.tryClaim('event-1');
    assert.equal(result.claimed, true);
  });

  it('blocks claim held by another live PID', async () => {
    const ctx = createClaimContext('test-plugin');

    // Fake a claim from PID 1 (init — always alive on Linux)
    const claimDir = join(CLAIMS_DIR, 'test-plugin');
    await mkdir(claimDir, { recursive: true });
    await writeFile(join(claimDir, 'event-1.json'), JSON.stringify({
      holder: `${hostname()}:1`,
      pid: 1,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }));

    const result = await ctx.tryClaim('event-1');
    assert.equal(result.claimed, false);
    assert.equal(result.holder, `${hostname()}:1`);
  });

  it('reclaims expired event', async () => {
    const ctx = createClaimContext('test-plugin');

    // Fake an expired claim
    const claimDir = join(CLAIMS_DIR, 'test-plugin');
    await mkdir(claimDir, { recursive: true });
    await writeFile(join(claimDir, 'event-1.json'), JSON.stringify({
      holder: `${hostname()}:1`,
      pid: 1,
      claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    }));

    const result = await ctx.tryClaim('event-1');
    assert.equal(result.claimed, true);
  });

  it('reclaims event from dead PID', async () => {
    const ctx = createClaimContext('test-plugin');

    // Fake a claim from a dead PID
    const claimDir = join(CLAIMS_DIR, 'test-plugin');
    await mkdir(claimDir, { recursive: true });
    await writeFile(join(claimDir, 'event-1.json'), JSON.stringify({
      holder: `${hostname()}:999999999`,
      pid: 999999999,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }));

    const result = await ctx.tryClaim('event-1');
    assert.equal(result.claimed, true);
  });

  it('isClaimedByOther returns false for own claim', async () => {
    const ctx = createClaimContext('test-plugin');
    await ctx.tryClaim('event-1');
    assert.equal(await ctx.isClaimedByOther('event-1'), false);
  });

  it('isClaimedByOther returns true for foreign claim', async () => {
    const ctx = createClaimContext('test-plugin');

    const claimDir = join(CLAIMS_DIR, 'test-plugin');
    await mkdir(claimDir, { recursive: true });
    await writeFile(join(claimDir, 'event-1.json'), JSON.stringify({
      holder: `${hostname()}:1`,
      pid: 1,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }));

    assert.equal(await ctx.isClaimedByOther('event-1'), true);
  });

  it('release removes own claim', async () => {
    const ctx = createClaimContext('test-plugin');
    await ctx.tryClaim('event-1');
    await ctx.release('event-1');
    assert.equal(await ctx.isClaimedByOther('event-1'), false);

    // Should be claimable again
    const result = await ctx.tryClaim('event-1');
    assert.equal(result.claimed, true);
  });

  it('release does not remove foreign claim', async () => {
    const ctx = createClaimContext('test-plugin');

    const claimDir = join(CLAIMS_DIR, 'test-plugin');
    await mkdir(claimDir, { recursive: true });
    await writeFile(join(claimDir, 'event-1.json'), JSON.stringify({
      holder: `${hostname()}:1`,
      pid: 1,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }));

    await ctx.release('event-1');
    // Should still be claimed by PID 1
    assert.equal(await ctx.isClaimedByOther('event-1'), true);
  });

  it('sanitizes event keys with special characters', async () => {
    const ctx = createClaimContext('pr-pilot');
    const result = await ctx.tryClaim('vercel/next.js#4521:checks_failed');
    assert.equal(result.claimed, true);

    // Should be retrievable
    assert.equal(await ctx.isClaimedByOther('vercel/next.js#4521:checks_failed'), false);
  });

  it('scopes claims per plugin', async () => {
    const ctxA = createClaimContext('plugin-a');
    const ctxB = createClaimContext('plugin-b');

    await ctxA.tryClaim('event-1');
    // Different plugin, same event key — should succeed
    const result = await ctxB.tryClaim('event-1');
    assert.equal(result.claimed, true);
  });
});

describe('pruneExpiredClaims', () => {
  it('returns 0 when no claims dir exists', async () => {
    assert.equal(await pruneExpiredClaims(), 0);
  });

  it('prunes expired claims', async () => {
    const claimDir = join(CLAIMS_DIR, 'test-plugin');
    await mkdir(claimDir, { recursive: true });

    // Expired claim
    await writeFile(join(claimDir, 'old.json'), JSON.stringify({
      holder: `${hostname()}:${process.pid}`,
      pid: process.pid,
      claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    }));

    // Live claim
    await writeFile(join(claimDir, 'fresh.json'), JSON.stringify({
      holder: `${hostname()}:${process.pid}`,
      pid: process.pid,
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }));

    const pruned = await pruneExpiredClaims();
    assert.equal(pruned, 1);

    // Fresh claim should survive
    const ctx = createClaimContext('test-plugin');
    assert.equal(await ctx.isClaimedByOther('fresh'), false);
  });
});
