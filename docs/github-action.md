# The mcp-check GitHub Action

`uses: isokron-ai/mcp-check@v1` grades your MCP server's `tools/list` in CI: a grade table in the job summary, the reports as an artifact, optional SARIF upload to code scanning, a minimum-grade gate, a rug-pull check against a committed baseline, and an optional README badge served from your own repository.

It is a composite action that runs the same engine as the CLI and the web checker, with the runner's Node.js (20 or later; GitHub-hosted runners have it, otherwise add `actions/setup-node` first). It installs nothing.

## Where the tool list comes from

Set exactly one of:

- **`command`**: the command that starts your server over stdio, run in `working-directory`. The Action sends `initialize`, then `tools/list` (following `nextCursor` up to 100 pages), and stops the server. **No tool is called.** The command is split into words without a shell; set `shell: true` to run it through `bash -c` (pipes, `&&`, variables). The captured answer is saved as `tools-list.json` in the results folder.
- **`tools-file`**: a saved `tools/list` answer in the repository, for servers that need credentials or a backend to start, or for remote servers. Produce it with `npx @isokron/mcp-check capture -- <command>` or `npx @modelcontextprotocol/inspector --cli <command> --method tools/list`.

## Inputs

| Input | Default | |
|---|---|---|
| `tools-file` | | Path of a saved `tools/list` answer (JSON-RPC answer, `{"tools": [...]}`, array of tools, or array of pages). |
| `command` | | Command that starts the server over stdio. |
| `shell` | `false` | Run `command` through `bash -c`. |
| `working-directory` | `.` | Folder `command` runs in. |
| `timeout` | `60` | One overall time limit, in seconds, for starting the server and reading `initialize` and every `tools/list` page (1 to 600). |
| `min-grade` | | `A` to `F`. The job fails when a section in `sections` grades below it. Empty: report only. |
| `sections` | `spec,anthropic,openai,security` | Sections the gate applies to: `spec`, `anthropic`, `openai`, `security`, `quality`, `surface`. All six are always reported. |
| `baseline` | | Path of an earlier `tools/list` answer. The job fails on a high-risk annotation change: one that lets a client run a tool with less confirmation, such as `readOnlyHint` turning `true` or `destructiveHint` turning `false`. |
| `sarif` | `true` | Write `report.sarif`. Each result points at the tool's `"name"` line in the tool-list file. |
| `upload-sarif` | `false` | Upload `report.sarif` to code scanning (category `mcp-check`). Needs `security-events: write`. |
| `badge` | `false` | Write and commit the badge files (below). Needs `contents: write` and `actions/checkout` with its default `persist-credentials: true`. |
| `badge-dir` | `.github/mcp-check` | Folder of `badge.json` and `report.md`. |
| `results-dir` | `mcp-check-results` | Folder of the reports. |
| `artifact-name` | `mcp-check-results` | Name of the uploaded artifact; empty for none. Give each job of a matrix its own. |

Every path must be inside the workspace; a path that leads outside it, directly or through a symlink, is refused. Files are read and written only as regular files: a symlink, folder or device at any input or output path (`tools-file`, `baseline`, the files in `results-dir`, `badge.json` and `report.md` in `badge-dir`) is refused, and outputs are created without following links, so a branch cannot point a write elsewhere. `results-dir` must be new or empty, or a folder an earlier run of this action made (it holds a `.mcp-check-results` marker). A list over 2 MiB of JSON, 64 levels of nesting or 2,000 tools is refused with an error naming the limit.

## Outputs

`passed` (`true` or `false`), `grade-spec`, `grade-anthropic`, `grade-openai`, `grade-security`, `grade-quality`, `grade-surface` (empty when there is no write tool), `catalog-hash`, `sarif-file`, `results-dir`.

The job status is set by the last step, after the reports, the SARIF upload and the badge commit, so a failing gate still leaves you the full report.

## Examples

Gate a pull request and keep the findings in code scanning:

