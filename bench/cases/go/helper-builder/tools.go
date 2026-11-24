package main

import "github.com/mark3labs/mcp-go/mcp"

// readTool builds a read-only tool that takes one bucket argument.
func readTool(name, description string) mcp.Tool {
	return mcp.NewTool(name,
		mcp.WithDescription(description),
		mcp.WithString("bucket", mcp.Required(), mcp.Description("Bucket name")),
		mcp.WithReadOnlyHintAnnotation(true),
	)
}
