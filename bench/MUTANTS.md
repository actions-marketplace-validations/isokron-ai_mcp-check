# Mutant pass

## Source mutants

170 mutants ran; 51 killed, 119 survived: **gate-level kill rate 30.0% [23.6–37.3]**. A mutant is killed when the required CI gate (bench/gate.mjs) fails it, or the build crashes or hangs. 1 did not parse and are not counted.

Every mutant on the kill list (`mutants/expected.json`) runs as well, picked by the quota or not: 1 more ran this time (1 killed, 0 survived). The rates above are of the quota set.

Of these, 50 caused a new disagreement with the truth in some case, or crashed or hung; 50 of those are gate kills (the gate fails on any new per-case disagreement, so this should be all of them).

Mutants are drawn from code the cases execute: 8337 of 15419 candidate sites (54.1%) ran in an unmutated pass. Sites the cases never reach can hide any bug; per file:

| File | Candidate sites | Executed by the cases |
|---|---:|---:|
| `src/inputs/repo-source.cjs` | 5422 | 3268 (60.3%) |
| `src/inputs/repo-go.cjs` | 3775 | 1624 (43.0%) |
| `src/inputs/repo-rust.cjs` | 3120 | 1191 (38.2%) |
| `src/inputs/collect.js` | 248 | 87 (35.1%) |
| `src/unreadable.js` | 210 | 146 (69.5%) |
| `src/tools.js` | 72 | 3 (4.2%) |
| `engine/core.js` | 2572 | 2018 (78.5%) |

| Kind | Ran | Killed | Survived |
|---|---:|---:|---:|
| flip-condition | 60 | 25 | 35 |
| drop-registration-pattern | 20 | 1 | 19 |
| weaken-regex | 35 | 4 | 31 |
| off-by-one | 25 | 9 | 16 |
| swap-severity | 12 | 8 | 4 |
| flip-boolean | 12 | 2 | 10 |
| swap-some-every | 6 | 2 | 4 |

| File | Ran | Killed | Survived |
|---|---:|---:|---:|
| `src/inputs/repo-source.cjs` | 32 | 6 | 26 |
| `src/inputs/repo-go.cjs` | 30 | 3 | 27 |
| `src/inputs/repo-rust.cjs` | 30 | 11 | 19 |
| `src/inputs/collect.js` | 16 | 5 | 11 |
| `src/unreadable.js` | 24 | 7 | 17 |
| `src/tools.js` | 3 | 0 | 3 |
| `engine/core.js` | 35 | 19 | 16 |

### Surviving source mutants (test gaps)

"Output changed" names cases whose output moved without crossing a label: a label there would kill the mutant.

