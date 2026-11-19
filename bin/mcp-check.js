#!/usr/bin/env node
// npx @isokron/mcp-check tools.json | npx @isokron/mcp-check serve
import { main } from '../src/cli.js';

const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
