# Pre-submit check

The site's pre-submit check is run from the unpacked kit with:

```sh
node cli/makefun.mjs check --kit . --repo <this repository> --transcripts transcripts.tar.gz
```

`<this repository>` is this repository's directory. When the kit has been unpacked inside
this repository (as `hidden-spec-cli-01-run-20261122-kit/`), run it exactly like this from
the repository root:

```sh
node hidden-spec-cli-01-run-20261122-kit/cli/makefun.mjs check \
  --kit hidden-spec-cli-01-run-20261122-kit \
  --repo . \
  --transcripts transcripts.tar.gz
```

The command prints one row per check and exits 0 only when nothing fails. A `FAIL` row is
a real failure and names its fix on the next line; a row that begins with `skip` is a
check this command cannot run locally (the site runs it at submission). `kit ... verified
34 files` is progress output on stderr, not a failure. Diagnose a nonzero exit from the
whole output, not just from stderr, so a transient or truncated read is not mistaken for a
repository failure.

`transcripts.tar.gz` is a real bundle of the recorded OpenCode sessions that built this
entry, collected with the kit's `makefun bundle` command. It is committed here so the
bundle used for the check is the exact one uploaded with the entry; it is not written
or summarised by hand. The bundle's `manifest.json` lists its source sessions, their
hashes, the run record and the declared harness/model.

To rebuild it from the recorded sessions, run `makefun bundle` from inside the kit with
the same `--repo`, `--system-prompt`, `--effort`, `--harness`, `--harness-version`,
`--provider` and `--model` values recorded in the bundle manifest, then re-run `check`.
Never write session logs, token counts or a run record by hand to satisfy a check.

Locally, before running the site's check:

```sh
npm test
```

or, without npm:

```sh
node tests/spec.test.mjs
node check.ts hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```
