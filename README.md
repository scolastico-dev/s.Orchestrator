# s.Orchestrator

An SSH deployment orchestrator that uploads local assets and runs shell scripts across multiple remote servers **in parallel**, with a full-featured terminal UI (or plain log output for CI/CD environments).

```log
┌─[web] ───────────────────────────────────────────────────────────────────────┐
│ Checking connection...                                                       │
│ Connection OK                                                                │
│ Creating remote base directory...                                            │
│ Uploading scripts...                                                         │
│ Running: 01-install.sh                                                       │
│ [...]                                                                        │
│ COMPLETED SUCCESSFULLY                                                       │
└──────────────────────────────────────────────────────────────────────────────┘
 Switch: [TAB] | Scroll: [SHIFT]+[↑/↓] [PGUP/PGDN] | Quit: [CTRL+C] | ...
```

## Why s.Orchestrator?

When you need to provision a machine, deploy an app, or apply quick updates across a handful of servers, heavyweight configuration management tools often feel like overkill. s.Orchestrator gets out of your way. There is no complex syntax to learn - just write standard bash scripts, point them at a JSON config, and watch everything execute concurrently.

**Compared to Ansible:**

|                            | s.Orchestrator                          | Ansible                           |
|----------------------------|-----------------------------------------|-----------------------------------|
| Learning curve             | Low - just bash + JSON                  | Medium - YAML, modules, playbooks |
| Target requirements        | SSH only                                | SSH + Python on target            |
| Idempotency                | Manual (write your scripts defensively) | Built-in via modules              |
| Parallel execution         | Always                                  | Configurable (`forks`)            |
| Module ecosystem           | None                                    | Large (ansible-galaxy)            |
| Live feedback              | TUI with per-server log panes           | stdout only                       |
| Config management at scale | Not suitable                            | Purpose-built                     |

**Use s.Orchestrator when** you manage a small cluster of servers, you already know the exact shell commands you want to run, and you want zero tooling overhead.

**Use Ansible when** you require built-in idempotency, complex configuration templating (Jinja2), or are managing large enterprise infrastructure.

## Features

* **Parallel deployment** - all servers deploy simultaneously; per-server log panes in the TUI
* **Host key enforcement** - on first contact, fetches all key types offered by the server and prompts you to save them; on subsequent runs, verifies each stored key type against `known_hosts`; all mismatches are reported together in a single run
* **TUI with tab switching** - navigate between server log panes, scroll history, forward keystrokes to interactive SSH sessions
* **Plain mode (`--ugly`)** - prefix-based log output suitable for CI/CD pipelines and logging
* **Dry-run mode** - validates config and tests connections without executing any remote commands
* **JSON schema export** - emit a JSON Schema file for the config so editors can validate it
* **Injected environment variables** - every script receives a standard set of server variables automatically; additional per-server variables can be added via `env` in the config
* **Optional key file** - specify a per-server SSH private key; falls back to the SSH agent/defaults
* **Per-server log files** - each server's output is saved to `logs/<name>.log`

## Lite Version

For environments where Node.js is unavailable, a self-contained bash implementation is provided in [`lite-version.sh`](./lite-version.sh). It shares the same config format and feature set but deploys servers **sequentially** and has no TUI.

**Requirements:** `bash`, `ssh`, `scp`, `ssh-keyscan`, `ssh-keygen`, `jq`

```bash
# Run directly (no build or Node.js required)
curl -sSL https://raw.githubusercontent.com/scolastico-dev/orchestrator/main/lite-version.sh | bash -s -- [options]
```

The lite version supports all the same options as the full version except `--ugly` and `--schema`:

```log
Options:
  -c, --config <path>       path to config JSON file            (default: config.json)
  -y, --skip-confirm         skip confirmation after connection tests
  -n, --dry-run             test connections, do not deploy
  --log-dir <path>          directory for per-server log files  (default: logs)
  --assets-dir <path>       local assets directory to upload    (default: assets)
  --scripts-dir <path>      local scripts directory             (default: scripts)
  --remote-path <path>      remote working directory            (default: /tmp/s-orchestrator)
```

| Feature                      | Full version | Lite version    |
|------------------------------|--------------|-----------------|
| Parallel deployment          | yes          | no - sequential |
| TUI / plain mode             | yes          | plain only      |
| Host key enforcement (TOFU)  | yes          | yes             |
| Env injection                | yes          | yes             |
| Dry-run mode                 | yes          | yes             |
| Per-server log files         | yes          | yes             |
| `keyFile` / `knownHostsFile` | yes          | yes             |
| JSON schema export           | yes          | no              |
| Node.js required             | yes          | no              |

## Installation

### From npm, installed globally

```bash
# Install with npm
npm i -g @scolastico-dev/orchestrator

# Then run it
s-orchestrator [options]

```

