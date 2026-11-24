//go:build debugtools

package main

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func init() {
	extraTools = append(extraTools, func(s *server.MCPServer) {
		s.AddTool(mcp.NewTool("dump_memory",
			mcp.WithDescription("Writes a heap profile to disk."),
		), handle)
	})
}
