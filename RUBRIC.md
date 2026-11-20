# IsoKron MCP check: grading rubric

rubric_version: 2.2.0
Applies from: 2026-11-20. Sources read: 2026-11-18. MCP specification revision: 2026-07-28.

Every report, JSON export and private link carries `rubric_version`. When a link made under another version is opened, the page says so and grades with the current version. Any change to a weight, band, cap, severity or check bumps the version: patch for wording, minor for a new check, major for a change to weights, bands or caps.

## What is graded

| Section | What it covers | Graded |
|---|---|---|
| MCP spec 2026-07-28 | Rules of the specification that a pasted tool list can decide | Yes |
| Anthropic directory | Anthropic connector pre-submission checklist, plus the shared annotation and poisoning checks | Yes, plus a "ready" flag |
| OpenAI directory | OpenAI plugin guidelines (MCP tool rules), plus the shared annotation and poisoning checks | Yes, plus a "ready" flag |
| Poisoning and hidden text | Hidden characters and injection patterns in every string of every tool | Yes |
| Schema and description quality | Design advice: argument docs, enums, strict schemas, pagination, naming | Yes |
| Write-surface design | Guards the list offers for safe writes (retry key, precondition, delete guard) | Never: guard coverage and advice, no letter (since 2.2.0) |
| MWS 0.9 records | MWS-ANN-4 per tool | Never: no total, no grade (MWS 0.9 section 5.2) |

A check can count toward more than one section. For example, a hidden instruction counts toward Poisoning, Anthropic and OpenAI, because both directories reject it.

## Severities

- **blocking**: the specification says MUST, or a directory says the tool is rejected or must not do this.
- **attention**: a SHOULD is missed, or a reviewer is likely to question it, or a heuristic match that needs a person to confirm.
- **advice**: design guidance or an item that only matters in some setups (for example, 2026-07-28 envelope fields on a server that looks older). Most advice checks count toward the quality grade only.

A check has a default severity. Some checks set a different severity case by case; each such check documents when (for example, a missing description is blocking, a short one is attention).

## Score per section (spec, Anthropic, OpenAI, poisoning, quality)

1. Each tool starts at 100. For each finding on that tool that counts toward the section, deduct:
   - blocking: 40
   - attention: 10
   - advice: 3

   A tool's score does not go below 0.
2. Take the mean of the tool scores.
3. For each whole-list finding (duplicate names, envelope fields, near-duplicate descriptions, missing namespace, a partial paste) that counts toward the section, deduct:
   - blocking: 20
   - attention: 5
   - advice: 1
4. Clamp to 0..100 and round. This is the section score.

## Letter bands

| Letter | Score |
|---|---|
| A | 90 and above |
| B | 80 to 89 |
| C | 65 to 79 |
| D | 50 to 64 |
| F | below 50 |

## Caps (applied after the bands, in this order)

1. A section with any blocking finding is at most **B**.
2. If any MCP specification MUST fails (a blocking finding in the spec section), the spec, Anthropic and OpenAI grades are at most **C**. A tool that breaks a MUST may be dropped by clients, whatever the directories say.
3. If any blocking poisoning finding exists (invisible tag characters, bidi overrides, HTML comments, prompt markup, instruction phrases, hard cross-tool steering, encoded text, outside instructions, secret seeking, look-alike letters in a name), the Poisoning, Anthropic and OpenAI grades are **F**. Both directories reject these.

The report lists every cap applied to a section.

## Ready flag

A directory is "ready" when no finding that counts toward it is blocking. Ready means only that these static rules pass. Approval is each platform's decision; Anthropic also runs automated scans and may escalate a listing to a Verified review.

## Write-surface design

Reported as guard coverage, never as a letter. It feeds no other grade, badge, PR comment or headline, and the CLI and Action never gate on it.

Tools that declare `readOnlyHint: true`, or whose name reads as a read, are left out. So are:

- session tools: a name with `session`, `codegen` or `browser` in it; and, in a browser list, a tool whose own name has a browser prefix, a browser action or a browser noun (page, tab, window, dialog, extension, screenshot, trace and the like). A browser list has three or more distinct interaction actions (click, dblclick, hover, navigate, goto, fill, press, drag, type text) or two tools prefixed by a browser-automation name such as `browser_`. Screenshots, snapshots, scrolling and evaluating alone do not make one, and the list's other tools (a `delete_test_run` beside two `browser_` tools) are still counted;
- HTTP clients: a `url` argument and `http`, `request` or `client` in the name (`http_post`, `send_request`). `webhook_delete(url)` is a delete.

