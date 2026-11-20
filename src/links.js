// Channel tags on the links to isokron.ai that this package prints or writes for a person to open.
// Each place a link appears has one fixed pair, utm_source and utm_medium, so the site can tell a visit
// from the terminal from one that came from a job summary. A tag names the place, never the reader:
// no tool name, repository, grade or anything else from a run goes into a tag. (The one link that names a
// repository is its registry listing, registryUrl below: the repository is that page's address, not a tag.)
//
// Not tagged, on purpose: the `docs` values in JSON reports and in the MCP server's tool results (data
// that programs and agents read and compare), the Markdown and JSON exports (your document), and the
// web-checker link that carries a tool list in its fragment.
//
// The table of every tagged surface, across the IsoKron repositories, is docs/LINK-TAGS.md in the site's
// repository; test/link-tags.test.mjs checks this repository against it.

export const SITE_ORIGIN = 'https://isokron.ai';

export const LINK_TAGS = Object.freeze({
  /** --help and the text report, printed in a terminal. */
  cli: Object.freeze({ source: 'mcp-check-cli', medium: 'cli' }),
  /** The GitHub Action's job summary. */
  action: Object.freeze({ source: 'mcp-check-action', medium: 'action' }),
  /** The pull-request comment the Action writes when pr-comment is auto or always. */
  comment: Object.freeze({ source: 'mcp-check-pr-comment', medium: 'action' }),
  /** report.md, committed beside badge.json: what the README badge links to. */
  badge: Object.freeze({ source: 'mcp-check-badge', medium: 'badge' }),
  /** informationUri and helpUri in SARIF, shown by code scanning as the rule's help link. */
  sarif: Object.freeze({ source: 'mcp-check-sarif', medium: 'sarif' }),
  /** websiteUrl in the MCP server's serverInfo, which clients show beside the server's name. */
  server: Object.freeze({ source: 'mcp-check-server', medium: 'mcp' }),
});

const onSite = (url) => url === SITE_ORIGIN || url.startsWith(SITE_ORIGIN + '/') || url.startsWith(SITE_ORIGIN + '?') || url.startsWith(SITE_ORIGIN + '#');

/**
 * `url` with the tag of `surface` in its query, before any fragment. A URL that is not on isokron.ai, or
 * that already carries a utm_source, is returned as it is. Plain string work, so a template such as
 * ".../checks/<id>" keeps its characters.
 */
export function tagged(url, surface) {
  const tag = LINK_TAGS[surface];
  if (!tag) throw new Error('unknown link surface ' + surface);
  const s = String(url);
  if (!onSite(s)) return s;
  const hash = s.indexOf('#');
  const base = hash < 0 ? s : s.slice(0, hash);
  const frag = hash < 0 ? '' : s.slice(hash);
  if (/[?&]utm_source=/.test(base)) return s;
  return base + (base.includes('?') ? '&' : '?') + 'utm_source=' + tag.source + '&utm_medium=' + tag.medium + frag;
}

/**
 * Tags the check-docs links of the engine's Markdown report: exactly the links the engine writes,
 * "[<check id>](<docs base><check id>)" for an ID in `ids`. Nothing else in the text is changed, so a
 * URL that came from the tool list stays as it was.
 */
export function tagDocsLinks(markdown, surface, { docsBase, ids }) {
  const known = ids instanceof Set ? ids : new Set(ids);
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\[([a-z0-9-]+)\\]\\(' + esc(docsBase) + '\\1\\)', 'g');
  return String(markdown).replace(re, (m, id) => (known.has(id) ? '[' + id + '](' + tagged(docsBase + id, surface) + ')' : m));
}

/** The registry listing of a GitHub repository (owner and name lower-cased), with the tag of `surface`. */
export const REGISTRY_BASE = SITE_ORIGIN + '/mcp-check/registry/';
export function registryUrl(owner, repo, surface) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(owner)) || !/^[A-Za-z0-9._-]{1,100}$/.test(String(repo)) || /^\.+$/.test(String(repo))) return null;
  return tagged(REGISTRY_BASE + String(owner).toLowerCase() + '/' + String(repo).toLowerCase(), surface);
}
