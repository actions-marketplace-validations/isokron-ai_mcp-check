package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func noop(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText(""), nil
}

func main() {
	s := server.NewMCPServer("storage", "0.2.0")
	s.AddTool(readTool("list_objects", "Lists the objects in a bucket."), noop)
	s.AddTool(readTool("bucket_usage", "Returns the bytes stored in a bucket."), noop)
	_ = server.ServeStdio(s)
}