```yaml
permissions:
  contents: read
  security-events: write
steps:
  - uses: actions/checkout@v7
  - uses: actions/setup-node@v7
    with:
      node-version: 22
  - run: npm ci && npm run build
  - uses: isokron-ai/mcp-check@v1
    with:
      command: node dist/index.js
      min-grade: B
      upload-sarif: true
```

A server that needs a backend or credentials to start: commit its tool list and grade the file, and fail when an annotation is loosened compared with the released list:

```yaml
  - uses: isokron-ai/mcp-check@v1
    with:
      tools-file: tools.json
      baseline: release/tools.json
      min-grade: A
      sections: spec,anthropic,openai,security,quality
```

A Python server:

```yaml
  - uses: astral-sh/setup-uv@v7
  - uses: isokron-ai/mcp-check@v1
    with:
      command: uv run my-mcp-server
```

## The README badge

With `badge: true`, on `push`, `schedule` and `workflow_dispatch` runs of the default branch, the Action writes two files into `badge-dir` and commits them as `github-actions[bot]` with `[skip ci]`, only when the grades, the rubric version or the tool list changed:

- `badge.json`: a [shields.io endpoint](https://shields.io/badges/endpoint-badge) file. shields.io reads `label`, `message` and `color`; the other keys record what the badge stands for:

  ```json
  {
    "schemaVersion": 1,
    "label": "MCP check",
    "message": "Claude A · ChatGPT A · spec A",
    "color": "brightgreen",
    "cacheSeconds": 3600,
    "rubric_version": "2.1.0",
    "date": "2026-11-18",
    "grades": { "spec": "A", "anthropic": "A", "openai": "A", "security": "A", "quality": "B", "surface": null },
    "catalog_hash": "…",
    "commit": "…",
    "report": "https://github.com/OWNER/REPO/blob/main/.github/mcp-check/report.md",
    "run": "https://github.com/OWNER/REPO/actions/runs/…"
  }
  ```

  `date` is the day these grades were recorded; a run with the same grades and tool list leaves the file, and its date, unchanged. The badge colour follows the lower of the two directory grades.

- `report.md`: the full report (grades, every finding with its docs link, write-surface rows, definition hashes), headed by the commit and the workflow run, with a link that opens the same list in the web checker. The list travels in that link's fragment, which browsers do not send to any server.

Add the badge to your README (the job summary prints this with your names filled in):

```markdown
[![MCP check](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/main/.github/mcp-check/badge.json)](https://github.com/OWNER/REPO/blob/main/.github/mcp-check/report.md)
```

The badge and the report live in your repository, so nothing depends on storage at IsoKron, and anyone can see from the commit history when a grade changed.

If the default branch is protected against pushes from Actions, the commit step fails with a clear error. Either allow `github-actions[bot]` to push to it, or run the badge job on a schedule and let a pull-request bot of your choice carry the change.

## Security

- The server's stderr is shown in the log inside a `::stop-commands::` fence, so workflow commands it prints are not run.
- The Action needs no secret. Give the job only the permissions the features you turn on need: `contents: read` by default, `contents: write` for `badge`, `security-events: write` for `upload-sarif`.
- `command` runs your server's code on the runner with the job's environment and token. It is the same code your tests run, but do not run this Action on `pull_request_target` or `workflow_run` with a server built from an untrusted pull request.
- Inputs reach the script as environment variables, never by interpolation into a shell command. The third-party actions it uses (`actions/upload-artifact`, `github/codeql-action/upload-sarif`) are pinned by commit SHA.
- To pin this Action itself, use a full commit SHA instead of `@v1`.
- The Action sends nothing to IsoKron. The check-docs links it writes carry a fixed channel tag in their query (`utm_source=mcp-check-action` in the job summary, `mcp-check-badge` in the committed `report.md`, `mcp-check-sarif` in SARIF help links), which says where the link was shown and nothing about your repository, server or run. The reports in the artifact (`report.md`, `report.json`) carry no tag.
