# mcp-check benchmark score

80 cases with trusted labels, plus 5 faulty-oracle cases (labels deliberately wrong, scored apart). Intervals are Wilson 95%.

## Per check: measured against hand-written labels

Every positive of these checks comes from a case whose labels were written by hand from its source (some also have positives from inferred cases).

| Check | TP | FP | FN | TN | Precision | Recall |
|---|---:|---:|---:|---:|---|---|
| `abstain` | 4 | 0 | 1 | 75 | 100.0% [51.0–100.0] | 80.0% [37.5–96.4] |
| `annot-delete-marked-safe` | 3 | 0 | 0 | 203 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `annot-write-marked-readonly` | 3 | 1 | 0 | 202 | 75.0% [30.1–95.4] | 100.0% [43.9–100.0] |
| `gap-shell-injectable-url` | 0 | 0 | 1 | 1 | n/a | 0.0% [0.0–79.3] |
| `openai-name-unique` | 1 | 0 | 1 | 72 | 100.0% [20.6–100.0] | 50.0% [9.4–90.5] |
| `outcome` | 69 | 0 | 11 | 0 | 100.0% [94.7–100.0] | 86.3% [77.0–92.2] |
| `reader-annotations` | 112 | 0 | 2 | 0 | 100.0% [96.7–100.0] | 98.3% [93.8–99.5] |
| `reader-conditional` | 2 | 0 | 1 | 0 | 100.0% [34.2–100.0] | 66.7% [20.8–93.8] |
| `reader-description` | 113 | 0 | 1 | 0 | 100.0% [96.7–100.0] | 99.1% [95.2–99.8] |
| `reader-params` | 112 | 0 | 2 | 0 | 100.0% [96.7–100.0] | 98.3% [93.8–99.5] |
| `reader-required` | 112 | 0 | 2 | 0 | 100.0% [96.7–100.0] | 98.3% [93.8–99.5] |
| `reader-tools` | 181 | 3 | 22 | 0 | 98.4% [95.3–99.4] | 89.2% [84.1–92.7] |
| `sec-bidi-controls` | 6 | 0 | 1 | 199 | 100.0% [61.0–100.0] | 85.7% [48.7–97.4] |
| `sec-control-chars` | 3 | 1 | 2 | 200 | 75.0% [30.1–95.4] | 60.0% [23.1–88.2] |
| `sec-cross-tool-steering` | 3 | 0 | 0 | 203 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `sec-encoded-blob` | 6 | 0 | 0 | 200 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `sec-external-instructions` | 6 | 0 | 0 | 200 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `sec-homoglyph` | 7 | 0 | 1 | 198 | 100.0% [64.6–100.0] | 87.5% [52.9–97.8] |
| `sec-html-comment` | 6 | 0 | 0 | 200 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `sec-instruction-markup` | 3 | 0 | 0 | 203 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `sec-instruction-phrases` | 7 | 0 | 0 | 199 | 100.0% [64.6–100.0] | 100.0% [64.6–100.0] |
| `sec-invisible-encoding` | 3 | 0 | 2 | 201 | 100.0% [43.9–100.0] | 60.0% [23.1–88.2] |
| `sec-secret-seeking` | 7 | 0 | 0 | 199 | 100.0% [64.6–100.0] | 100.0% [64.6–100.0] |
| `sec-zero-width` | 6 | 0 | 0 | 200 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `security-cap` | 15 | 0 | 1 | 48 | 100.0% [79.6–100.0] | 93.8% [71.7–98.9] |
| `severity` | 217 | 0 | 0 | 0 | 100.0% [98.3–100.0] | 100.0% [98.3–100.0] |
| `spec-input-schema-missing` | 0 | 0 | 1 | 1 | n/a | 0.0% [0.0–79.3] |
| `spec-name-charset` | 3 | 0 | 1 | 202 | 100.0% [43.9–100.0] | 75.0% [30.1–95.4] |
| `spec-name-length` | 2 | 0 | 0 | 204 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `spec-name-unique` | 1 | 0 | 1 | 72 | 100.0% [20.6–100.0] | 50.0% [9.4–90.5] |

