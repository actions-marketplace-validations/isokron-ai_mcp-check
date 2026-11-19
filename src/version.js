// The package version, read from package.json so the CLI, the MCP server and the Action report one version.
import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
