using ModelContextProtocol.Server;
using System.ComponentModel;

[McpServerToolType]
public static class EchoTools
{
    [McpServerTool, Description("Echoes the message back.")]
    public static string Echo(string message) => message;

    [McpServerTool(Name = "custom_name", ReadOnly = true), Description("Named explicitly")]
    public static string Whatever() => "";

    public static void NotATool() {}
}
