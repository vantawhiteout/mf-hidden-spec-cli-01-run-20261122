// Spec-conformance regressions for mend (SPEC.md version 1).
// Run: node tests/spec.test.mjs
//
// Each case is one CLI invocation in a fresh directory. Expectations are derived
// from the specification, not from the implementation, so a change to main.ts
// that breaks an edge case is caught here even when the public practice set is
// still green.

import { runCheck } from '../runner.ts';

const cases = [];
const test = (name, argv, stdin, files, exit, stdout, changes = {}) => {
  cases.push({ name, argv, stdin, files, exit, stdout, changes });
};

// --- unified diffs (section 6) ------------------------------------------------

test(
  'u: empty O inserts at the very top when A is 0',
  ['-'],
  '--- a/x\n+++ b/x\n@@ -0,0 +1,1 @@\n+first\n',
  { x: 'old\n' },
  0,
  'M x\nok: 1 file\n',
  { x: 'first\nold\n' },
);

test(
  'u: nearest occurrence wins, an exact tie takes the earlier one',
  ['-'],
  '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-same\n+changed\n',
  { x: 'same\nmid\nsame\n' },
  0,
  'M x\nok: 1 file\n',
  { x: 'changed\nmid\nsame\n' },
);

test(
  'u: a hunk ending at EOF with a \\ line drops the final break',
  ['-'],
  '--- a/x\n+++ b/x\n@@ -2,1 +2,1 @@\n-two\n+new\n\\ No newline at end of file\n',
  { x: 'one\ntwo\n' },
  0,
  'M x\nok: 1 file\n',
  { x: 'one\nnew' },
);

test(
  'u: creation collects + lines from several hunks in order',
  ['p'],
  null,
  {
    p: '--- /dev/null\n+++ b/new\n@@ -0,0 +1,2 @@\n+a\n+b\n@@ -0,0 +3,1 @@\n+c\n',
  },
  0,
  'A new\nok: 1 file\n',
  { new: 'a\nb\nc\n' },
);

test(
  'u: an unsafe path fails before any file is consulted',
  ['p'],
  null,
  { p: '--- a/../evil\n+++ b/../evil\n@@ -1 +1 @@\n-a\n+b\n' },
  1,
  'error: unsafe ../evil\nfailed: 1 of 1 edits\n',
);

// --- SEARCH/REPLACE (section 7) ----------------------------------------------

test(
  's: a block without a path inherits the previous block\'s path',
  ['-'],
  'x\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n```python\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  { x: 'a\nb\n' },
  0,
  'M x\nok: 1 file\n',
  { x: 'A\nB\n' },
);

test(
  's: an occurrence at the first tier is still ambiguous when a later tier is unique',
  ['-'],
  'x\n<<<<<<< SEARCH\nsame\n=======\nother\n>>>>>>> REPLACE\n',
  { x: 'same\nsame\n' },
  1,
  'error: ambiguous x\nfailed: 1 of 1 edits\n',
);

test(
  's: empty search creates the file',
  ['-'],
  'new\n<<<<<<< SEARCH\n=======\na\nb\n>>>>>>> REPLACE\n',
  {},
  0,
  'A new\nok: 1 file\n',
  { new: 'a\nb\n' },
);

// --- V4A (section 8) ---------------------------------------------------------

test(
  'v: an empty-O chunk uses no reindent tier even when its anchor matched at tier 2',
  ['-'],
  '*** Begin Patch\n*** Update File: x\n@@ target\n+added\n*** End Patch\n',
  { x: '  target\n  rest\n' },
  0,
  'M x\nok: 1 file\n',
  { x: '  target\nadded\n  rest\n' },
);

test(
  'v: an end-of-file chunk with empty O appends at the end',
  ['-'],
  '*** Begin Patch\n*** Update File: x\n+tail\n*** End of File\n*** End Patch\n',
  { x: 'one\ntwo\n' },
  0,
  'M x\nok: 1 file\n',
  { x: 'one\ntwo\ntail\n' },
);

