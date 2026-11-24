// C# source reader (src/inputs/repo-csharp.cjs) and its use by --repo-dir and the loop worker: small synthetic sources
// written for these tests from the official C# SDK's documented forms ([McpServerToolType], [McpServerTool],
// [Description], WithTools<T>()), checked against what ModelContextProtocol 2.4.0 with Microsoft.Extensions.AI 10.11
// writes: names, the "Returns:" suffix, title and annotations, the input schema of each parameter kind, and the
// parameters the SDK binds itself. Plus the rules every reader keeps: nothing invented, nothing dropped silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSubject } from '../corpus/scan-static.mjs';

const require = createRequire(import.meta.url);
const CS = require('../src/inputs/repo-csharp.cjs');
const R = require('../src/inputs/repo-source.cjs');
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-check.js');

const read = (files, manifests) => CS.analyse(Object.entries(files), { manifests: Object.entries(manifests || {}) });
const byName = (r) => Object.fromEntries(r.found.map((x) => [x.tool.name, x.tool]));
const tree = (files) => { const d = mkdtempSync(join(tmpdir(), 'mcpcheck-cs-')); for (const [p, t] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), t); } return d; };
const CSPROJ = (v) => '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><Nullable>enable</Nullable></PropertyGroup>\n  <ItemGroup><PackageReference Include="ModelContextProtocol" Version="' + (v || '2.4.0') + '" /></ItemGroup>\n</Project>\n';
const PROGRAM = 'using ModelContextProtocol.Server;\nvar builder = Host.CreateApplicationBuilder(args);\nbuilder.Services.AddMcpServer().WithStdioServerTransport().WithToolsFromAssembly();\nawait builder.Build().RunAsync();\n';

test('R-RD-06: tokenizer: verbatim, interpolated and raw string literals, chars, doc comments and preprocessor lines', () => {
  const { t, docs } = CS.tokenize('/// <summary>Hi</summary>\n#if DEBUG\nvar a = @"C:\\x ""q""";\n#endif\nvar b = "a\\tb"; var c = \'\\n\'; var d = """\n    raw "text"\n      indented\n    """;\nvar e = $"x{N}y";\n');
  assert.deepEqual(t.filter((x) => x.y === 'str').map((x) => x.v), ['C:\\x "q"', 'a\tb', 'raw "text"\n  indented']);
  assert.equal(t.find((x) => x.y === 'chr').v, '\n');
  assert.deepEqual(t.find((x) => x.y === 'interp').exprs, ['N']);
  assert.deepEqual(docs.map((x) => x.text), ['<summary>Hi</summary>']);
  assert.ok(!t.some((x) => x.v === 'DEBUG'));
});

test('R-RD-06: names as the SDK derives them: Name, or the method name without Async, in snake_case (method name before 0.3.0-preview.2)', () => {
  assert.equal(CS.snakeLower('GetTodoItems'), 'get_todo_items');
  assert.equal(CS.snakeLower('XMLReader'), 'xml_reader');
  assert.equal(CS.snakeLower('SHA512Hash'), 'sha512_hash');
  assert.equal(CS.deriveName('SearchAsync', true, true), 'search');
  assert.equal(CS.deriveName('SearchAsync', false, true), 'search_async'); // not async: the suffix stays
  assert.equal(CS.deriveName('Async', true, true), 'async');
  const src = { 'Tools.cs': `using System.ComponentModel;
using ModelContextProtocol.Server;
[McpServerToolType]
public static class EchoTools
{
    public const string Prefix = "notes_";
    [McpServerTool, Description("Echoes the message back.")]
    public static string Echo(string message) => message;
    [McpServerTool(Name = Prefix + "search")]
    public static async Task<string> SearchNotesAsync(string query) => query;
    [McpServerTool(Name = nameof(ListAll))]
    public static Task<string[]> ListAll() => Task.FromResult(new string[0]);
}` };
  assert.deepEqual(read(src).found.map((x) => x.tool.name), ['echo', 'notes_search', 'ListAll']);
  assert.deepEqual(read(src, { 'a.csproj': CSPROJ('0.2.0-preview.3') }).found.map((x) => x.tool.name), ['Echo', 'notes_search', 'ListAll']);
  assert.deepEqual(read(src, { 'Directory.Packages.props': '<Project><PropertyGroup><McpVersion>0.3.0-preview.4</McpVersion></PropertyGroup><ItemGroup><PackageVersion Include="ModelContextProtocol" Version="$(McpVersion)" /></ItemGroup></Project>' }).found.map((x) => x.tool.name), ['echo', 'notes_search', 'ListAll']);
});

