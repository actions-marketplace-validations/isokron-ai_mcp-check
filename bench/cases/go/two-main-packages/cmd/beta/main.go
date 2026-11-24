package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func handle(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText(""), nil
}

func main() {
	s := server.NewMCPServer("beta", "1.0.0")
	s.AddTool(mcp.NewTool("beta_status",
		mcp.WithDescription("Returns the status of the beta service."),
		mcp.WithReadOnlyHintAnnotation(true),
	), handle)
	_ = server.ServeStdio(s)
}
