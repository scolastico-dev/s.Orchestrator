import type { ChildProcess } from 'child_process';

export interface CliOptions {
  configPath: string;
  skipConfirm: boolean;
  dryRun: boolean;
  schema: boolean | string;
  ugly: boolean;
  logDir: string;
  assetsDir: string;
  scriptsDir: string;
  remotePath: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ActiveChildRef {
  child: ChildProcess | null;
}