## Per check: inferred labels, self-consistency only

Every positive of these checks comes from a `truth_level: inferred` case, whose labels were drafted from the engine's own output and then checked by hand. They show that a later build still agrees with this one, not that the check is right.

| Check | TP | FP | FN | TN | Precision | Recall |
|---|---:|---:|---:|---:|---|---|
| `anthropic-conversation-data` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-description` | 7 | 0 | 0 | 3 | 100.0% [64.6–100.0] | 100.0% [64.6–100.0] |
| `anthropic-hint` | 6 | 0 | 0 | 2 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `anthropic-hint-platforms-differ` | 3 | 0 | 0 | 6 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `anthropic-title` | 14 | 0 | 0 | 0 | 100.0% [78.5–100.0] | 100.0% [78.5–100.0] |
| `anthropic-unsupported-use` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `design-use-when` | 34 | 0 | 0 | 2 | 100.0% [89.8–100.0] | 100.0% [89.8–100.0] |
| `openai-conversation-input` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-generic-executor` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-hints-explicit` | 14 | 0 | 0 | 8 | 100.0% [78.5–100.0] | 100.0% [78.5–100.0] |
| `openai-name-promotional` | 1 | 0 | 0 | 1 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-precise-location` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-readonly-destructive` | 3 | 0 | 0 | 6 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `openai-restricted-input` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | 9 | 0 | 0 | 14 | 100.0% [70.1–100.0] | 100.0% [70.1–100.0] |
| `reader-unreadable` | 3 | 0 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `schema-additional-properties` | 2 | 0 | 0 | 3 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-enum-missing` | 1 | 0 | 0 | 4 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-open-object` | 1 | 0 | 0 | 1 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | 13 | 0 | 0 | 7 | 100.0% [77.2–100.0] | 100.0% [77.2–100.0] |
| `schema-pagination` | 2 | 0 | 0 | 5 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-param-description` | 5 | 0 | 0 | 6 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| `schema-required-unknown` | 1 | 0 | 0 | 4 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-response-format` | 2 | 0 | 0 | 5 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-vague-param` | 3 | 0 | 0 | 7 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `spec-input-schema-field-name` | 1 | 0 | 0 | 4 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-input-schema-root-object` | 1 | 0 | 0 | 4 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-meta-key` | 1 | 0 | 0 | 1 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-meta-reserved` | 1 | 0 | 0 | 1 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-delete-guard` | 2 | 0 | 0 | 5 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `surface-retry-key` | 3 | 0 | 0 | 12 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `surface-version-guard` | 5 | 0 | 0 | 10 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |

## Per check: no positive case

Only false positives can be measured for these.

| Check | TP | FP | FN | TN | Precision | Recall |
|---|---:|---:|---:|---:|---|---|

## Per check and language

