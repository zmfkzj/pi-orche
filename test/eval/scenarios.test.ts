import { cp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gradeWorkspace, matchRootCause, prepareWorkspace, problemA } from '../../src/eval/scenarios.js';

describe('problem A grading', () => {
  it('keeps visible tests green, exposes the bug, and grades the reference fix without modifying the workspace', async () => {
    const workspace = await prepareWorkspace();
    try {
      expect(await readdir(workspace.dir)).not.toContain('problem-a.hidden');
      expect((await stat(join(workspace.dir, '.git', 'HEAD'))).isFile()).toBe(true);
      const sourceBefore = await readFile(join(workspace.dir, 'src/token-cache.js'), 'utf8');
      const buggy = await gradeWorkspace(workspace.dir);
      expect(buggy.visible.passed, buggy.visible.stdout + buggy.visible.stderr).toBe(true);
      expect(buggy.hidden.passed).toBe(false);
      expect(buggy.hidden.stdout).toContain('late rejection of an old credential');
      expect(buggy.hidden.stdout).toContain('identity budget exceeded');
      expect(await readdir(join(workspace.dir, 'test'))).not.toContain('acceptance.hidden.test.js');
      expect(await readFile(join(workspace.dir, 'src/token-cache.js'), 'utf8')).toBe(sourceBefore);
      await cp(join(problemA.hiddenDir, 'reference-fix'), workspace.dir, { recursive: true });
      const fixed = await gradeWorkspace(workspace.dir);
      expect(fixed.passed, fixed.visible.stdout + fixed.hidden.stdout + fixed.hidden.stderr).toBe(true);
      expect(await readdir(join(workspace.dir, 'test'))).not.toContain('acceptance.hidden.test.js');
    } finally {
      await workspace.cleanup();
    }
  }, 30_000);

  it('bounds a hung grading process and leaves the workspace untouched', async () => {
    const workspace = await prepareWorkspace();
    try {
      const hung = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n';
      await writeFile(join(workspace.dir, 'test/hung.test.js'), hung);
      // Exercises execFile's OS-process deadline; fake clocks cannot kill a real child.
      const grade = await gradeWorkspace(workspace.dir, problemA, 500);
      expect(grade.visible.passed).toBe(false);
      expect(grade.visible.timedOut).toBe(true);
      expect(await readFile(join(workspace.dir, 'test/hung.test.js'), 'utf8')).toBe(hung);
    } finally {
      await workspace.cleanup();
    }
  }, 10_000);

  it('recognizes the causal claim rather than a plausible distractor', () => {
    const correct = matchRootCause('src/token-cache.js unconditionally invalidates the cached credential: a late 401 for an old token discards the newer replacement. Pass the rejected token to invalidate.');
    expect(correct.matched).toBe(true);
    expect(correct.score).toBe(1);
    expect(matchRootCause('The expiry skew in the clock module is too large and the retry policy needs more attempts.').matched).toBe(false);
    expect(matchRootCause('Token cache invalidation is broken.').matched).toBe(false);
    expect(matchRootCause('').score).toBe(0);
  });

  it.each(['TokenCache.invalidate()', 'token_cache', 'tokenCache.invalidate'])('recognizes an accurate causal claim using %s', identifier => {
    const result = matchRootCause(`${identifier} unconditionally invalidates the cache: a late 401 for an old token discards the newer replacement.`);
    expect(result.matched).toBe(true);
    expect(result.score).toBe(1);
  });

  it('normalizes ground-truth keywords as well as claim identifiers', () => {
    const groundTruth = {
      ...problemA.groundTruth,
      keywordGroups: [['TokenCache.invalidate'], ['oldToken'], ['newer_token']],
    };
    expect(matchRootCause('token-cache/INVALIDATE clears old.token instead of preserving newer-token', groundTruth).matched).toBe(true);
  });

  it.each([
    'The cache erases a fresh credential when an earlier request reports unauthorized, even though renewal has finished.',
    'invalidate() handles a rejected token by wiping the valid token installed by another request.',
    'A previous credential failure makes cache invalidation discard the current credential instead of checking which one failed.',
    'A stale request clears the shared cache after a new token has already been published.',
  ])('recognizes a causal paraphrase: %s', claim => {
    expect(matchRootCause(claim).matched).toBe(true);
  });

  it.each([
    'The clock expiry skew makes the cache refresh valid tokens too early; delayed 401 responses are only a symptom of clock drift.',
    'The retry policy classifies a late 401 incorrectly, so it exhausts retry attempts while a replacement token is available.',
    'Promise.all aggregation loses the fresh token response when an older account request fails with 401; the invoice service should aggregate differently.',
    'The expiry comparison retains an old token past its lifetime; refresh needs a larger safety window in the clock module before a new credential is fetched.',
  ])('rejects an independent-cause distractor: %s', claim => {
    expect(matchRootCause(claim).matched).toBe(false);
  });
});
