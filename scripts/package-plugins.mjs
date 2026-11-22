// Writes client plugins/configs for the family memory MCP server.
// Usage: MEMORY_URL=https://<host>/mcp npm run package:plugins
// Each family member sets MEMORY_TOKEN to their own token; tokens are never written to files.
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

// Parse instead of pattern-matching: "http://localhost:x@evil.example/mcp" must not pass as localhost.
let parsed;
try { parsed = new URL(process.env.MEMORY_URL ?? ''); } catch { throw new Error('Set MEMORY_URL to the full server URL ending in /mcp'); }
if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/mcp') throw new Error('MEMORY_URL must be a plain https://<host>/mcp URL');
// Only plain DNS names/IPv4 and a numeric port, so the URL is safe inside the generated shell script and TOML.
if (!/^[a-z0-9.-]+$/.test(parsed.hostname) || !/^\d*$/.test(parsed.port)) throw new Error('MEMORY_URL host must be a plain DNS name or IPv4 address');
const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw new Error('MEMORY_URL must use HTTPS outside localhost');
const url = parsed.href;

const name = 'personal-memory', version = '0.1.0', description = 'Shared family memory over MCP';
const owner = { name: 'Personal Memory' };
const header = { Authorization: 'Bearer ${MEMORY_TOKEN}' };
const files = {
  // Claude Code
  'plugins/claude-code/.claude-plugin/plugin.json': { name, version, description },
  'plugins/claude-code/.mcp.json': { mcpServers: { [name]: { type: 'http', url, headers: header } } },
  '.claude-plugin/marketplace.json': { name: 'personal-memory-marketplace', owner, plugins: [{ name, source: './plugins/claude-code', description }] },
  // GitHub Copilot (agent plugin)
  'plugins/copilot/plugin.json': { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name, version, description },
  'plugins/copilot/mcp.json': { mcpServers: { [name]: { type: 'http', url, headers: header, tools: ['*'] } } },
  '.github/plugin/marketplace.json': { name: 'personal-memory-marketplace', owner, plugins: [{ name, source: './plugins/copilot', description }] },
  // Gemini CLI: installs only from a repo root, so the manifest lives there.
  'gemini-extension.json': { name, version, description,
    settings: [{ name: 'Memory token', description: 'Your personal family memory token', envVar: 'MEMORY_TOKEN', sensitive: true }],
    mcpServers: { [name]: { httpUrl: url, headers: header } } },
};

for (const [path, body] of Object.entries(files)) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 2) + '\n');
}
// Codex: plain config, since the Codex plugin manifest format is not documented.
await mkdir('plugins/codex', { recursive: true });
await writeFile('plugins/codex/config.toml', `[mcp_servers.personal_memory]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "MEMORY_TOKEN"\n`);
await writeFile('plugins/codex/install.sh', `#!/bin/sh\nset -e\ncodex mcp add personal_memory --url '${url}' --bearer-token-env-var MEMORY_TOKEN\n`);
await chmod('plugins/codex/install.sh', 0o755);
console.log(`Wrote Claude Code, Copilot, Codex and Gemini packaging for ${url}`);
