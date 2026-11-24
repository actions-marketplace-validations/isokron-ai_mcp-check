package main

import (
	"context"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func handle(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText(""), nil
}

func main() {
	s := server.NewMCPServer("admin", "1.0.0")
	s.AddTool(mcp.NewTool("list_tenants",
		mcp.WithDescription("Lists tenants."),
		mcp.WithReadOnlyHintAnnotation(true),
	), handle)
	if os.Getenv("ADMIN_WRITES") == "1" {
		s.AddTool(mcp.NewTool("suspend_tenant",
			mcp.WithDescription("Suspends a tenant until it is resumed."),
			mcp.WithString("tenant", mcp.Required(), mcp.Description("Tenant id")),
		), handle)
	}
	_ = server.ServeStdio(s)
}
