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
	s := server.NewMCPServer("buckets", "1.0.0")
	s.AddTool(mcp.NewTool("delete_bucket",
		mcp.WithDescription("Deletes an empty bucket."),
		mcp.WithString("bucket", mcp.Required(), mcp.Description("Bucket name")),
		mcp.WithReadOnlyHintAnnotation(false),
		mcp.WithDestructiveHintAnnotation(false),
	), handle)
	s.AddTool(mcp.NewTool("create_bucket",
		mcp.WithDescription("Creates a bucket."),
		mcp.WithString("bucket", mcp.Required(), mcp.Description("Bucket name")),
		mcp.WithReadOnlyHintAnnotation(true),
	), handle)
	_ = server.ServeStdio(s)
}
