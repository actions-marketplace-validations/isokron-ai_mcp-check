package main

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const toolName = "const_named"

func main() {
	s := server.NewMCPServer("demo", "1.0.0")
	tool := mcp.NewTool("hello_world",
		mcp.WithDescription("Say hello"),
		mcp.WithString("name", mcp.Required()),
		mcp.WithReadOnlyHintAnnotation(true),
	)
	s.AddTool(tool, nil)
	s.AddTool(mcp.NewTool("second_tool", mcp.WithDescription("Second")), nil)
	s.AddTool(mcp.NewTool(toolName, mcp.WithDescription("by const")), nil)
	s.AddTool(mcp.NewTool(computed()), nil)
}

func computed() string { return "x" }
