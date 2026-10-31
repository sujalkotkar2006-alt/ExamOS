# Neon project and agent tooling

31 October 2026. This supports the cloud pilot under REQ-06/REQ-08/REQ-09/REQ-11. Installing tooling and creating a database do not establish hosted application acceptance.

## Changes made

- Read the owner's requested [official Neon skill](https://neon.com/.well-known/agent-skills/neon/SKILL.md) and getting-started guide, then inspected existing project and user configuration. No project Neon skills, context or MCP server existed. Existing global MCP servers were preserved.
- Installed the official Neon CLI version 8.15.0 under ignored `data/tools/neon-cli`. Its CLI profile is under ignored `data/cloud/neon-config`. No global npm installation or application dependency/lockfile change was made.
- Installed the official `neon` and `neon-postgres` skills under `.agents/skills/`, including their references (7 and 5 files respectively). No unrelated Neon service skills were installed.
- Created the ExamOS project `wild-lake-66325838` in the owner's Satvik organization `org-aged-shape-11934542`, AWS Singapore, with PostgreSQL 18 and a `production` branch. Only PostgreSQL was selected; existing application authentication and architecture were retained.
- Added the `.neon` context file for that organization/project/branch using `neon link --no-env-pull --no-config`. The CLI appended `.neon` to `.gitignore`. It did not replace local environment values or create a new application policy file.
- Created the project-local `.codex/config.toml` with an OAuth-only `Neon` MCP entry. The final URL is restricted to that project, read-only mode, and `docs`, `schema` and `querying` categories. No API key or password is stored in this configuration. The provider consent page listed 10 read-only tools.
- Authenticated the CLI and the narrowed MCP connection through OAuth. The default Codex client registration failed token exchange with `Invalid redirect URI`; the supported `--oauth-client-registration dcr` login succeeded with `--scopes read`.

Automatic approval review rejected the first, broader OAuth approval because it exposed 120 tools with read/write permissions across all categories. That request was cancelled. It was replaced with the narrower read-only connection; no write access was granted through this MCP installation.

## Preservation and verification

- SHA-256 comparisons confirm the existing local `.env` and global Codex `config.toml` are unchanged. Existing configurations were not replaced. The before-install manifest is ignored local verification output.
- Parsed the project MCP configuration as TOML, checked the project ID, read-only flag and exact categories, and verified it contains only the transport type and public URL.
- `codex mcp get Neon --json` recognizes the server as enabled with streamable HTTP transport.
- `codex mcp login Neon --scopes read --oauth-client-registration dcr` reported successful login. Current chat tools must reload before the new MCP server can be used here; no MCP SQL call has been claimed.
- The authenticated Neon CLI lists the new project in the exact owner-specified organization. This is resource verification, not evidence that the ExamOS schema or hosted application is deployed.

The skills will be available on a subsequent turn. Restart Codex if needed to load the new MCP connection. Database credentials, OAuth profiles and generated private verification artifacts remain outside Git.

## Continuing the pilot

Preserve the live local `.env`: use `--no-env-pull` for linking/checkouts and a separate ignored file if cloud environment values must be written. Never pull cloud credentials over the working local configuration. Use a direct verified-TLS connection for migrations, and the existing PostgreSQL driver for runtime application access. The application schema, cloud teacher provisioning, backend/frontend deployment and hosted acceptance remain separate steps in [CLOUD-PILOT.md](CLOUD-PILOT.md).
