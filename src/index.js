// Library entry point (ESM). CommonJS users can require('@isokron/mcp-check'), which loads engine/core.js directly.
import M from './engine.js';

export default M;
export const {
  RUBRIC_VERSION, REPORT_SCHEMA, SPEC_VERSION, SOURCES_READ, DOCS_BASE, CHECKS, CHECK,
  parseInput, analyse, check, allFindings, fixCatalog, snippetFor, diffCatalogs,
  toMarkdown, toJSON, toSarif, badgeJson, encodeFragment, sha256, canonical,
} = M;
export { capture, CaptureError } from './capture.js';
export { checkToolsList, explainCheck, compareToolsLists } from './tools.js';
export { badgeFile, badgeSnippet, summaryMarkdown, sarifWithLocations, webLink, belowMinGrade } from './report.js';
export { VERSION } from './version.js';
