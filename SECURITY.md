# Security policy

This policy covers the `@isokron/mcp-check` package (engine, CLI, MCP server) and the `isokron-ai/mcp-check` GitHub Action.

## Reporting a vulnerability

Report privately through GitHub: [Security > Report a vulnerability](https://github.com/isokron-ai/mcp-check/security/advisories/new), or email **hello@isokron.ai** with "Security" in the subject. Do not open a public issue. Include the version, tag or commit, the steps to reproduce, and the impact you see. We acknowledge reports within five business days and keep you updated until the issue is resolved.

A tool list that hides instructions from the checker (a poisoning pattern it misses) is a security report too, when the pattern is new. Please send the smallest definition that shows it.

## Supported versions

The latest `1.x` release. Fixes ship as a new release; the Action's `v1` tag moves to it.

## What the package and the Action do

- The engine reads only the JSON it is given. It makes no network request and writes nothing; a test enforces this.
- The MCP server's three tools are read-only, take the tool list as an argument, and enforce size, depth and count limits before parsing.
- `mcp-check capture` and the Action's `command` input start the server you name, on your machine or runner, with your environment, and send it `initialize` and `tools/list` only. That server's code runs with the permissions of the job: start only servers you would run in that job anyway. Never run the Action on `pull_request_target` or `workflow_run` with a `command` taken from the pull request.
- The server's stderr is fenced with `::stop-commands::` in the Action log, so a server cannot issue workflow commands.
- The Action needs no secret. `badge: true` needs `contents: write` and commits only `badge.json` and `report.md` in `badge-dir`, on the default branch. `upload-sarif: true` needs `security-events: write`.
- Releases are published from GitHub Actions with npm trusted publishing (OIDC) and provenance; no npm token exists. Every third-party action in this repository is pinned by commit SHA.