test('R-RD-06: descriptions, "Returns:" unless UseStructuredContent, title and annotations only when set, icons', () => {
  const r = byName(read({ 'Tools.cs': `using System.ComponentModel;
using ModelContextProtocol.Server;
[McpServerToolType]
public class NoteTools(INoteStore store)
{
    private const string Desc = "Deletes a note.";
    [McpServerTool(Name = "delete_note", Title = "Delete a note", Destructive = true, ReadOnly = false, IconSource = "https://example.com/i.png")]
    [Description(Desc + " It cannot be undone.")]
    [return: Description("The id of the deleted note")]
    public async Task<string> DeleteAsync([Description("The note id")] string id) => id;

    [McpServerTool(Name = "count_notes", UseStructuredContent = true), Description("Counts notes.")]
    [return: Description("How many")]
    public int Count() => 0;

    [McpServerTool(Name = "plain")]
    public string Plain() => "";
}` }));
  assert.deepEqual(r.delete_note, {
    name: 'delete_note', description: 'Deletes a note. It cannot be undone.\nReturns: The id of the deleted note', title: 'Delete a note',
    annotations: { title: 'Delete a note', readOnlyHint: false, destructiveHint: true }, icons: [{ src: 'https://example.com/i.png' }],
    inputSchema: { type: 'object', properties: { id: { description: 'The note id', type: 'string' } }, required: ['id'] },
  });
  assert.equal(r.count_notes.description, 'Counts notes.');
  assert.ok(!('annotations' in r.count_notes) && !('title' in r.count_notes) && !('outputSchema' in r.count_notes));
  assert.equal(r.plain.description, ''); // the SDK sends an empty description, not none
});

test('R-RD-06: input schemas: types, nullables, defaults, enums, arrays, dictionaries and data annotations, as AIJsonUtilities writes them', () => {
  const r = byName(read({ 'Tools.cs': `using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using ModelContextProtocol.Server;
public enum Sort { Newest, Oldest }
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum Mode { [JsonStringEnumMemberName("quick")] Quick, [JsonStringEnumMemberName("full")] Full }
[McpServerToolType]
public static class SearchTools
{
    private const int DefaultLimit = 20;
    [McpServerTool(Name = "search"), Description("Searches.")]
    public static string Search(
        [Description("Words")] string query,
        int limit = DefaultLimit,
        double? minScore = null,
        bool exact = false,
        Sort sort = Sort.Oldest,
        Mode mode = Mode.Quick,
        string? tag = null,
        string[] fields = null!,
        List<int>? ids = null,
        Dictionary<string, string>? labels = null,
        Guid? owner = null,
        DateTimeOffset? since = null,
        [Range(1, 100)] int pages = 1,
        [StringLength(50, MinimumLength = 2), RegularExpression("^[a-z]+$")] string? slug = null,
        [DefaultValue("en")] string language = "en",
        CancellationToken cancellationToken = default) => query;
}` }));
  assert.deepEqual(r.search.inputSchema, {
    type: 'object',
    properties: {
      query: { description: 'Words', type: 'string' },
      limit: { type: 'integer', default: 20 },
      minScore: { type: ['number', 'null'], default: null },
      exact: { type: 'boolean', default: false },
      sort: { type: 'string', enum: ['Newest', 'Oldest'], default: 'Oldest' },
      mode: { type: 'string', enum: ['quick', 'full'], default: 'quick' },
      tag: { type: ['string', 'null'], default: null },
      fields: { type: 'array', items: { type: 'string' }, default: null },
      ids: { type: ['array', 'null'], items: { type: 'integer' }, default: null },
      labels: { type: ['object', 'null'], additionalProperties: { type: 'string' }, default: null },
      owner: { type: ['string', 'null'], format: 'uuid', default: null },
      since: { type: ['string', 'null'], format: 'date-time', default: null },
      pages: { type: 'integer', default: 1, minimum: 1, maximum: 100 },
      slug: { type: ['string', 'null'], default: null, minLength: 2, maxLength: 50, pattern: '^[a-z]+$' },
      language: { type: 'string', default: 'en' },
    },
    required: ['query'],
  });
});

