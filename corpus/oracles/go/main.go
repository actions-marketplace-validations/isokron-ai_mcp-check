// An independent oracle client for the live-probe lane (corpus/LIVE-PROBE.md, "Oracles"): the official Go SDK
// (github.com/modelcontextprotocol/go-sdk, pinned in go.mod and go.sum), used the way its documentation shows. It
// starts the server command (in the lane, a `docker run -i` of the target's sandbox container: the server never runs
// here), connects with the SDK's default negotiation, lists every page of tools/list, and prints one JSON line. No
// tool is ever called.
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
	"time"

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
	Tools      []*mcp.Tool `json:"tools"`
	MS         *int64      `json:"ms"`
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
	cs, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd, TerminateDuration: 2 * time.Second}, nil)
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
	out.Tools = tools
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