The rest are read by the name as create, update, delete or other: the leading verb, else the last word, else a write word in the middle. After a namespace prefix, a verb that is never a noun (get, create, update, delete, add, fetch, read, write, edit and the like) wins over a last word that is a write verb but usually a noun there (comment, label, tag, draft, order, grant, link and the like): `acme_get_issue_comment` reads and `idp_create_application_grant` creates. It does not apply after query, view, list, set, patch or show (`pg_query_cancel` and `db_view_drop` delete), when `and`, `or` or `then` follows (`cache_get_and_evict`), in a find-and-replace, or over a delete. `create_or_update_*` is an update. `hide`, `unhide` and `supersede` update; `disable` updates (it is not a delete); `tombstone` and `retire` delete; `append` creates, and `record` and `checkpoint` create when they lead the name. A whole name that is a read command of a data store (`hget`, `lrange`, `smembers`, `dbsize`) is a read; `type`, `keys`, `scan` and `exists` are not, as they name other tools as often.

Each write tool is one guard opportunity per guard that applies:

- a create or send tool: a retry key (`idempotency_key`, `client_token`, `client_request_id`, a whole-name `request_id`, a dedup key) or `idempotentHint: true` (counted, but shown as "declared, not shown");
- an update or delete tool: a precondition (`expected_*` or `expect_*`, `base_sha`/`base_revision`/`base_version`, `if_match`, `etag`, `last_modified`, `version`, `revision`, `sha`, `confirm_token`), or an `If-Match`-style `x-mcp-header`;
- a delete tool: a guard (`dry_run`, `validate_only`, `preview`, `confirm`, `confirm_*` or `confirmation_*` such as `confirmation_text`). `force` and `allow_*` are not guards.

Argument names are read in words (`expectedHeadSha` is `expected_head_sha`), at the root and one level down (`ops[].expect_version`, `options.dry_run`). One level down, a bare `version`, `revision` or `sha` is the nested item's own data and does not count. Substrings do not count: `merge_request_id` is not a retry key and `new_version` is not a precondition.

The report gives the counts, "Guards offered: retry keys a/b, preconditions c/d, delete guards e/f", pooled over all opportunities. With fewer than 3 opportunities it says there is not enough to judge. Every finding in the section is advice: a missing guard per tool, a full replacement without a mask, and a bulk delete without a guard. A full replacement is an update (or a `replace`/`overwrite`/`put` name) whose every field argument is required, with no mask; identifiers and scope (`*_id`, names, keys, `channel`, `ts`) are not fields. It is not raised when the tool takes a precondition, when another tool for the same object takes optional fields or a mask, or for a find-and-replace tool.

In JSON, `sections.surface` keeps `grade` and `score`, always `null`, and adds `graded: false`, `state` (`coverage`, `not-enough`, `no-opportunities` or `no-writes`), `coverage` (`opportunities`, `offered`, and `have`/`of` for `retry`, `version` and `guard`), `summary`, and `skipped` (the number of session and HTTP-client tools left out).

## Thresholds that are IsoKron's own

The specification and directories give no numbers for these, so the values are ours and may change with the rubric version:

- schema depth over 10, or more than 500 subschemas: `spec-composition-bounds`
- description under 40 characters: `anthropic-description` (attention)
- two descriptions with word overlap (Jaccard) of 85% or more, both with at least 5 distinct words: `design-near-duplicate`
- 10 or more tools with no shared non-verb word in half the names: `design-namespace`
- an encoded run: base64 of 40 or more characters, or hex of 48 or more digits; blocking only if it decodes to readable text

## What the rubric does not claim

The grades cover static rules read from the tool list. They do not test behavior: whether hints match what tools do, whether retries are safe, whether stale writes are refused. Those are MWS tests against a running server. Name-based checks are heuristics and say so in their findings.

## Changes in rubric 2.2.0 (unreleased)

No weight, band or cap changes for the five graded sections. The write-surface letter, which fed nothing else, is gone; four checks read less into names and arguments; one poisoning reading gets wider.