test(
  'v: a move with no chunks is a valid edit',
  ['-'],
  '*** Begin Patch\n*** Update File: old\n*** Move to: new\n*** End Patch\n',
  { old: 'body\n' },
  0,
  'R old -> new\nok: 1 file\n',
  { old: null, new: 'body\n' },
);

test(
  'v: a body line cannot start a second chunk after *** End of File',
  ['-'],
  '*** Begin Patch\n*** Update File: x\n-a\n+b\n*** End of File\n-c\n+d\n*** End Patch\n',
  { x: 'a\nc\n' },
  2,
  'error: parse 6\n',
);

// --- JSON (section 9) --------------------------------------------------------

test(
  'j: a fault anywhere in an array is reported at the array\'s first line',
  ['-'],
  '\n[ {"command":"create","path":"x","file_text":"a"}, 17 ]\n',
  {},
  2,
  'error: parse 2\n',
);

test(
  'j: blank lines between JSON Lines edits are ignored',
  ['-'],
  '{"command":"create","path":"x","file_text":"a"}\n\n {"command":"create","path":"y","file_text":"b"} \n',
  {},
  0,
  'A x\nA y\nok: 2 files\n',
  { x: 'a', y: 'b' },
);

test(
  'j: insert_line 0 inserts at the top and keeps the final break',
  ['-'],
  '{"command":"insert","path":"x","insert_line":0,"new_str":"zero\\none"}\n',
  { x: 'a\nb\n' },
  0,
  'M x\nok: 1 file\n',
  { x: 'zero\none\na\nb\n' },
);

// --- invocation, output and atomicity (sections 1, 2, 10) --------------------

test(
  'c: a repeated option is a usage error',
  ['--check', '--check'],
  '',
  {},
  2,
  'error: usage\n',
);

test(
  'c: --strict disables tier matching',
  ['--strict', '-'],
  '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-target\n+replacement\n',
  { x: ' target \n' },
  1,
  'error: no-match x\nfailed: 1 of 1 edits\n',
);

test(
  'c: --check reports changes without writing them',
  ['--check', '-'],
  '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
  { x: 'a\n' },
  0,
  'M x\nok: 1 file\n',
  { x: 'a\n' },
);

test(
  'c: later edits still run after a failure, but nothing is written',
  ['-'],
  '{"command":"str_replace","path":"missing","old_str":"a","new_str":"b"}\n{"command":"create","path":"new","file_text":"x"}\n',
  { x: 'a\n' },
  1,
  'error: missing missing\nfailed: 1 of 2 edits\n',
  { x: 'a\n' },
);

test(
  'c: a failed move does not leave a move record behind',
  ['-'],
  '{"command":"create","path":"dest","file_text":"taken"}\n{"command":"str_replace","path":"dest","old_str":"taken","new_str":"new"}\n',
  { dest: 'taken' },
  1,
  'error: exists dest\nfailed: 1 of 2 edits\n',
  { dest: 'taken' },
);

let failed = 0;
for (const c of cases) {
  const want = { ...c.files };
  for (const [p, v] of Object.entries(c.changes)) {
    if (v === null) delete want[p];
    else want[p] = v;
  }
  const got = runCheck({ id: c.name, argv: c.argv, stdin: c.stdin, files: c.files });
  const why = [];
  if (got.exit !== c.exit) why.push(`exit ${got.exit}, wanted ${c.exit}`);
  if (got.stdout !== c.stdout) why.push(`stdout ${JSON.stringify(got.stdout)}, wanted ${JSON.stringify(c.stdout)}`);
  for (const p of new Set([...Object.keys(want), ...Object.keys(got.files)])) {
    if (want[p] === undefined) why.push(`${p} should not exist`);
    else if (got.files[p] === undefined) why.push(`${p} is missing`);
    else if (got.files[p] !== want[p]) why.push(`${p}: wanted ${JSON.stringify(want[p])}, got ${JSON.stringify(got.files[p])}`);
  }
  if (why.length > 0) {
    failed += 1;
    process.stdout.write(`FAIL ${c.name}\n  ${why.join('\n  ')}\n`);
  }
}
process.stdout.write(`${cases.length - failed} of ${cases.length} spec regressions passed\n`);
if (failed > 0) process.exitCode = 1;
