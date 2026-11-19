// Loads the vendored check engine (engine/core.js, the same file as the isokron.ai/mcp-check page).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../engine/core.js');
export default M;