test('R-RD-06: parameters the SDK binds and services are left out; an argument object or an unknown default makes the schema unreadable, never guessed', () => {
  const r = read({ 'Program.cs': PROGRAM + 'builder.Services.AddSingleton<NoteStore>();\nvar cache = new Cache();\nbuilder.Services.AddSingleton(cache);\n', 'Tools.cs': `using ModelContextProtocol.Server;
public record Filter(string Tag, int Max);
[McpServerToolType]
public static class T
{
    [McpServerTool] public static string A(McpServer server, RequestContext<CallToolRequestParams> ctx, IProgress<ProgressNotificationValue> progress, ILogger<T> log, IHttpClientFactory http, INoteRepo repo, NoteStore store, Cache cache, [FromKeyedServices("x")] Other other, string q, CancellationToken ct) => q;
    [McpServerTool] public static string B(Filter filter) => "";
    [McpServerTool] public static string C(int size = Sizes.Default) => "";
}` });
  const t = byName(r);
  assert.deepEqual(t.a.inputSchema, { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
  assert.deepEqual(t.b.inputSchema, { type: 'object' });
  assert.deepEqual(t.b._unreadable, ['inputSchema']);
  assert.deepEqual(t.c._unreadable, ['inputSchema']);
  // and through publicTools, the marker the grader skips
  assert.deepEqual(R.publicTools([t.b]).unreadable, { inputSchema: ['b'] });
});

test('R-RD-06: registration: [McpServerToolType] or WithTools<T>(); other [McpServerTool] methods are listed and marked; McpServerTool.Create is counted unresolved; a name not worked out is unresolved with its text', () => {
  const r = read({ 'Program.cs': 'builder.Services.AddMcpServer().WithTools<Plain>();\nvar extra = McpServerTool.Create((string s) => s, new() { Name = "made", Description = "Made in code." });\n', 'Tools.cs': `using ModelContextProtocol.Server;
public class Plain { [McpServerTool] public static string Listed() => ""; }
public class Stray { [McpServerTool] public static string Unseen() => ""; }
[McpServerToolType]
public class Odd { [McpServerTool(Name = Config.Get("x")), Description("Hidden text here.")] public static string Q() => ""; }` });
  assert.deepEqual(r.found.map((x) => [x.tool.name, x.marks.map((m) => m.reason)]), [['listed', []], ['unseen', ['registration-not-seen']]]);
  assert.equal(r.unresolved.length, 2);
  assert.ok(r.unresolved.some((u) => u.lost.includes('Made in code.')));
  assert.ok(r.unresolved.some((u) => u.lost.includes('Hidden text here.')));
});

test('R-RD-06: a partial method without [Description] gets its XML doc comment, as the SDK\'s source generator writes it', () => {
  const t = byName(read({ 'Tools.cs': `using ModelContextProtocol.Server;
[McpServerToolType]
public partial class Docs
{
    /// <summary>
    /// Finds a <see cref="Note"/> by
    /// its <c>id</c>.
    /// </summary>
    /// <param name="id">The note id.</param>
    /// <returns>The note text.</returns>
    [McpServerTool]
    public static partial string FindNote(string id);
    /// <summary>Not partial: the comment is not used.</summary>
    [McpServerTool]
    public static string Other(string id) => id;
}` }));
  assert.equal(t.find_note.description, 'Finds a  by its id.\nReturns: The note text.'); // the <see/> leaves its two spaces, as XElement.Value does
  assert.deepEqual(t.find_note.inputSchema.properties.id, { description: 'The note id.', type: 'string' });
  assert.equal(t.other.description, '');
});

test('R-RD-06: --repo-dir grades a C# server (derived, approximate); bin, obj and test projects are not read; a monorepo of C# servers is refused with the folders', () => {
  const one = tree({
    'src/Notes/Notes.csproj': CSPROJ(), 'src/Notes/Program.cs': PROGRAM,
    'src/Notes/Tools/NoteTools.cs': 'using System.ComponentModel;\nusing ModelContextProtocol.Server;\n[McpServerToolType]\npublic static class NoteTools\n{\n    [McpServerTool(Name = "search_notes", Title = "Search notes", ReadOnly = true), Description("Searches notes by text. Use it to find a note before reading it.")]\n    public static string Search([Description("Words to find")] string query) => query;\n}\n',
    'src/Notes/obj/Generated.cs': '[McpServerToolType] public static class G { [McpServerTool] public static string Gen() => ""; }\n',
    'tests/Notes.Tests/Notes.Tests.csproj': CSPROJ(), 'tests/Notes.Tests/T.cs': '[McpServerToolType] public static class X { [McpServerTool] public static string TestOnly() => ""; }\n',
  });
  const r = spawnSync(process.execPath, [BIN, '--repo-dir', one, '--format', 'json'], { encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.source.language, 'c#');
  assert.equal(j.source.fidelity, 'derived');
  assert.equal(j.source.approximate, true);
  assert.equal(j.input.tools, 1);
  const two = tree({
    'a/A.csproj': CSPROJ(), 'a/Program.cs': PROGRAM, 'a/T.cs': '[McpServerToolType] public static class A { [McpServerTool] public static string One() => ""; }\n',
    'b/B.csproj': CSPROJ(), 'b/Program.cs': PROGRAM, 'b/T.cs': '[McpServerToolType] public static class B { [McpServerTool] public static string Two() => ""; }\n',
  });
  const m = spawnSync(process.execPath, [BIN, '--repo-dir', two], { encoding: 'utf8' });
  assert.equal(m.status, 3);
  assert.match(m.stderr, /more than one server/);
});

test('R-RD-06: the loop worker grades a C# repository instead of skipping it as unsupported_language; Swift stays unsupported', async () => {
  const files = {
    'Notes.csproj': CSPROJ(), 'Program.cs': PROGRAM,
    'Tools.cs': 'using System.ComponentModel;\nusing ModelContextProtocol.Server;\n[McpServerToolType]\npublic static class NoteTools\n{\n    [McpServerTool(Name = "search_notes"), Description("Searches notes by text.")]\n    public static string Search([Description("Words to find")] string query) => query;\n}\n',
  };
  const swift = { 'Package.swift': '// swift-tools-version:5.9\n', 'Sources/Main.swift': 'print("hi")\n' };
  const fake = (repoFiles) => async (url) => {
    const u = String(url);
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/\/repos\/o\/r$/.test(u)) return json({ full_name: 'o/r', default_branch: 'main', private: false });
    if (/\/branches\/main$/.test(u)) return json({ commit: { sha: 'a'.repeat(40), commit: { committer: { date: '2026-11-23T00:00:00Z' } } } });
    if (/\/git\/trees\//.test(u)) return json({ sha: 'a'.repeat(40), truncated: false, tree: Object.keys(repoFiles).map((p) => ({ path: p, type: 'blob', size: repoFiles[p].length })) });
    const m = /raw\.githubusercontent\.com\/o\/r\/[0-9a-f]{40}\/(.+)$/.exec(u);
    if (m && repoFiles[decodeURIComponent(m[1])] !== undefined) return new Response(repoFiles[decodeURIComponent(m[1])], { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const g = await scanSubject('o/r', { fetch: fake(files) });
  assert.equal(g.status, 'graded', JSON.stringify(g));
  assert.equal(g.list.language, 'c#');
  assert.equal(g.list.tools_listed, 1);
  const s = await scanSubject('o/r', { fetch: fake(swift) });
  assert.equal(s.detail, 'unsupported_language');
  assert.equal(s.language_hint, 'Swift');
});

test('R-RD-06: linear time on a large hostile C# file', () => {
  const body = '[McpServerToolType] public static class Big {\n' + Array.from({ length: 4000 }, (_, k) => '  [McpServerTool(Name = "t' + k + '"), Description("D' + k + '")] public static string M' + k + '([Description("x")] string a, int b = ' + k + ') => a;\n').join('') + '}\n';
  const deep = '[McpServerToolType] class D { [McpServerTool] static string X(' + '('.repeat(20000) + ') => ""; }';
  const t0 = performance.now();
  const r = read({ 'Big.cs': body, 'Deep.cs': deep });
  assert.equal(r.found.filter((x) => /^t\d+$/.test(x.tool.name)).length, 4000);
  assert.ok(performance.now() - t0 < 5000, 'took ' + (performance.now() - t0) + ' ms');
});
