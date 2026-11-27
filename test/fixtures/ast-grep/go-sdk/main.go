package main

import (
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Args struct{ Name string }

func main() {
	server := mcp.NewServer(&mcp.Implementation{Name: "greeter"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "greet", Description: "say hi", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, Greet)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "farewell",
		Description: "say bye",
	}, Greet)
}
