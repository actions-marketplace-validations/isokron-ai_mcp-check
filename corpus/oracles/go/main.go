// An independent oracle client for the live-probe lane (corpus/LIVE-PROBE.md, "Oracles"): the official Go SDK
// (github.com/modelcontextprotocol/go-sdk, pinned in go.mod and go.sum), used the way its documentation shows. It
// starts the server command (in the lane, a `docker run -i` of the target's sandbox container: the server never runs
// here), connects with the SDK's default negotiation, lists every page of tools/list, and prints one JSON line. No
// tool is ever called.
//
// `tools` is what the server sent, page by page, as raw JSON (R-ORC-11): the SDK's typed mcp.Tool cannot hold every
// field (v1.8.0 has no `execution`, drops annotation keys it does not know and an empty annotations title, and writes
// readOnlyHint and idempotentHint out), so a list re-marshalled from it is the SDK's view, not the server's catalog.
// The typed parse still decides the outcome (the SDK accepted every page) and its count is kept (`typed_tool_count`).
//
//	oracle-go <time limit ms> -- <command...>
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime/debug"
	"strconv"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const maxPages = 100

type serverInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type result struct {
	Format     string      `json:"format"`
	Client     string      `json:"client"`
	SDK        string      `json:"sdk"`
	SDKVersion *string     `json:"sdk_version"`
	Outcome    *string     `json:"outcome"`
	Stage      *string     `json:"stage"`
	Error      *string     `json:"error"`
	Protocol   *string     `json:"protocol"`
	ServerInfo *serverInfo `json:"server_info"`
	Pages      int         `json:"pages"`
	// The tools as the server sent them (every tools/list result, in order), never re-marshalled.
	Tools []json.RawMessage `json:"tools"`
	// "wire" (from the tap below), else "typed" (the SDK's structs, lossy) when no raw page was seen.
	ToolsSource *string `json:"tools_source"`
	TypedCount  *int    `json:"typed_tool_count"`
	MS          *int64  `json:"ms"`
}

// tap keeps the raw result of every tools/list response the connection reads, matched to the request ids it wrote.
// Nothing else changes: each message passes on as it came.
type tap struct {
	mcp.Connection
	mu    sync.Mutex
	ids   map[string]bool
	pages []json.RawMessage
}

func idKey(id jsonrpc.ID) string { return fmt.Sprintf("%T:%v", id.Raw(), id.Raw()) }

func (t *tap) Write(ctx context.Context, m jsonrpc.Message) error {
	if r, ok := m.(*jsonrpc.Request); ok && r.Method == "tools/list" && r.ID.IsValid() {
		t.mu.Lock()
		t.ids[idKey(r.ID)] = true
		t.mu.Unlock()
	}
	return t.Connection.Write(ctx, m)
}

func (t *tap) Read(ctx context.Context) (jsonrpc.Message, error) {
	m, err := t.Connection.Read(ctx)
	if r, ok := m.(*jsonrpc.Response); ok && err == nil && r.Error == nil && r.ID.IsValid() {
		t.mu.Lock()
		if k := idKey(r.ID); t.ids[k] {
			delete(t.ids, k)
			t.pages = append(t.pages, append(json.RawMessage(nil), r.Result...))
		}
		t.mu.Unlock()
	}
	return m, err
}

func (t *tap) rawPages() []json.RawMessage {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]json.RawMessage(nil), t.pages...)
}

type tapTransport struct {
	inner mcp.Transport
	tap   *tap
}

func (t *tapTransport) Connect(ctx context.Context) (mcp.Connection, error) {
	c, err := t.inner.Connect(ctx)
	if err != nil {
		return nil, err
	}
	t.tap.Connection = c
	return t.tap, nil
}

// wireTools: the tools of each raw page, in order, each exactly as sent; ok is false when a page has no tools array.
func wireTools(pages []json.RawMessage) ([]json.RawMessage, bool) {
	tools := []json.RawMessage{}
	for _, p := range pages {
		var page struct {
			Tools []json.RawMessage `json:"tools"`
		}
		if err := json.Unmarshal(p, &page); err != nil || page.Tools == nil {
			return nil, false
		}
		tools = append(tools, page.Tools...)
	}
	return tools, true
}

