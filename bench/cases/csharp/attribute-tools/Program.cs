using System.ComponentModel;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using ModelContextProtocol.Server;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddMcpServer().WithStdioServerTransport().WithToolsFromAssembly();
await builder.Build().RunAsync();

[McpServerToolType]
public static class TextTools
{
    [McpServerTool(Name = "echo_text", ReadOnly = true), Description("Returns the text it is given.")]
    public static string Echo(string text) => text;

    [McpServerTool(Name = "reverse_text", ReadOnly = true), Description("Returns the text reversed.")]
    public static string Reverse(string text) => new string(text.Reverse().ToArray());
}