### From npm, installed locally

```bash
# Install with npm
npm i @scolastico-dev/orchestrator

```

Then add a script to `package.json`:

```json
{
  "scripts": {
    "deploy": "s-orchestrator [options]"
  }
}

```

And run it with:

```bash
npm run deploy

```

### From source

```bash
# Clone and build
git clone https://github.com/scolastico-dev/orchestrator.git
cd orchestrator
pnpm install
pnpm build

# Then run it
node dist/index.js [options]
```

## Quick Start

**1. Create `config.json`**

```json
{
  "web": {
    "ip": "203.0.113.10",
    "user": "deploy",
    "env": {
      "APP_ENV": "production"
    }
  },
  "db": {
    "ip": "203.0.113.20",
    "port": 2222,
    "keyFile": "~/.ssh/db_deploy"
  }
}
```

**2. Add your scripts**

```log
scripts/
  01-update.sh
  02-restart.sh
```

> It's important to prefix your scripts with numbers to ensure they run in the correct order, as they are executed in lexicographic order.

> Ensure all scripts are written in a "upsert" style, meaning they can be run multiple times without causing issues. s.Orchestrator does not enforce idempotency, so your scripts should be designed to handle repeated executions gracefully.

**3. Run**

```bash
s-orchestrator
```

On first run, s.Orchestrator will fetch all SSH host key types for each server and ask you to confirm before saving them to `config.json`. Subsequent runs verify every stored key type and abort if any of them changes (TOFU - Trust On First Use).

