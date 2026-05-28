import { existsSync } from 'fs';
import { basename } from 'path';
import type { ServerConfig } from '../config';
import type { FileLogger } from '../logger';
import type { ServerLogger } from '../ui/types';
import { execRemoteSimple, execRemoteStreaming, scpUpload } from '../ssh/executor';
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

  logger.log('{cyan-fg}Creating remote base directory...{/cyan-fg}');
  await execRemoteSimple(target, `mkdir -p ${remotePath}`, cb);

  if (existsSync(assetsDir)) {
    logger.log('{cyan-fg}Uploading assets...{/cyan-fg}');
    await scpUpload(target, assetsDir, remotePath + '/', cb);
  }

  if (existsSync(scriptsDir) && (scripts.length > 0 || exec)) {
    logger.log('{cyan-fg}Uploading scripts...{/cyan-fg}');
    await scpUpload(target, scriptsDir, remotePath + '/', cb);
  }

  const injectedEnv: Record<string, string> = {
    SERVER_NAME: serverName,
    SERVER_IP: config.ip,
    SERVER_USER: config.user ?? 'root',
    SERVER_SSH_PORT: String(config.port ?? 22),
    ASSET_DIR: `${remotePath}/${basename(assetsDir)}`,
    SCRIPT_DIR: `${remotePath}/${basename(scriptsDir)}`,
    ...config.env,
  };

  const envString = Object.entries(injectedEnv)
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(' ');

  if (exec) {
    logger.log(`{cyan-fg}Running: ${exec}{/cyan-fg}`);
    const cmd = `cd ${remotePath} && ${envString} ${exec}`;
    await execRemoteStreaming(target, cmd, {
      ...cb,
      onChild: (child: ChildProcess) => logger.setActiveChild(child),
      onChildExit: () => logger.setActiveChild(null),
    });
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

      await execRemoteStreaming(target, cmd, {
        ...cb,
        onChild: (child: ChildProcess) => logger.setActiveChild(child),
        onChildExit: () => logger.setActiveChild(null),
      });

      onScriptDone();
    }
  }

  logger.log('{cyan-fg}Cleaning up remote directory...{/cyan-fg}');
  await execRemoteSimple(target, `rm -rf ${remotePath}`, cb);

  logger.log('{green-fg}COMPLETED SUCCESSFULLY{/green-fg}');
}
