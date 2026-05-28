#!/usr/bin/env node
import { existsSync, readdirSync } from 'fs';
import { parseArgs } from './cli';
import { exportSchema, loadConfig } from './config';
import { runDeployment } from './deploy';
import { FileLogger } from './logger';
import { PlainUI } from './ui/plain';
import { TuiUI } from './ui/tui';
import type { OrchestratorUI } from './ui/types';

async function main(): Promise<void> {
  const options = parseArgs();

  // --schema: export JSON schema and exit
  if (options.schema !== false) {
    exportSchema(options.schema === true ? undefined : String(options.schema));
    process.exit(0);
  }

  // Load and validate config
  const fullConfig = loadConfig(options.configPath);
  let config = fullConfig;

  if (options.servers && options.servers.length > 0) {
    const unknown = options.servers.filter((s) => !(s in fullConfig));
    if (unknown.length > 0) {
      process.stderr.write(`Unknown server(s): ${unknown.join(', ')}\n`);
      process.exit(1);
    }
    config = Object.fromEntries(options.servers.map((s) => [s, fullConfig[s]]));
  }

  const serverNames = Object.keys(config);

  if (serverNames.length === 0) {
    process.stderr.write('Config contains no servers.\n');
    process.exit(1);
  }

  // Discover scripts
  const scripts: string[] = existsSync(options.scriptsDir)
    ? readdirSync(options.scriptsDir)
        .filter((f) => f.endsWith('.sh'))
        .sort()
    : [];

  // Prepare file logger
  const fileLogger = new FileLogger(options.logDir);
  for (const name of serverNames) fileLogger.register(name);

  // Build UI
  const ui: OrchestratorUI = options.ugly ? new PlainUI() : new TuiUI();
  ui.init(serverNames);

  process.on('uncaughtException', (err) => {
    ui.destroy();
    process.stderr.write(`\nUncaught error: ${err.message}\n`);
    process.exit(1);
  });

  try {
    await runDeployment(config, options, ui, fileLogger, scripts);
  } catch (err) {
    ui.destroy();
    process.stderr.write(`\nFatal: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\n${String(err)}\n`);
  process.exit(1);
});
