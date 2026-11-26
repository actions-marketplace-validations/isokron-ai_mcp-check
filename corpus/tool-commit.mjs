// The commit of this repository that a loop lane ran. tool-qa files every result under the version pins of its lane
// (R-PIN-01), and a commit pin is proved only by the full 40-character commit in the bundle's manifest `tools`
// (tool-qa worker-kit/README.md, "Reporting what ran"). The workflows check out `inputs.tool_sha || github.sha`,
// fail the job unless `git rev-parse HEAD` equals it, and hand that HEAD on as MCP_CHECK_COMMIT.
//
// Outside the workflows (a local run, the tests) the variable is absent and the package version is reported: a
// version that says nothing about the commit, so tool-qa counts the pin unproven rather than wrong.

import { VERSION } from '../src/version.js';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The full commit this run's code is at, else the package version. */
export function ranCommit(env = process.env) {
  const c = env && typeof env.MCP_CHECK_COMMIT === 'string' ? env.MCP_CHECK_COMMIT : '';
  return FULL_SHA.test(c) ? c : VERSION;
}
