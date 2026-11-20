# IsoKron MCP check: grading rubric

rubric_version: 2.1.1
Applies from: 2026-11-18. Sources read: 2026-11-18. MCP specification revision: 2026-07-28.

Every report, JSON export and private link carries `rubric_version`. When a link made under another version is opened, the page says so and grades with the current version. Any change to a weight, band, cap, severity or check bumps the version: patch for wording, minor for a new check, major for a change to weights, bands or caps.

## What is graded

| Section | What it covers | Graded |
|---|---|---|
| MCP spec 2026-07-28 | Rules of the specification that a pasted tool list can decide | Yes |
| Anthropic directory | Anthropic connector pre-submission checklist, plus the shared annotation and poisoning checks | Yes, plus a "ready" flag |
| OpenAI directory | OpenAI plugin guidelines (MCP tool rules), plus the shared annotation and poisoning checks | Yes, plus a "ready" flag |
| Poisoning and hidden text | Hidden characters and injection patterns in every string of every tool | Yes |
| Schema and description quality | Design advice: argument docs, enums, strict schemas, pagination, naming | Yes |
| Write-surface design | Guards the list offers for safe writes (retry key, version, delete guard) | Yes, by its own formula |
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

Tools that declare `readOnlyHint: true`, or whose name reads as a read, are left out. The others are read by the first or last word of the name as create, update, delete or other. Three guard shares are counted:

- create and send tools that take a retry key or declare `idempotentHint: true` (counted, but shown as "declared, not shown");
- update and delete tools that take a version or precondition argument, or an `If-Match`-style `x-mcp-header`;
- delete tools that take a confirm or dry-run argument.

Score = the mean of the shares that apply, times 100. Letter bands as above. No caps. If no tool can be read as a create, update or delete, the section is not graded. Full-replacement updates without a field mask and bulk deletes without a guard are reported as findings in this section but do not change the score.

## Thresholds that are IsoKron's own

The specification and directories give no numbers for these, so the values are ours and may change with the rubric version:

- schema depth over 10, or more than 500 subschemas: `spec-composition-bounds`
- description under 40 characters: `anthropic-description` (attention)
- two descriptions with word overlap (Jaccard) of 85% or more, both with at least 5 distinct words: `design-near-duplicate`
- 10 or more tools with no shared non-verb word in half the names: `design-namespace`
- an encoded run: base64 of 40 or more characters, or hex of 48 or more digits; blocking only if it decodes to readable text

## What the rubric does not claim

The grades cover static rules read from the tool list. They do not test behavior: whether hints match what tools do, whether retries are safe, whether stale writes are refused. Those are MWS tests against a running server. Name-based checks are heuristics and say so in their findings.

## Changes in rubric 2.1.1 (unreleased)

Two poisoning heuristics read less into text that is not a request (no weight, band or cap changes):

- `sec-secret-seeking` asks for the verb and the secret noun as separate words (an identifier such as the event name `post-update-password` no longer reads as "post … password"). A `.env` file named without the model being told to read or send it is now attention, not blocking; in a tool whose name says it writes files (`save_…`, `write_…`, `create_…`), only sending the file is blocking. SSH keys, cloud credential files and MCP client configuration stay blocking wherever they appear.
- The phrase checks (`sec-instruction-phrases`, `sec-cross-tool-steering`, `sec-external-instructions`, and asking for secrets) apply to text with spaces only. A single token, such as an enum value, an event name or an id, is not read as an instruction; an enum value written as a sentence still is.

## Changes in rubric 2.1.0 (18 November 2026)

- New check `spec-annotation-key-case` (attention, MCP spec section): an annotation key that spells a hint another way, such as `destructive_hint` (the Python SDK keeps snake_case `ToolAnnotations` arguments as extra fields). Clients ignore such keys and apply the default.

## Changes from rubric 1 (prototype, 17 November 2026)

- Rubric 1 graded each directory by the share of tools with no blocking item (A only at 100%), so one blocked tool in four gave a D. Rubric 2 uses severity-weighted deductions per tool, published caps and a separate ready flag.
- `destructiveHint: false` on a write that does not read as a delete is attention ("platforms differ"), not blocking.
- New sections: MCP spec 2026-07-28, poisoning and hidden text, schema and description quality.
- The write-surface grade uses the same letter bands as the other sections (rubric 1 used A from 90%, B from 70%, C from 50%, D from 25%).
