import { existsSync } from 'fs';
import { basename } from 'path';
import type { ServerConfig } from '../config';
import type { FileLogger } from '../logger';
import type { ServerLogger } from '../ui/types';
import { execRemoteSimple, execRemoteStreaming, scpUpload, RemoteExitError } from '../ssh/executor';
import type { SshTarget } from '../ssh/executor';
import type { ChildProcess } from 'child_process';

export interface DeployServerOptions {
  serverName: string;
  config: ServerConfig;
  scripts: string[];
  exec?: string;
  assetsDir: string;
  scriptsDir: string;
  remotePath: string;
  logger: ServerLogger;
  fileLogger: FileLogger;
  onScriptDone: () => void;
}

function buildTarget(config: ServerConfig): SshTarget {
  return {
    ip: config.ip,
    port: config.port ?? 22,
    user: config.user ?? 'root',
    keyFile: config.keyFile,
    knownHostsFile: config.knownHostsFile,
  };
}

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

async function withRetry<T>(
  fn: () => Promise<T>,
  onRetry: (attempt: number, err: Error) => void
): Promise<T> {
  let lastErr!: Error;
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    if (i > 0) {
      onRetry(i, lastErr);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
    try {
      return await fn();
    } catch (err) {
      const e = err as Error;
      lastErr = e;
      // Only retry on SSH connection failures (exit code 255); other codes are
      // script/command errors that should not be re-executed automatically.
      if (!(err instanceof RemoteExitError) || err.exitCode !== 255) throw e;
    }
  }
  throw lastErr;
}

function makeStreamCb(serverName: string, logger: ServerLogger, fileLogger: FileLogger) {
  return {
    onStdout: (data: string) => {
      logger.write(data);
      fileLogger.write(serverName, data);
    },
    onStderr: (data: string) => {
      logger.write(`{yellow-fg}${data}{/yellow-fg}`);
      fileLogger.write(serverName, data);
    },
  };
}

export async function deployServer(opts: DeployServerOptions): Promise<void> {
  const { serverName, config, scripts, exec, assetsDir, scriptsDir, remotePath, logger, fileLogger, onScriptDone } = opts;
  const target = buildTarget(config);
  const cb = makeStreamCb(serverName, logger, fileLogger);

  const retryLog = (label: string) => (attempt: number, err: Error) =>
    logger.log(`{yellow-fg}${label}: connection lost (${err.message}), retrying (${attempt}/${RETRY_ATTEMPTS - 1})...{/yellow-fg}`);

  logger.log('{cyan-fg}Creating remote base directory...{/cyan-fg}');
  await withRetry(
    () => execRemoteSimple(target, `mkdir -p ${remotePath}`, cb),
    retryLog('mkdir')
  );

  if (existsSync(assetsDir)) {
    logger.log('{cyan-fg}Uploading assets...{/cyan-fg}');
    await withRetry(
      () => scpUpload(target, assetsDir, remotePath + '/', cb),
      retryLog('Asset upload')
    );
  }

  if (existsSync(scriptsDir) && (scripts.length > 0 || exec)) {
    logger.log('{cyan-fg}Uploading scripts...{/cyan-fg}');
    await withRetry(
      () => scpUpload(target, scriptsDir, remotePath + '/', cb),
      retryLog('Script upload')
    );
  }

  const importedFromLocal: Record<string, string> = {};
  for (const name of config.importedEnv ?? []) {
    const val = process.env[name];
    if (val !== undefined) importedFromLocal[name] = val;
  }

  const injectedEnv: Record<string, string> = {
    SERVER_NAME: serverName,
    SERVER_IP: config.ip,
    SERVER_USER: config.user ?? 'root',
    SERVER_SSH_PORT: String(config.port ?? 22),
    ASSET_DIR: `${remotePath}/${basename(assetsDir)}`,
    SCRIPT_DIR: `${remotePath}/${basename(scriptsDir)}`,
    ...importedFromLocal,
    ...config.env,
  };

  const envString = Object.entries(injectedEnv)
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(' ');

  if (exec) {
    logger.log(`{cyan-fg}Running: ${exec}{/cyan-fg}`);
    // Use export so vars are in the shell environment before the exec command
    // runs — the prefix approach fails because the shell expands $VAR before
    // the prefix assignment takes effect.
    const envExportString = Object.entries(injectedEnv)
      .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
      .join('; ');
    const cmd = `cd ${remotePath} && ${envExportString}; ${exec}`;
    await withRetry(
      () => execRemoteStreaming(target, cmd, {
        ...cb,
        onChild: (child: ChildProcess) => logger.setActiveChild(child),
        onChildExit: () => logger.setActiveChild(null),
      }),
      retryLog(`exec: ${exec}`)
    );
    onScriptDone();
  } else {
    for (const script of scripts) {
      logger.log(`{cyan-fg}Running: ${script}{/cyan-fg}`);

      const scriptSubdir = basename(scriptsDir);
      const cmd = [
        `cd ${remotePath}`,
        `chmod +x ./${scriptSubdir}/${script}`,
        `${envString} ./${scriptSubdir}/${script}`,
      ].join(' && ');

      await withRetry(
        () => execRemoteStreaming(target, cmd, {
          ...cb,
          onChild: (child: ChildProcess) => logger.setActiveChild(child),
          onChildExit: () => logger.setActiveChild(null),
        }),
        retryLog(`script: ${script}`)
      );

      onScriptDone();
    }
  }

  logger.log('{cyan-fg}Cleaning up remote directory...{/cyan-fg}');
  await execRemoteSimple(target, `rm -rf ${remotePath}`, cb);

  logger.log('{green-fg}COMPLETED SUCCESSFULLY{/green-fg}');
}