- **Write surface: guard coverage, no letter.** Almost every public server has no MWS-style guards yet, so the letter was an F for nearly all of them and told a maintainer nothing. The section now reports the pooled counts and the per-tool findings as advice, says "not enough to judge" below 3 opportunities, and is left out of the text report's grade lines, badges, PR comments and the job summary's grade table. Detection is fixed as described above (words and one nested level in argument names; `force` and `allow_*` no longer guards; no substring `version` or `request_id`; the new precondition and guard words; upserts; the new verbs; session and HTTP-client tools; data-store reads). `surface-retry-key`, `surface-version-guard` and `surface-bulk-delete` are advice (they were attention, in a section that had no effect on other grades).
- **`surface-full-replace`** reads the name only as a hint: every field must be required, `channel` and `ts` are identifiers, and it is not raised for a tool with a precondition, a tool whose object has a patching sibling, a find-and-replace tool, or an HTTP client.
- **Verbs, for every check that reads them.** After a namespace prefix, a verb that is never a noun wins over a last word that is a write verb but usually a noun there (`acme_get_issue_comment` reads, `idp_create_application_grant` creates), with the limits above, so no name 2.1.1 read as a write becomes a read except such gets; `hide`/`unhide`/`supersede` update instead of falling through to "comment" as a create; `disable_*` is an update, so `annot-delete-marked-safe` no longer fires on it; `tombstone`/`retire` delete; `append`, and `record`/`checkpoint` as the leading word, create; whole-name data-store reads (`hget`, `lrange`) are reads.
- **`anthropic-hint-platforms-differ`** is not raised for creates led by create, add, insert, append, record, new or comment: they purely add, which both platforms' wording allows as non-destructive. It stays for other creates (send, post, pay, charge, transfer, refund, publish, deploy, share, invite, import, schedule, copy, upload), updates and other writes.
- **`openai-retry`** is raised only for tools read as writes: named as a create, update or delete, or with a name that says nothing and no `destructiveHint: false` (a client takes a missing hint as destructive). Tools named as reads (`hget`) and unclear names declared non-destructive are not raised. A word on retries in an argument's description counts, and so does a retry-key argument.
- **`openai-restricted-input`**: an object or array argument that declares its fields is also read by those fields (`person.ssn`), and its own credential name counts unless every field is a setting (a name ending in type, policy, expiry and the like, a flag, a number or a fixed choice). A `refresh_token` settings object no longer reads as a token; `cookies: [{ name, value }]` and `password: { value }` still do.
- **`openai-precise-location`**: coordinate fields are blocking only when the tool or field description points at the user's own position ("your current location", "near me", "nearby", "where I am"); otherwise attention (a place to search, an emulated device position, or a sentence that says not to ask).
- **Poisoning**: in prose, a run of three or more words joined by `-` or `_` ("always-call-this-tool-first") is also read as words for instructions, hard steering and outside instructions. Hyphenated identifiers in prose are not read as asking for secrets or as soft steering, as for short identifiers in 2.1.1.

## Changes in rubric 2.1.1 (20 November 2026)

Two poisoning heuristics read less into text that is not a request, and no more past text that is (no weight, band or cap changes):

- `sec-secret-seeking` needs a space after the verb, so a short identifier such as the event name `post-update-password` no longer reads as "post … password"; a secret noun inside a hyphenated name ("upload the db-credentials") still counts. A `.env` file named without the model being asked to read, copy or send it is attention, not blocking. Only a tool whose name says it saves or writes a file (`save_…_file`, `write_env`, `write_config`) may read the file it updates; reading `.env` and copying it into something, or sending it, is blocking for every tool. `.env` after `/` (`./.env`) and gcloud's `application_default_credentials.json` are recognised. SSH keys, cloud credential files and MCP client configuration stay blocking wherever they appear.
- Short identifiers (one token of at most four segments joined by `.`, `_` or `-`, such as an enum value, an event name or an id) are not read as asking for secrets or as soft steering, but are still read for instructions to the model, hard steering and outside instructions, so an enum value `ignore-previous-instructions` stays blocking. Blank and invisible characters (U+2800, U+3164, U+FFA0, U+115F, U+1160, zero-width) are read as spaces, and a longer run of words joined by `-`, `_` or `/` is read as words, so "Ignore-all-previous-instructions" and enum values written as sentences are still caught.

## Changes in rubric 2.1.0 (18 November 2026)

- New check `spec-annotation-key-case` (attention, MCP spec section): an annotation key that spells a hint another way, such as `destructive_hint` (the Python SDK keeps snake_case `ToolAnnotations` arguments as extra fields). Clients ignore such keys and apply the default.

## Changes from rubric 1 (prototype, 17 November 2026)

- Rubric 1 graded each directory by the share of tools with no blocking item (A only at 100%), so one blocked tool in four gave a D. Rubric 2 uses severity-weighted deductions per tool, published caps and a separate ready flag.
- `destructiveHint: false` on a write that does not read as a delete is attention ("platforms differ"), not blocking.
- New sections: MCP spec 2026-07-28, poisoning and hidden text, schema and description quality.
- The write-surface grade uses the same letter bands as the other sections (rubric 1 used A from 90%, B from 70%, C from 50%, D from 25%).
