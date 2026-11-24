# tool-qa contract, vendored for tests

These files are copied byte for byte from
[isokron-ai/tool-qa](https://github.com/isokron-ai/tool-qa) (MIT License,
Copyright (c) 2026 IsoKron) at the commit in `VENDORED.json`:

| File | What the tests use it for |
|---|---|
| `worker-kit/contract.mjs`, `worker-kit/manifest.schema.json` | `buildManifest` and `validateManifest`: the manifest the worker kit builds from our meta file, skip codes included |
| `worker-kit/tar.mjs` | `writeTar` and `readTar`: the bundle round trip |
| `ingest/forgery.mjs`, `ingest/redact.mjs` | `checkBundle` and `scanFiles`: ingest's file, identity-claim, control and secret checks |

They are test-only (not in the npm package) and must match the commit that
`WORKER_KIT_REF` pins in `.github/workflows/scan-static.yml`.
`test/tool-qa.test.mjs` fails if a file was edited or the two commits differ.
To move the pin, copy the same files from the new commit, update
`VENDORED.json` (commit and sha256 of each file) and `WORKER_KIT_REF`, and
every `uses: isokron-ai/tool-qa/worker-kit@` line, together.