| Check | Language | TP | FP | FN | Precision | Recall |
|---|---|---:|---:|---:|---|---|
| `abstain` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `abstain` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `abstain` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `abstain` | rust | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `abstain` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-delete-marked-safe` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-delete-marked-safe` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-delete-marked-safe` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-write-marked-readonly` | committed-list | 0 | 1 | 0 | 0.0% [0.0–79.3] | n/a |
| `annot-write-marked-readonly` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-write-marked-readonly` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-write-marked-readonly` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-conversation-data` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-description` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-description` | javascript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-description` | python | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-description` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-hint` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-hint` | python | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `anthropic-hint` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-hint-platforms-differ` | committed-list | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `anthropic-title` | go | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `anthropic-title` | javascript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-title` | python | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `anthropic-title` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-title` | typescript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-unsupported-use` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `design-use-when` | committed-list | 17 | 0 | 0 | 100.0% [81.6–100.0] | 100.0% [81.6–100.0] |
| `design-use-when` | go | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `design-use-when` | javascript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `design-use-when` | python | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `design-use-when` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `design-use-when` | typescript | 5 | 0 | 0 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| `gap-shell-injectable-url` | typescript | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `openai-conversation-input` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-generic-executor` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-hints-explicit` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-hints-explicit` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-hints-explicit` | javascript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-hints-explicit` | python | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `openai-hints-explicit` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-hints-explicit` | typescript | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `openai-name-promotional` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-name-unique` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-name-unique` | typescript | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `openai-precise-location` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-readonly-destructive` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-readonly-destructive` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-restricted-input` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | committed-list | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `openai-retry` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-retry` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `outcome` | committed-list | 8 | 0 | 1 | 100.0% [67.6–100.0] | 88.9% [56.5–98.0] |
| `outcome` | csharp | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | go | 11 | 0 | 0 | 100.0% [74.1–100.0] | 100.0% [74.1–100.0] |
| `outcome` | java | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | javascript | 5 | 0 | 0 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| `outcome` | kotlin | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | php | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | python | 13 | 0 | 2 | 100.0% [77.2–100.0] | 86.7% [62.1–96.3] |
| `outcome` | ruby | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | rust | 8 | 0 | 1 | 100.0% [67.6–100.0] | 88.9% [56.5–98.0] |
| `outcome` | swift | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | typescript | 24 | 0 | 1 | 100.0% [86.2–100.0] | 96.0% [80.5–99.3] |
| `reader-annotations` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `reader-annotations` | go | 18 | 0 | 0 | 100.0% [82.4–100.0] | 100.0% [82.4–100.0] |
| `reader-annotations` | javascript | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| `reader-annotations` | python | 24 | 0 | 0 | 100.0% [86.2–100.0] | 100.0% [86.2–100.0] |
| `reader-annotations` | rust | 13 | 0 | 0 | 100.0% [77.2–100.0] | 100.0% [77.2–100.0] |
| `reader-annotations` | typescript | 45 | 0 | 2 | 100.0% [92.1–100.0] | 95.7% [85.8–98.8] |
| `reader-conditional` | go | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `reader-conditional` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `reader-conditional` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `reader-description` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `reader-description` | go | 18 | 0 | 0 | 100.0% [82.4–100.0] | 100.0% [82.4–100.0] |
| `reader-description` | javascript | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| `reader-description` | python | 23 | 0 | 1 | 100.0% [85.7–100.0] | 95.8% [79.8–99.3] |
| `reader-description` | rust | 13 | 0 | 0 | 100.0% [77.2–100.0] | 100.0% [77.2–100.0] |
| `reader-description` | typescript | 47 | 0 | 0 | 100.0% [92.4–100.0] | 100.0% [92.4–100.0] |
| `reader-params` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `reader-params` | go | 18 | 0 | 0 | 100.0% [82.4–100.0] | 100.0% [82.4–100.0] |
| `reader-params` | javascript | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| `reader-params` | python | 24 | 0 | 0 | 100.0% [86.2–100.0] | 100.0% [86.2–100.0] |
| `reader-params` | rust | 13 | 0 | 0 | 100.0% [77.2–100.0] | 100.0% [77.2–100.0] |
| `reader-params` | typescript | 45 | 0 | 2 | 100.0% [92.1–100.0] | 95.7% [85.8–98.8] |
| `reader-required` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `reader-required` | go | 18 | 0 | 0 | 100.0% [82.4–100.0] | 100.0% [82.4–100.0] |
| `reader-required` | javascript | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| `reader-required` | python | 24 | 0 | 0 | 100.0% [86.2–100.0] | 100.0% [86.2–100.0] |
| `reader-required` | rust | 13 | 0 | 0 | 100.0% [77.2–100.0] | 100.0% [77.2–100.0] |
| `reader-required` | typescript | 45 | 0 | 2 | 100.0% [92.1–100.0] | 95.7% [85.8–98.8] |
| `reader-tools` | committed-list | 34 | 0 | 2 | 100.0% [89.8–100.0] | 94.4% [81.9–98.5] |
| `reader-tools` | csharp | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | go | 27 | 0 | 0 | 100.0% [87.5–100.0] | 100.0% [87.5–100.0] |
| `reader-tools` | java | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | javascript | 18 | 0 | 0 | 100.0% [82.4–100.0] | 100.0% [82.4–100.0] |
| `reader-tools` | kotlin | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | php | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | python | 32 | 1 | 5 | 97.0% [84.7–99.5] | 86.5% [72.0–94.1] |
| `reader-tools` | ruby | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | rust | 22 | 2 | 0 | 91.7% [74.2–97.7] | 100.0% [85.1–100.0] |
| `reader-tools` | swift | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | typescript | 48 | 0 | 3 | 100.0% [92.6–100.0] | 94.1% [84.1–98.0] |
| `reader-unreadable` | typescript | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `schema-additional-properties` | committed-list | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-enum-missing` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-open-object` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `schema-output-schema` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-output-schema` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | typescript | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `schema-pagination` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-pagination` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-param-description` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-param-description` | python | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `schema-param-description` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-required-unknown` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-response-format` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-response-format` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-vague-param` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-vague-param` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-vague-param` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | python | 1 | 0 | 1 | 100.0% [20.6–100.0] | 50.0% [9.4–90.5] |
| `sec-bidi-controls` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-control-chars` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-control-chars` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-control-chars` | javascript | 0 | 1 | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] |
| `sec-control-chars` | python | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `sec-control-chars` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-cross-tool-steering` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-cross-tool-steering` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-cross-tool-steering` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-homoglyph` | committed-list | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-homoglyph` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-homoglyph` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-homoglyph` | python | 1 | 0 | 1 | 100.0% [20.6–100.0] | 50.0% [9.4–90.5] |
| `sec-homoglyph` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-markup` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-markup` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-markup` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-phrases` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-phrases` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-phrases` | python | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-instruction-phrases` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-instruction-phrases` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-invisible-encoding` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-invisible-encoding` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-invisible-encoding` | javascript | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `sec-invisible-encoding` | python | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `sec-invisible-encoding` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | python | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-secret-seeking` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `security-cap` | committed-list | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `security-cap` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `security-cap` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `security-cap` | python | 3 | 0 | 1 | 100.0% [43.9–100.0] | 75.0% [30.1–95.4] |
| `security-cap` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `security-cap` | typescript | 5 | 0 | 0 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| `severity` | committed-list | 70 | 0 | 0 | 100.0% [94.8–100.0] | 100.0% [94.8–100.0] |
| `severity` | go | 35 | 0 | 0 | 100.0% [90.1–100.0] | 100.0% [90.1–100.0] |
| `severity` | javascript | 23 | 0 | 0 | 100.0% [85.7–100.0] | 100.0% [85.7–100.0] |
| `severity` | python | 36 | 0 | 0 | 100.0% [90.4–100.0] | 100.0% [90.4–100.0] |
| `severity` | rust | 22 | 0 | 0 | 100.0% [85.1–100.0] | 100.0% [85.1–100.0] |
| `severity` | typescript | 31 | 0 | 0 | 100.0% [89.0–100.0] | 100.0% [89.0–100.0] |
| `spec-input-schema-field-name` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-input-schema-missing` | committed-list | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `spec-input-schema-root-object` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-meta-key` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-meta-reserved` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-charset` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-charset` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-charset` | python | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `spec-name-charset` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-length` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-length` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-unique` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-unique` | typescript | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `surface-delete-guard` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-delete-guard` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-retry-key` | committed-list | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `surface-retry-key` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-version-guard` | committed-list | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `surface-version-guard` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-version-guard` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |

Rows with no positive and no finding in a language are left out of this table; the JSON has every cell.

## Per language: what the reader decided

| Language | Cases | Outcome right | Abstained (observed) | Abstain expected | Unsupported or none (observed) | Unsupported expected |
|---|---:|---|---|---:|---|---:|
| committed-list | 9 | 88.9% [56.5–98.0] | 11.1% [2.0–43.5] | 1 | 11.1% [2.0–43.5] | 0 |
| csharp | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| go | 11 | 100.0% [74.1–100.0] | 9.1% [1.6–37.7] | 1 | 0.0% [0.0–25.9] | 0 |
| java | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| javascript | 5 | 100.0% [56.5–100.0] | 0.0% [0.0–43.5] | 0 | 0.0% [0.0–43.5] | 0 |
| kotlin | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| php | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| python | 15 | 86.7% [62.1–96.3] | 6.7% [1.2–29.8] | 1 | 13.3% [3.7–37.9] | 0 |
| ruby | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| rust | 9 | 88.9% [56.5–98.0] | 0.0% [0.0–29.9] | 1 | 0.0% [0.0–29.9] | 0 |
| swift | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| typescript | 25 | 96.0% [80.5–99.3] | 4.0% [0.7–19.5] | 1 | 8.0% [2.2–25.0] | 1 |

## Tool reading per idiom

| Idiom | TP | FP | FN | Precision | Recall |
|---|---:|---:|---:|---|---|
| adversarial | 82 | 1 | 1 | 98.8% [93.5–99.8] | 98.8% [93.5–99.8] |
| aliasing | 3 | 0 | 1 | 100.0% [43.9–100.0] | 75.0% [30.1–95.4] |
| conditional | 5 | 0 | 0 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| decorator | 17 | 0 | 6 | 100.0% [81.6–100.0] | 73.9% [53.5–87.5] |
| dynamic | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| explicit-registration | 2 | 0 | 4 | 100.0% [34.2–100.0] | 33.3% [9.7–70.0] |
| generated | 4 | 0 | 4 | 100.0% [51.0–100.0] | 50.0% [21.5–78.5] |
| imported | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| indirection | 18 | 0 | 0 | 100.0% [82.4–100.0] | 100.0% [82.4–100.0] |
| low-level | 9 | 0 | 2 | 100.0% [70.1–100.0] | 81.8% [52.3–94.9] |
| macro | 11 | 2 | 0 | 84.6% [57.8–95.7] | 100.0% [74.1–100.0] |
| misleading-names | 12 | 0 | 0 | 100.0% [75.8–100.0] | 100.0% [75.8–100.0] |
| monorepo | 0 | 2 | 0 | 0.0% [0.0–65.8] | n/a |
| partial-invalid | 10 | 0 | 2 | 100.0% [72.3–100.0] | 83.3% [55.2–95.3] |
| straight-line | 40 | 0 | 0 | 100.0% [91.2–100.0] | 100.0% [91.2–100.0] |
| wrapper | 8 | 0 | 4 | 100.0% [67.6–100.0] | 66.7% [39.1–86.2] |

## Faulty-oracle cases

Each of these has a label that is wrong on purpose. The scorer must disagree with it; a case marked NOT CAUGHT means the scorer echoed the label.

| Case | Caught | Why the label is wrong | Disagreement required | What the scorer said |
|---|---|---|---|---|
| faulty-oracle/extra-tool-label | yes | the list has only lookup_word; the label adds random_word | `reader-tools\|fn\|random_word` | missed tool random_word |
| faulty-oracle/missed-poison-label | yes | summarise says "Ignore all previous instructions"; the label claims no tool has the phrase | `sec-instruction-phrases\|fp\|summarise` | sec-instruction-phrases raised on summarise (truth: not this check); grades capped at F with no blocking security finding labelled (security F, anthropic F, openai F) |
| faulty-oracle/phantom-finding-label | yes | no description has an HTML comment; the label claims get_value has one | `sec-html-comment\|fn\|get_value` | sec-html-comment missed on get_value |
| faulty-oracle/wrong-outcome | yes | there is only one server; the label claims several | `outcome\|fn\|multiple->tools` | outcome: expected multiple, got tools; phantom tool single_status |
| faulty-oracle/wrong-tool-name | yes | the first tool is list_labels; the label drops the s | `reader-tools\|fn\|list_label` | missed tool list_label; phantom tool list_labels |

## Known gaps

- **real-world/cve-2025-6514-shape** (CVE-2025-6514 (mcp-remote OS command injection via a crafted authorization_endpoint), static shape only): mcp-check grades the tools/list only. The vulnerable value in CVE-2025-6514 is the OAuth authorization_endpoint the server advertises, which is not part of any tool, so no check can see it statically. The same shell syntax placed in a tool description is the part mcp-check could see; no current check flags a URL with shell command substitution ($(...), backticks, ;, |) in metadata (the planned "shell-injectable URL" check, loop upgrade 19). gap-shell-injectable-url is that missing check; its misses are the gap, not a pass. Scored misses: gap-shell-injectable-url missed on connect_account.

## Every disagreement

- **csharp/attribute-tools**: outcome: expected tools, got unsupported (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool echo_text; missed tool reverse_text
- **go/conditional-env**: suspend_tenant is registered under a condition but not marked conditional
- **java/spring-tool-methods**: outcome: expected tools, got none (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool city_temperature; missed tool city_humidity
- **javascript/poison-escapes**: sec-control-chars raised on title_case (truth: not this check); sec-control-chars missed on color_text; sec-invisible-encoding missed on title_case
- **kotlin/sdk-add-tool**: outcome: expected tools, got unsupported (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool roll_die; missed tool flip_coin
- **lists/checks-schemas**: annot-write-marked-readonly raised on resolve_names (truth: not this check)
- **lists/malformed-entry**: outcome: expected tools, got none (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool ping_host; missed tool traceroute_host; spec-input-schema-missing missed on ping_host
- **php/attribute-tools**: outcome: expected tools, got unsupported (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool add_integers; missed tool subtract_integers
- **python/class-methods**: outcome: expected tools, got none (mcp-check: no tool definitions found in <case> (scanned 1 of 1 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool distance_km; missed tool bearing_deg
- **python/docstring-unicode-escape**: sec-bidi-controls missed on list_folders; blocking security finding labelled, but the grades are not capped at F (security A, anthropic F, openai D); reader description of list_folders: expected "Lists the folders under a root.\u202eesrever\u202c", got "Lists the folders under a root.u202eesreveru202c"
- **python/generated-loop**: outcome: expected tools, got none (mcp-check: no tool definitions found in <case> (scanned 1 of 1 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool to_celsius; missed tool to_fahrenheit
- **python/poison-escapes**: missed tool lookup_аccount; phantom tool lookup_u0430ccount; sec-control-chars missed on color_text; sec-homoglyph missed on lookup_аccount; sec-invisible-encoding missed on title_case; spec-name-charset missed on lookup_аccount
- **real-world/cve-2025-6514-shape**: gap-shell-injectable-url missed on connect_account
- **ruby/tool-classes**: outcome: expected tools, got unsupported (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool ping_host; missed tool host_uptime
- **rust/two-handlers**: outcome: expected multiple, got tools; phantom tool alpha_status; phantom tool beta_status
- **swift/sdk-tools**: outcome: expected tools, got unsupported (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool utc_now; missed tool unix_time
- **typescript/alias-server-variable**: missed tool ping_service
- **typescript/duplicate-and-bad-names**: openai-name-unique missed on the list; spec-name-unique missed on the list
- **typescript/factory-function**: reader params of get_key: expected ["key"], got []; reader required of get_key: expected ["key"], got []; reader annotations of get_key: expected {"readOnlyHint":true}, got {}; reader params of touch_key: expected ["key"], got []; reader required of touch_key: expected ["key"], got []; reader annotations of touch_key: expected {"readOnlyHint":false}, got {}
- **typescript/generated-template-names**: outcome: expected tools, got none (mcp-check: no tool definitions found in <case> (scanned 1 of 1 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool list_invoices; missed tool list_customers
