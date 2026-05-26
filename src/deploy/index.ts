import type { OrchestratorConfig } from '../config';
import { saveConfig } from '../config';
import type { FileLogger } from '../logger';
import { enforceHostKeys } from '../ssh/host-keys';
import { testConnection } from '../ssh/connection';
import type { SshTarget } from '../ssh/executor';
import type { CliOptions } from '../types';
import type { OrchestratorUI } from '../ui/types';
import { deployServer } from './steps';

export async function runDeployment(
  config: OrchestratorConfig,
  options: CliOptions,
  ui: OrchestratorUI,
  fileLogger: FileLogger,
  scripts: string[]
): Promise<void> {
  const servers = Object.entries(config);
  const totalExecutions = servers.length * scripts.length;

  // --- Host key enforcement ---
  const { configChanged, mismatches } = await enforceHostKeys(config, ui.confirm, options.dryRun);

  // Save confirmed keys before potentially throwing about mismatches, so the
  // user doesn't have to re-confirm them on the next run.
  if (configChanged && !options.dryRun) {
    saveConfig(options.configPath, config);
  }

  if (mismatches.length > 0) {
    throw new Error(mismatches.join('\n\n'));
  }

  // --- Connection tests ---
  const connectionOk = new Map<string, boolean>();

  await Promise.all(
    servers.map(async ([name, data]) => {
      const logger = ui.getLogger(name);
      logger.log('{yellow-fg}Checking connection...{/yellow-fg}');

      const target: SshTarget = {
        ip: data.ip,
        port: data.port ?? 22,
        user: data.user ?? 'root',
        keyFile: data.keyFile,
        knownHostsFile: data.knownHostsFile,
      };

      const ok = await testConnection(target);
      connectionOk.set(name, ok);

      if (ok) {
        logger.log('{green-fg}Connection OK{/green-fg}');
      } else {
        logger.log('{red-fg}Connection FAILED{/red-fg}');
      }
    })
  );

  // --- Start confirmation ---
  const anyConnectionFailed = servers.some(([name]) => !connectionOk.get(name));
  if (anyConnectionFailed) throw new Error('One or more connection tests failed. Aborting.');

  if (!options.skipConfirm) {
    const ok = await ui.confirm('All connections tested. Start deployment?', 'START DEPLOYMENT?', 'blue');
    if (!ok) throw new Error('Deployment aborted by user.');
  }

  // --- Deploy in parallel ---
  let totalExecuted = 0;
  let serversDone = 0;
  const deployFailed = new Set<string>();

  await Promise.all(
    servers.map(async ([name, data]) => {
      const logger = ui.getLogger(name);

      if (!connectionOk.get(name)) {
        totalExecuted += scripts.length;
        serversDone++;
        ui.markServerDone(name, false);
        ui.updateStatus({
          serverName: name,
          scriptsDone: 0,
          totalScripts: scripts.length,
          totalExecuted,
          totalToExecute: totalExecutions,
          serversDone,
          totalServers: servers.length,
        });
        return;
      }

      if (options.dryRun) {
        logger.log('{yellow-fg}[DRY RUN] Would deploy to this server{/yellow-fg}');
        totalExecuted += scripts.length;
        serversDone++;
        ui.markServerDone(name, true);
        ui.updateStatus({
          serverName: name,
          scriptsDone: scripts.length,
          totalScripts: scripts.length,
          totalExecuted,
          totalToExecute: totalExecutions,
          serversDone,
          totalServers: servers.length,
        });
        return;
      }

      let scriptsDone = 0;

      try {
        await deployServer({
          serverName: name,
          config: data,
          scripts,
          assetsDir: options.assetsDir,
          scriptsDir: options.scriptsDir,
          remotePath: options.remotePath,
          logger,
          fileLogger,
          onScriptDone: () => {
            scriptsDone++;
            totalExecuted++;
            ui.updateStatus({
              serverName: name,
              scriptsDone,
              totalScripts: scripts.length,
              totalExecuted,
              totalToExecute: totalExecutions,
              serversDone,
              totalServers: servers.length,
            });
          },
        });

        serversDone++;
        ui.markServerDone(name, true);
      } catch (err) {
        logger.log(`{red-fg}ERROR: ${(err as Error).message}{/red-fg}`);
        totalExecuted += scripts.length - scriptsDone;
        serversDone++;
        deployFailed.add(name);
        ui.markServerDone(name, false);
      }

      ui.updateStatus({
        serverName: name,
        scriptsDone,
        totalScripts: scripts.length,
        totalExecuted,
        totalToExecute: totalExecutions,
        serversDone,
        totalServers: servers.length,
      });
    })
  );

  // --- Final status ---
  const anyFailed = servers.some(([name]) => !connectionOk.get(name) || deployFailed.has(name));
  await ui.showFinalStatus(anyFailed);
}
