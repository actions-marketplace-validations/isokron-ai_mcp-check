// mcp-config.js: read an MCP client's config file and list the servers in it. Browser and Node; no I/O here.
// Formats: Claude Desktop, Claude Code (.mcp.json), Cursor, Windsurf, Cline ({"mcpServers": {...}}),
// VS Code (.vscode/mcp.json {"servers": {...}, "inputs": [...]}, or settings.json {"mcp": {"servers": {...}}}),
// Zed settings ({"context_servers": {...}}). Comments and trailing commas (JSONC) are accepted.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.McpConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // JSONC -> JSON: strip // and /* */ comments and trailing commas outside strings.
  function stripJsonc(text) {
    let out = ''; let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) { out += c; if (c === '\\') { out += text[++i] || ''; } else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; out += c; continue; }
      if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
      if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
      out += c;
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
  }

  const VAR = /\$\{(?:(env|input):)?([A-Za-z_][\w.-]*)\}/g;
  // Resolve ${env:X} / ${X} from env; ${input:x} and unknown names stay and are reported.
  function resolveVars(v, env, missing) {
    if (typeof v === 'string') {
      return v.replace(VAR, (m, kind, name) => {
        if (kind === 'input') { missing.add('input:' + name); return m; }
        if (env && Object.prototype.hasOwnProperty.call(env, name)) return env[name];
        if (name === 'workspaceFolder' || name === 'userHome') return m;
        missing.add('env:' + name); return m;
      });
    }
    if (Array.isArray(v)) return v.map((x) => resolveVars(x, env, missing));
    if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = resolveVars(v[k], env, missing); }); return o; }
    return v;
  }

  function normalise(name, s, env) {
    const missing = new Set();
    if (!s || typeof s !== 'object') return { name, error: 'not an object' };
    // Zed: { command: { path, args, env } } or { command, args }
    let command = s.command; let args = s.args; let senv = s.env;
    if (command && typeof command === 'object') { args = command.args; senv = command.env; command = command.path || command.command; }
    const type = String(s.type || s.transport || (s.url || s.serverUrl || s.httpUrl ? 'http' : 'stdio')).toLowerCase();
    const out = { name, disabled: s.disabled === true || s.enabled === false };
    if (type === 'stdio' || (command && !s.url && !s.serverUrl && !s.httpUrl)) {
      if (typeof command !== 'string' || !command) return { name, error: 'no command' };
      Object.assign(out, { transport: 'stdio', command: resolveVars(command, env, missing), args: resolveVars(Array.isArray(args) ? args.map(String) : [], env, missing), env: resolveVars(senv && typeof senv === 'object' ? senv : {}, env, missing), cwd: s.cwd || undefined });
    } else {
      const url = s.url || s.serverUrl || s.httpUrl;
      if (typeof url !== 'string') return { name, error: 'no url' };
      Object.assign(out, { transport: type === 'sse' ? 'sse' : 'http', url: resolveVars(url, env, missing), headers: resolveVars(s.headers && typeof s.headers === 'object' ? s.headers : {}, env, missing) });
    }
    if (missing.size) out.unresolved = Array.from(missing);
    return out;
  }

  function parseConfig(text, opts) {
    const env = (opts && opts.env) || {};
    let data;
    try { data = JSON.parse(stripJsonc(String(text))); } catch (e) { return { error: 'Not valid JSON: ' + e.message }; }
    if (!data || typeof data !== 'object') return { error: 'Not a config object.' };
    let format = null; let map = null;
    if (data.mcpServers && typeof data.mcpServers === 'object') { format = 'mcpServers'; map = data.mcpServers; }
    else if (data.servers && typeof data.servers === 'object') { format = 'vscode'; map = data.servers; }
    else if (data.mcp && data.mcp.servers && typeof data.mcp.servers === 'object') { format = 'vscode-settings'; map = data.mcp.servers; }
    else if (data.context_servers && typeof data.context_servers === 'object') { format = 'zed'; map = data.context_servers; }
    if (!map) return { error: 'No MCP servers found (expected "mcpServers", "servers", "mcp.servers" or "context_servers").' };
    const servers = Object.keys(map).map((k) => normalise(k, map[k], env));
    return { format, servers };
  }

  // Where the common clients keep their config. home: the user's home directory; platform: process.platform.
  function knownConfigPaths(home, platform, appData, cwd) {
    const j = (...p) => p.join(platform === 'win32' ? '\\' : '/');
    const out = [];
    if (platform === 'darwin') out.push(['Claude Desktop', j(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')]);
    else if (platform === 'win32') out.push(['Claude Desktop', j(appData || j(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')]);
    else out.push(['Claude Desktop', j(home, '.config', 'Claude', 'claude_desktop_config.json')]);
    out.push(['Cursor (user)', j(home, '.cursor', 'mcp.json')]);
    out.push(['Windsurf', j(home, '.codeium', 'windsurf', 'mcp_config.json')]);
    if (cwd) {
      out.push(['Claude Code (project)', j(cwd, '.mcp.json')]);
      out.push(['Cursor (project)', j(cwd, '.cursor', 'mcp.json')]);
      out.push(['VS Code (workspace)', j(cwd, '.vscode', 'mcp.json')]);
    }
    return out.map(([client, path]) => ({ client, path }));
  }

  return { parseConfig, stripJsonc, knownConfigPaths, resolveVars };
});