See [`example/`](https://github.com/scolastico-dev/s.Orchestrator/tree/main/example) for a complete working example that provisions two Debian servers: apt upgrade, SSH key setup, and Docker installation.

## Configuration Reference

The config file is a JSON object whose **keys are server names** and whose **values are server configs**:

| Field            | Type                    | Default  | Description                                                                                        |
|------------------|-------------------------|----------|----------------------------------------------------------------------------------------------------|
| `ip`             | `string` (**required**) | -        | IP address or hostname                                                                             |
| `port`           | `number`                | `22`     | SSH port                                                                                           |
| `user`           | `string`                | `"root"` | SSH username                                                                                       |
| `hostKeys`       | `string[]`              | -        | Stored host public keys for all key types (auto-populated on first run)                            |
| `keyFile`        | `string`                | -        | Path to SSH private key file                                                                       |
| `knownHostsFile` | `string`                | -        | Path to a custom `known_hosts` file (useful in CI/CD)                                              |
| `env`            | `Record<string,string>` | -        | Extra environment variables injected into each script (merged on top of the default injected vars) |

### Export JSON Schema

```bash
s-orchestrator --schema                      # print schema to stdout
s-orchestrator --schema config.schema.json   # write to file
```

Add to `config.json` for editor validation:

```json
{
  "$schema": "./config.schema.json",
  "web": { "ip": "..." }
}
```

## Injected Environment Variables

Every script execution receives the following environment variables automatically:

| Variable          | Value                                            |
|-------------------|--------------------------------------------------|
| `SERVER_NAME`     | The server's key in `config.json`                |
| `SERVER_IP`       | The server's `ip` field                          |
| `SERVER_USER`     | The SSH username (`user`, default `root`)        |
| `SERVER_SSH_PORT` | The SSH port (`port`, default `22`)              |
| `ASSET_DIR`       | Absolute remote path where assets were uploaded  |
| `SCRIPT_DIR`      | Absolute remote path where scripts were uploaded |

Variables defined in the server's `env` block are merged on top, so they can override any of the above if needed.

## CLI Reference

```
Usage: s-orchestrator [options]

Options:
  -v, --version             print version and exit
  -c, --config <path>       path to config JSON file            (default: "config.json")
  -y, --skip-confirm         skip confirmation after connection tests
  -n, --dry-run             test connections, do not deploy
  --schema [path]           export JSON schema for config
  --ugly                    plain log output, no TUI
  --log-dir <path>          directory for per-server log files  (default: "logs")
  --assets-dir <path>       local assets directory to upload    (default: "assets")
  --scripts-dir <path>      local scripts directory             (default: "scripts")
  --remote-path <path>      remote working directory            (default: "/tmp/s-orchestrator")
  -h, --help                display help
```

### Examples

```bash
# Production deploy with a dedicated config
s-orchestrator -c prod.json

# Skip confirmation prompt (for automated pipelines)
s-orchestrator -y

# Dry run - verify config and connections without deploying
s-orchestrator --dry-run --ugly

# CI/CD friendly - ugly mode, skip confirm, custom config
s-orchestrator --ugly -y -c /etc/deploy/config.json

# Export the JSON schema
s-orchestrator --schema > config.schema.json
```

## Deployment Flow

For each run, s.Orchestrator:

1. **Validates** the config file
2. **Enforces host keys** - fetches all key types on first use (with confirmation), verifies each type on subsequent runs; all mismatches are collected and reported together; any newly confirmed keys are saved to the config even if mismatches are found
3. **Tests connections** to all servers in parallel - aborts immediately if any connection fails
4. **Prompts to start** (unless `--skip-confirm`)
5. **Deploys to all servers in parallel**:
* Creates `<remote-path>/` on the remote
* Uploads `assets/` (if present)
* Uploads `scripts/`
* Executes each `.sh` script in lexicographic order with injected environment variables
* Cleans up `<remote-path>/` on the remote


6. **Displays final status** - Ctrl+C after this point exits cleanly without an abort prompt

## Directory Layout

```
your-project/
├── config.json          # server config (managed by s.Orchestrator)
├── assets/              # files uploaded verbatim (optional)
│   └── nginx.conf
└── scripts/             # executed in alphabetical order on each server
    ├── 01-update.sh
    └── 02-restart.sh
```

## Development

```bash
pnpm install

# Type check
pnpm typecheck

# Run tests (unit tests run always; Docker integration tests require Docker)
pnpm test
pnpm test:watch

# Build (Parcel compiles TypeScript → dist/index.js)
pnpm build

# Run from source (no build needed)
pnpm dev -- --help
```

### Project Structure

```
src/
├── index.ts          entry point, main()
├── cli.ts            CLI argument parsing (commander)
├── types.ts          shared TypeScript types
├── config.ts         Zod schema, load / save / export-schema
├── logger.ts         per-server file logger
├── ssh/
│   ├── executor.ts   execRemoteStreaming, execRemoteSimple, scpUpload
│   ├── host-keys.ts  TOFU host key enforcement
│   ├── connection.ts connection health check
│   └── index.ts      barrel export
├── deploy/
│   ├── steps.ts      single-server deploy steps (env injection, script execution)
│   └── index.ts      multi-server orchestration
└── ui/
    ├── types.ts      OrchestratorUI interface
    ├── tui.ts        blessed TUI implementation
    └── plain.ts      plain stdout implementation
tests/
├── fixtures/sshd/        Alpine+OpenSSH Docker image for integration tests
├── helpers/docker.ts     Docker container lifecycle management
├── config.test.ts        config validation unit tests
├── ssh.test.ts           SSH executor integration tests (requires Docker)
├── deploy.test.ts        deployment integration tests (requires Docker)
└── lite-version.test.ts  lite-version.sh integration tests (requires Docker)
```

## Testing

```bash
# All tests (unit + Docker integration)
pnpm test

# Unit tests only (no Docker required)
pnpm test tests/config.test.ts
```

**Integration tests** spin up Alpine+OpenSSH Docker containers automatically, run the deployment against them, and clean up on completion. They are skipped gracefully when Docker is unavailable.

## Security

* **Host key verification** uses SSH's `StrictHostKeyChecking=yes` - connections to unknown hosts are rejected
* **TOFU** (Trust On First Use) - the first time a server is seen, the user must explicitly approve all offered key types; they are then stored as an array in `config.json`
* **Key mismatch = hard abort** - if any stored key type doesn't match `~/.ssh/known_hosts`, s.Orchestrator exits with an error listing all conflicting entries and the `ssh-keygen -R` commands needed to resolve them; any newly confirmed keys are saved before aborting so they don't need to be re-confirmed after the conflict is resolved
* Scripts run with **the permissions of the configured SSH user** - use a least-privilege deploy user where possible

## License
This project is licensed under the **MIT License**.

### About
MIT

A short and simple permissive license with conditions only requiring preservation of copyright and license notices. Licensed works, modifications, and larger works may be distributed under different terms and without source code.

### What you can do

| Permissions                                                                                                                       | Conditions                                                                                                                                                   | Limitations                                                                                                            |
|-----------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| <details><summary>🟢 Commercial use</summary>The licensed material and derivatives may be used for commercial purposes.</details> | <details><summary>🔵 License and copyright notice</summary>A copy of the license and copyright notice must be included with the licensed material.</details> | <details><summary>🔴 Liability</summary>This license includes a limitation of liability.</details>                     |
| <details><summary>🟢 Distribution</summary>The licensed material may be distributed.</details>                                    |                                                                                                                                                              | <details><summary>🔴 Warranty</summary>This license explicitly states that it does NOT provide any warranty.</details> |
| <details><summary>🟢 Modification</summary>The licensed material may be modified.</details>                                       |                                                                                                                                                              |                                                                                                                        |
| <details><summary>🟢 Private use</summary>The licensed material may be used and modified in private.</details>                    |                                                                                                                                                              |                                                                                                                        |

*Information provided by https://choosealicense.com/licenses/mit/*

**This information is provided for general understanding and is not legal advice.**
