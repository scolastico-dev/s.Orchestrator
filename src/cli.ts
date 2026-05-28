import { Command } from 'commander';
import type { CliOptions } from './types';

function readVersion(): string {
  try {
    // Parcel inlines require() of JSON at build time; ts-node resolves at runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export function parseArgs(argv: string[] = process.argv): CliOptions {
  const program = new Command();

  program
    .name('s-orchestrator')
    .description(
      'SSH deployment orchestrator — upload assets and execute scripts across servers in parallel'
    )
    .version(readVersion(), '-v, --version', 'print version and exit')
    .option('-c, --config <path>', 'path to config JSON file', 'config.json')
    .option('-y, --skip-confirm', 'skip the confirmation prompt after connection tests', false)
    .option('-n, --dry-run', 'validate and test connections but do not execute any remote commands', false)
    .option(
      '--schema [path]',
      'export the JSON schema for the config file; optionally provide an output path'
    )
    .option('--ugly', 'disable the TUI and print plain log lines to stdout', false)
    .option('--log-dir <path>', 'directory to write per-server log files', 'logs')
    .option('--assets-dir <path>', 'local directory to upload as assets', 'assets')
    .option('--scripts-dir <path>', 'local directory containing .sh scripts to execute', 'scripts')
    .option('--remote-path <path>', 'remote base path for uploaded files', '/tmp/s-orchestrator')
    .option('--exec <command>', 'run a single command on each server instead of the scripts directory (assets and scripts are still uploaded)')
    .option(
      '--servers <names>',
      'comma-separated list of server names to target; all others are skipped'
    )
    .helpOption('-h, --help', 'display this help message')
    .addHelpText(
      'after',
      `
Examples:
  s-orchestrator                          run with defaults (config.json, TUI)
  s-orchestrator -c prod.json -y          skip confirmation using prod.json
  s-orchestrator --dry-run --ugly         dry run with plain output
  s-orchestrator --schema schema.json     export config JSON schema to file
  s-orchestrator --schema                 print config JSON schema to stdout
  s-orchestrator --exec "systemctl restart nginx"   run one command on all servers
  s-orchestrator --servers web,db         deploy only to the "web" and "db" servers
`
    )
    .parse(argv);

  const opts = program.opts<{
    config: string;
    skipConfirm: boolean;
    dryRun: boolean;
    schema: string | boolean | undefined;
    ugly: boolean;
    logDir: string;
    assetsDir: string;
    scriptsDir: string;
    remotePath: string;
    exec: string | undefined;
    servers: string | undefined;
  }>();

  return {
    configPath: opts.config,
    skipConfirm: opts.skipConfirm,
    dryRun: opts.dryRun,
    schema: opts.schema ?? false,
    ugly: opts.ugly,
    logDir: opts.logDir,
    assetsDir: opts.assetsDir,
    scriptsDir: opts.scriptsDir,
    remotePath: opts.remotePath,
    exec: opts.exec,
    servers: opts.servers ? opts.servers.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  };
}
