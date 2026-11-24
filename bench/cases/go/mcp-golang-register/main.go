package main

import (
	mcp_golang "github.com/metoro-io/mcp-golang"
	"github.com/metoro-io/mcp-golang/transport/stdio"
)

type HelloArgs struct {
	Name string `json:"name" jsonschema:"required,description=Who to greet"`
}

func main() {
	server := mcp_golang.NewServer(stdio.NewStdioServerTransport())
	_ = server.RegisterTool("say_hello", "Says hello to someone.", func(args HelloArgs) (*mcp_golang.ToolResponse, error) {
		return mcp_golang.NewToolResponse(mcp_golang.NewTextContent("Hello " + args.Name)), nil
	})
	_ = server.RegisterTool("say_goodbye", "Says goodbye to someone.", func(args HelloArgs) (*mcp_golang.ToolResponse, error) {
		return mcp_golang.NewToolResponse(mcp_golang.NewTextContent("Goodbye " + args.Name)), nil
	})
	_ = server.Serve()
	select {}
}
