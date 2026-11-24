//go:build !nostats

package main

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func init() {
	extraTools = append(extraTools, func(s *server.MCPServer) {
		s.AddTool(mcp.NewTool("runtime_stats",
			mcp.WithDescription("Returns goroutine and memory counts."),
			mcp.WithReadOnlyHintAnnotation(true),
		), handle)
	})
}
