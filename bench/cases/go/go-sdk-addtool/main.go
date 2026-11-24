package main

import (
	"context"
	"log"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type GreetInput struct {
	Name string `json:"name" jsonschema:"the name of the person to greet"`
}

type GreetOutput struct {
	Greeting string `json:"greeting"`
}

func greet(ctx context.Context, req *mcp.CallToolRequest, in GreetInput) (*mcp.CallToolResult, GreetOutput, error) {
	return nil, GreetOutput{Greeting: "Hello " + in.Name}, nil
}

type FarewellInput struct {
	Name string `json:"name" jsonschema:"the name of the person to say goodbye to"`
}

func farewell(ctx context.Context, req *mcp.CallToolRequest, in FarewellInput) (*mcp.CallToolResult, GreetOutput, error) {
	return nil, GreetOutput{Greeting: "Goodbye " + in.Name}, nil
}

func main() {
	server := mcp.NewServer(&mcp.Implementation{Name: "greeter", Version: "v1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "greet", Description: "Says hello to someone."}, greet)
	mcp.AddTool(server, &mcp.Tool{Name: "farewell", Description: "Says goodbye to someone."}, farewell)
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}
