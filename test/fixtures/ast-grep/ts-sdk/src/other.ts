// Not a server file: .tool( here belongs to another library.
export function build(chalk: any) {
  return chalk.tool("not_a_tool", "x");
}