func str(s string) *string { return &s }

func cut(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func sdkVersion() *string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "github.com/modelcontextprotocol/go-sdk" {
				v := d.Version
				if d.Replace != nil {
					v = d.Replace.Version
				}
				return str(v)
			}
		}
	}
	return nil
}

func run(ms int, command []string, out *result) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(ms)*time.Millisecond)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "isokron-oracle", Version: "1"}, nil)
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Env = os.Environ()
	out.Stage = str("connect")
	tp := &tap{ids: map[string]bool{}}
	cs, err := client.Connect(ctx, &tapTransport{inner: &mcp.CommandTransport{Command: cmd, TerminateDuration: 2 * time.Second}, tap: tp}, nil)
	if err != nil {
		fail(ctx, out, "init_failed", err)
		return
	}
	defer cs.Close()
	if ir := cs.InitializeResult(); ir != nil {
		out.Protocol = str(cut(ir.ProtocolVersion, 40))
		if ir.ServerInfo != nil {
			out.ServerInfo = &serverInfo{Name: cut(ir.ServerInfo.Name, 200), Version: cut(ir.ServerInfo.Version, 64)}
		}
	}
	out.Stage = str("list")
	tools := []*mcp.Tool{}
	cursor := ""
	for {
		params := &mcp.ListToolsParams{}
		if cursor != "" {
			params.Cursor = cursor
		}
		r, err := cs.ListTools(ctx, params)
		if err != nil {
			fail(ctx, out, "list_failed", err)
			return
		}
		out.Pages++
		tools = append(tools, r.Tools...)
		if r.NextCursor == "" {
			break
		}
		if out.Pages >= maxPages {
			fail(ctx, out, "list_failed", fmt.Errorf("paging stopped after %d pages", maxPages))
			return
		}
		if r.NextCursor == cursor {
			fail(ctx, out, "list_failed", errors.New("the server repeated the same cursor"))
			return
		}
		cursor = r.NextCursor
	}
	n := len(tools)
	out.TypedCount = &n
	if raw, ok := wireTools(tp.rawPages()); ok && len(tp.rawPages()) == out.Pages {
		out.Tools = raw
		out.ToolsSource = str("wire")
	} else {
		out.Tools = []json.RawMessage{}
		for _, t := range tools {
			b, err := json.Marshal(t)
			if err != nil {
				fail(ctx, out, "client_error", err)
				return
			}
			out.Tools = append(out.Tools, b)
		}
		out.ToolsSource = str("typed")
	}
	out.Outcome = str("listed")
}

func fail(ctx context.Context, out *result, outcome string, err error) {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		outcome = "timeout"
	}
	out.Outcome = str(outcome)
	out.Error = str(cut(err.Error(), 500))
}

func main() {
	args := os.Args[1:]
	ms, err := strconv.Atoi(firstOr(args, ""))
	if err != nil || ms <= 0 || len(args) < 3 || args[1] != "--" {
		fmt.Fprintln(os.Stderr, "usage: oracle-go <ms> -- <command...>")
		os.Exit(2)
	}
	t0 := time.Now()
	out := &result{Format: "isokron-oracle-client/1", Client: "go", SDK: "github.com/modelcontextprotocol/go-sdk", SDKVersion: sdkVersion()}
	run(ms, args[2:], out)
	d := time.Since(t0).Milliseconds()
	out.MS = &d
	b, err := json.Marshal(out)
	if err != nil {
		b, _ = json.Marshal(map[string]any{"format": "isokron-oracle-client/1", "client": "go", "outcome": "client_error", "error": cut(err.Error(), 500)})
	}
	os.Stdout.Write(append(b, '\n'))
}

func firstOr(a []string, d string) string {
	if len(a) > 0 {
		return a[0]
	}
	return d
}
