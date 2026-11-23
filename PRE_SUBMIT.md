# Pre-submit check

The site's pre-submit check is run from the unpacked kit with:

```sh
node cli/makefun.mjs check --kit . --repo <this repository> --transcripts transcripts.tar.gz
```

`transcripts.tar.gz` is a real bundle of the recorded OpenCode sessions that built this
entry, collected with the kit's `makefun bundle` command. It is committed here so the
bundle used for the check is the exact one uploaded with the entry; it is not written
or summarised by hand. The bundle's `manifest.json` lists its source sessions, their
hashes, the run record and the declared harness/model.

To rebuild it from the recorded sessions, run `makefun bundle` from inside the kit with
the same `--repo`, `--system-prompt`, `--effort`, `--harness`, `--harness-version`,
`--provider` and `--model` values recorded in the bundle manifest, then re-run `check`.

Locally, before running the site's check:

```sh
node tests/spec.test.mjs
node check.ts hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```