| Mutant | Line | Change | Output changed |
|---|---:|---|---|
| collect.js:eq-flip:8ef94ac18b | 145 | `!== -> ===` | no |
| repo-go.cjs:logic-swap:5709c51d0f-2 | 1287 | `\|\| -> &&` | no |
| repo-rust.cjs:logic-swap:3bcc3f702d-2 | 364 | `\|\| -> &&` | no |
| repo-source.cjs:logic-swap:3e6ead047b | 543 | `&& -> \|\|` | no |
| tools.js:rel-boundary:08f90425d0 | 14 | `> -> >=` | no |
| unreadable.js:logic-swap:3eb5220df6 | 34 | `&& -> \|\|` | typescript/computed-parts |
| core.js:eq-flip:ae46bed70d | 1258 | `=== -> !==` | no |
| collect.js:logic-swap:28799ad18c | 259 | `\|\| -> &&` | no |
| repo-go.cjs:eq-flip:7b220bba79-3 | 129 | `=== -> !==` | go/helper-builder |
| unreadable.js:logic-swap:678b71d838 | 18 | `&& -> \|\|` | typescript/computed-parts |
| collect.js:logic-swap:ef6888323f | 34 | `&& -> \|\|` | no |
| repo-go.cjs:logic-swap:24cdf6f8fa | 629 | `&& -> \|\|` | no |
| repo-source.cjs:eq-flip:11a8ea86c7 | 548 | `=== -> !==` | no |
| unreadable.js:logic-swap:ba5b87cec6-5 | 69 | `&& -> \|\|` | no |
| repo-go.cjs:logic-swap:2312e40551-2 | 1814 | `&& -> \|\|` | no |
| repo-rust.cjs:eq-flip:0c5ce20b22 | 524 | `=== -> !==` | no |
| repo-source.cjs:logic-swap:6ed6020fe2-3 | 2287 | `&& -> \|\|` | no |
| unreadable.js:eq-flip:7e7e505a9c | 118 | `=== -> !==` | no |
| repo-source.cjs:logic-swap:73c0a1d9db | 1598 | `&& -> \|\|` | no |
| unreadable.js:eq-flip:1882d183da | 152 | `=== -> !==` | no |
| core.js:logic-swap:cf009dc8ae-2 | 639 | `\|\| -> &&` | no |
| collect.js:eq-flip:3681f5ccbc | 54 | `=== -> !==` | no |
| repo-go.cjs:not-drop:3976e90d40 | 630 | `! -> (removed)` | no |
| repo-rust.cjs:logic-swap:7d1e6a2b69-2 | 67 | `\|\| -> &&` | no |
| collect.js:eq-flip:af422e2112 | 143 | `!== -> ===` | no |
| repo-go.cjs:not-drop:5ff85a28c9 | 1678 | `! -> (removed)` | no |
| repo-rust.cjs:rel-boundary:021399e2c8 | 229 | `< -> <=` | no |
| repo-source.cjs:logic-swap:ab44006fa9-2 | 951 | `&& -> \|\|` | no |
| unreadable.js:not-drop:1c227a2183 | 94 | `! -> (removed)` | no |
| repo-go.cjs:rel-boundary:24a48340bd | 198 | `< -> <=` | no |
| repo-rust.cjs:eq-flip:895bd737fd | 107 | `=== -> !==` | no |
| repo-source.cjs:logic-swap:003a3e6d99-2 | 2365 | `\|\| -> &&` | no |
| repo-go.cjs:eq-flip:856318312f | 1827 | `=== -> !==` | no |
| repo-source.cjs:eq-flip:326758d5b5 | 257 | `=== -> !==` | no |
| unreadable.js:logic-swap:ba5b87cec6 | 69 | `&& -> \|\|` | no |
| repo-go.cjs:regex-drop-alt-registration:a7a49ccced | 2194 | `in /\bNewTool(?:WithRawSchema)?\s*\(\|\bTool\…/ drop "\|\bAddTools?\s*\("` | no |
| repo-rust.cjs:regex-drop-alt-registration:bf1e0f8af1 | 1586 | `in /#\[\s*(?:rmcp::)?tool\b\|#\[\s*(?:[\w:]*:…/ drop "\|\btool_router\b"` | no |
| repo-source.cjs:regex-drop-alt-registration:dedd09a595 | 2368 | `in /(?:registerTool\|\.tool\|addTool)\b[\s\S]{…/ drop "\|\.tool"` | no |
| repo-go.cjs:regex-drop-alt-registration:3d9b1d3848 | 2194 | `in /\bNewTool(?:WithRawSchema)?\s*\(\|\bTool\…/ drop "\|\bToolOption\b"` | no |
| repo-rust.cjs:regex-drop-alt-registration:8f544b6991 | 1586 | `in /#\[\s*(?:rmcp::)?tool\b\|#\[\s*(?:[\w:]*:…/ drop "#\[\s*(?:rmcp::)?tool\b\|"` | no |
| repo-go.cjs:regex-drop-alt-registration:a86e300563 | 2194 | `in /\bNewTool(?:WithRawSchema)?\s*\(\|\bTool\…/ drop "\bNewTool(?:WithRawSchema)?\s*\(\|"` | no |
| repo-rust.cjs:regex-drop-alt-registration:2dbf6f2b54 | 1586 | `in /#\[\s*(?:rmcp::)?tool\b\|#\[\s*(?:[\w:]*:…/ drop "\|\bTool\s*\{\s*name\s*:"` | no |
| repo-source.cjs:regex-drop-alt-registration:1efee9c42b | 2358 | `in /registerTool\|\.tool\s*\(\|@[\w.]*tool\b\|@…/ drop "\|import_server"` | no |
| repo-go.cjs:regex-drop-alt-registration:5fa541f061 | 2194 | `in /\bNewTool(?:WithRawSchema)?\s*\(\|\bTool\…/ drop "\|\bWithDescription\s*\("` | no |
| repo-rust.cjs:regex-drop-alt-registration:b1e511f560 | 1586 | `in /#\[\s*(?:rmcp::)?tool\b\|#\[\s*(?:[\w:]*:…/ drop "\|\btool_box\b"` | no |
| repo-source.cjs:regex-drop-alt-registration:27b23e688d | 770 | `in /(?:^\|[^\w$.])(?:this\s*\.\s*)?(?!this\b)…/ drop "\|['"']tools\/list['"']"` | no |
| repo-go.cjs:regex-drop-alt-registration:cb6a49639a | 2194 | `in /\bNewTool(?:WithRawSchema)?\s*\(\|\bTool\…/ drop "\|\bTool\s*\{"` | no |
| repo-rust.cjs:regex-drop-alt-registration:8b0eb9f79d | 1586 | `in /#\[\s*(?:rmcp::)?tool\b\|#\[\s*(?:[\w:]*:…/ drop "\|#\[\s*(?:[\w:]*::)?mcp_tool\s*\("` | no |
| repo-source.cjs:regex-drop-alt-registration:fcfbc35b5d | 770 | `in /(?:^\|[^\w$.])(?:this\s*\.\s*)?(?!this\b)…/ drop "\|[^\w$.]"` | no |
| repo-go.cjs:regex-drop-alt-registration:f167f18e7c | 2194 | `in /\bNewTool(?:WithRawSchema)?\s*\(\|\bTool\…/ drop "\|\bRegisterTool\s*\("` | no |
| repo-rust.cjs:regex-drop-alt-registration:d98b233ad9 | 1586 | `in /#\[\s*(?:rmcp::)?tool\b\|#\[\s*(?:[\w:]*:…/ drop "\|\bTool::new\b"` | no |
| repo-source.cjs:regex-drop-alt-registration:3efe19ba0e | 2389 | `in /(?:^\|[^\w$])(?:registerTool\|tool)\s*\(\s…/ drop "\|tool"` | no |
| repo-source.cjs:regex-drop-alt-registration:144bcb36c5 | 2100 | `in /(^\|\/)(tools(-list\|_list)?\|mcp-tools\|too…/ drop "\|\/"` | no |
| repo-source.cjs:regex-drop-alt-registration:b808c86e9f | 2389 | `in /(?:^\|[^\w$])(?:registerTool\|tool)\s*\(\s…/ drop "^\|"` | no |
| core.js:regex-drop-alt:373f997dab | 706 | `in /<\s*\/?\s*(important\|system\|instructions…/ drop "\|user"` | no |
| repo-go.cjs:regex-drop-alt:115c01c610 | 1216 | `in /(^\|,)(required\|nullable\|-\|description=\|t…/ drop "\|anyof_required="` | no |
| repo-rust.cjs:regex-drop-alt:045415243b | 1259 | `in /^(RequestContext\|Peer\|Extension\|Meta\|Can…/ drop "\|Arc"` | no |
| repo-source.cjs:regex-drop-alt:58b78eeeac | 2098 | `in /(^\|\/)__toolsnaps__\/[^/]+\.snap$/ drop "\|\/"` | no |
| unreadable.js:regex-drop-alt:44d4bc0c01 | 18 | `in /^(spec-input-schema-\|spec-schema-\|spec-r…/ drop "\|spec-composition-bounds"` | no |
| core.js:regex-drop-alt:46c79257af | 901 | `in /^(lat\|latitude\|lng\|lon\|long\|longitude\|co…/ drop "\|lat_lng"` | no |
| repo-go.cjs:regex-drop-alt:8413cc5d5b | 39 | `in /(?:0[xX][0-9a-fA-F_]*(?:\.[0-9a-fA-F_]*)…/ drop "[0-9][0-9_]*(?:\.[0-9_]*)?\|"` | no |
| repo-source.cjs:regex-drop-alt:42ee62b7c0 | 2881 | `in /(^\|\/)(node_modules\|bin\|obj\|\.git\|\.vs\|p…/ drop "\|packages"` | no |
| unreadable.js:regex-drop-alt:1f4d68be30 | 18 | `in /^(spec-input-schema-\|spec-schema-\|spec-r…/ drop "\|openai-restricted-input"` | no |
| core.js:regex-drop-boundary:de5e551f9c | 713 | `in /\b(this\|these) (instructions?\|rules?) (t…/ drop \b at 81` | no |
| repo-go.cjs:regex-drop-alt:13b8bae9ca | 1216 | `in /(^\|,)(required\|nullable\|-\|description=\|t…/ drop "required\|"` | no |
| repo-rust.cjs:regex-drop-alt:45eeb1cf6e | 1259 | `in /^(RequestContext\|Peer\|Extension\|Meta\|Can…/ drop "\|Session"` | no |
| repo-source.cjs:regex-drop-alt:b196afe403 | 903 | `in /^(function\|async\|get\|set\|static\|public\|p…/ drop "\|set"` | no |
| core.js:regex-drop-alt:c7361d667c | 958 | `in /(expir\|lifetime\|ttl\|time[- ]to[- ]live\|i…/ drop "\|days?"` | no |
| repo-go.cjs:regex-drop-alt:4ec0e1893e | 255 | `in /^(if\|else\|for\|switch\|select\|func\|go\|defe…/ drop "\|range"` | no |
| repo-rust.cjs:regex-drop-boundary:7b77a7e4a9 | 1587 | `in /\bimpl\s+(?:[\w:]*::)?ServerHandler\s+fo…/ drop \b at 110` | no |
| repo-source.cjs:regex-drop-alt:8d993a5a46 | 2633 | `in /^(package\.json\|package-lock\.json\|pypro…/ drop "\|pyproject\.toml"` | no |
| unreadable.js:regex-drop-alt:24fdb86ce6 | 20 | `in /^(anthropic-title\|anthropic-hint\|anthrop…/ drop "\|anthropic-hint-platforms-differ"` | no |
| core.js:regex-drop-alt:d2716cbdb5 | 902 | `in /(^\|_)(address\|street\|street_address\|zip\|…/ drop "address\|"` | javascript/poison-steering-soft |
| repo-go.cjs:regex-drop-alt:a652dae36f | 560 | `in /!\|\(\|\)\|&&\|\\|\\|\|[\w.]+/ drop "\|[\w.]+"` | no |
| repo-rust.cjs:regex-drop-alt:3b910db55b | 407 | `in /(^\|\/)(mod\|lib\|main)$/ drop "\|\/"` | no |
| repo-source.cjs:regex-drop-alt:67e5b332a6 | 2881 | `in /(^\|\/)(node_modules\|bin\|obj\|\.git\|\.vs\|p…/ drop "\|\.vs"` | no |
| unreadable.js:regex-drop-alt:ec85854c7b | 18 | `in /^(spec-input-schema-\|spec-schema-\|spec-r…/ drop "\|anthropic-conversation-data"` | no |
| core.js:regex-drop-alt:957ba13686 | 951 | `in /\b(generate\|generates\|create\|creates\|syn…/ drop "\|create"` | no |
| repo-go.cjs:regex-drop-alt:f9d222ab01 | 1216 | `in /(^\|,)(required\|nullable\|-\|description=\|t…/ drop "\|readOnly"` | no |
| repo-rust.cjs:regex-drop-alt:212eddc632 | 1259 | `in /^(RequestContext\|Peer\|Extension\|Meta\|Can…/ drop "\|Meta"` | no |
| repo-source.cjs:regex-drop-alt:e09d7733c4 | 781 | `in /\.(ts\|mts\|cts\|js\|mjs\|cjs)$/ drop "\|mjs"` | no |
| unreadable.js:regex-drop-alt:6ccb3a38cd | 18 | `in /^(spec-input-schema-\|spec-schema-\|spec-r…/ drop "\|spec-ref-remote"` | no |
| repo-go.cjs:regex-drop-alt:b45d4923f5 | 255 | `in /^(if\|else\|for\|switch\|select\|func\|go\|defe…/ drop "\|select"` | no |
| repo-source.cjs:regex-drop-alt:885147d3ca | 2875 | `in /(^\|\/)(tests\|benches\|examples)\// drop "tests\|"` | no |
| unreadable.js:regex-drop-alt:f1c9797e64 | 19 | `in /^(anthropic-description\|openai-descripti…/ drop "\|openai-description"` | no |
| collect.js:num-plus-one:1713a1d325 | 259 | `160 -> 161` | no |
| repo-source.cjs:num-plus-one:c363db21f0 | 2287 | `1 -> 2` | no |
| tools.js:num-plus-one:2461c51c8a | 8 | `100 -> 101` | no |
| core.js:num-plus-one:11ccdcaf38-6 | 1217 | `0 -> 1` | no |
| collect.js:num-plus-one:5b4df4a576 | 54 | `1 -> 2` | no |
| repo-go.cjs:num-plus-one:6b07b74da5 | 1224 | `6 -> 7` | no |
| repo-rust.cjs:num-plus-one:ce6a94d562 | 307 | `0 -> 1` | no |
| tools.js:num-plus-one:c39a08dde4 | 7 | `500 -> 501` | no |
| core.js:num-plus-one:cbaf803643-2 | 560 | `0 -> 1` | no |
| collect.js:num-plus-one:8589bce3b1 | 240 | `3 -> 4` | no |
| repo-go.cjs:num-plus-one:649421cc25-2 | 433 | `0 -> 1` | no |
| repo-source.cjs:num-plus-one:5bdc45eb1d | 1298 | `3 -> 4` | no |
| core.js:num-plus-one:11fe5480d6-2 | 503 | `1 -> 2` | no |
| collect.js:num-plus-one:d130347ba1-2 | 259 | `128 -> 129` | no |
| repo-go.cjs:num-plus-one:46c49331de | 2005 | `1 -> 2` | no |
| repo-rust.cjs:num-plus-one:6074225dd8 | 141 | `0 -> 1` | no |
| unreadable.js:severity-swap:f8a5b5b2e7 | 59 | `'blocking' -> 'attention'` | no |
| core.js:severity-swap:71250bb7a4 | 82 | `'attention' -> 'blocking'` | no |
| core.js:severity-swap:055d7c727b | 286 | `'blocking' -> 'attention'` | no |
| core.js:severity-swap:586c2f06ac | 128 | `'blocking' -> 'attention'` | no |
| core.js:bool-flip:c0216f7c9b | 543 | `true -> false` | no |
| collect.js:bool-flip:59a6576a36 | 259 | `true -> false` | no |
| repo-go.cjs:bool-flip:9c1b097d47 | 1296 | `false -> true` | no |
| repo-source.cjs:bool-flip:39a69085ee | 187 | `true -> false` | no |
| unreadable.js:bool-flip:626bceaf94 | 121 | `false -> true` | no |
| core.js:bool-flip:159e70a4b0 | 540 | `false -> true` | no |
| repo-go.cjs:bool-flip:93556cdb43 | 1999 | `true -> false` | go/helper-builder |
| repo-rust.cjs:bool-flip:ea88a24273 | 324 | `true -> false` | no |
| repo-source.cjs:bool-flip:c104ed1a09 | 379 | `false -> true` | no |
| unreadable.js:bool-flip:f19500a8e0 | 172 | `true -> false` | javascript/built-output-only, typescript/computed-parts, typescript/loop-over-definitions |
| collect.js:some-every:d9e11d482e | 41 | `some -> every` | no |
| repo-go.cjs:some-every:060916d23d | 1683 | `some -> every` | no |
| repo-source.cjs:some-every:d9ebf290e5 | 2804 | `some -> every` | no |
| unreadable.js:some-every:3b30495eef | 118 | `some -> every` | javascript/built-output-only, typescript/computed-parts |

## Fixture mutants

42 ran; 41 killed (the reader noticed the edit), 1 survived.

| Mutant | Case | Status | Why |
|---|---|---|---|
| fx-go-build-tag-default | go/build-tag-excluded | survived | output changed but disagrees with the edited truth: dump_memory marked conditional, but it is always registered |
