// Canonical wrapper for the site's pre-submit check.
//
// The kit prints `kit <slug> dev: verified N files` on stderr. That is progress output,
// not a failure. This wrapper keeps the kit's full output, then prints one verdict line
// based on the command's exit code and its `N passed, N failed, ...` summary row, so an
// automation reading the output never mistakes stderr progress for a failed check.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kit = resolve(root, 'hidden-spec-cli-01-run-20261122-kit');
const cli = resolve(kit, 'cli/makefun.mjs');
const transcripts = resolve(root, 'transcripts.tar.gz');

const run = spawnSync(process.execPath, [
  cli, 'check', '--kit', kit, '--repo', root, '--transcripts', transcripts,
], { cwd: root, encoding: 'utf8' });

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
process.stdout.write(output);

const summaries = [...output.matchAll(/^(\d+) passed, (\d+) failed, (\d+) skipped, (\d+) checked at submission$/gm)];
const summary = summaries[summaries.length - 1];
const failed = summary === undefined ? (run.status === 0 ? 0 : 1) : Number(summary[2]);
const ok = run.status === 0 && failed === 0;

process.stdout.write(ok
  ? 'pre-submit check: PASS (no failed rows; kit progress on stderr is not a failure)\n'
  : `pre-submit check: FAIL (${failed} failed row(s), kit exit ${String(run.status)})\n`);
process.exitCode = ok ? 0 : 1;
