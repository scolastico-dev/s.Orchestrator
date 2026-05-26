import * as readline from 'readline';
import type { ChildProcess } from 'child_process';
import type { ConfirmFn, OrchestratorUI, ServerLogger, StatusUpdate } from './types';

function stripTags(text: string): string {
  return text.replace(/\{[^}]+\}/g, '');
}

function colorize(text: string): string {
  return text
    .replace(/\{green-fg\}(.*?)\{\/green-fg\}/gs, '\x1b[32m$1\x1b[0m')
    .replace(/\{red-fg\}(.*?)\{\/red-fg\}/gs, '\x1b[31m$1\x1b[0m')
    .replace(/\{yellow-fg\}(.*?)\{\/yellow-fg\}/gs, '\x1b[33m$1\x1b[0m')
    .replace(/\{cyan-fg\}(.*?)\{\/cyan-fg\}/gs, '\x1b[36m$1\x1b[0m')
    .replace(/\{bold\}(.*?)\{\/bold\}/gs, '\x1b[1m$1\x1b[0m')
    .replace(/\{[^}]+\}/g, '');
}

class PlainServerLogger implements ServerLogger {
  private readonly prefix: string;

  constructor(serverName: string) {
    this.prefix = `[${serverName}]`;
  }

  log(message: string): void {
    const lines = colorize(message).split('\n');
    for (const line of lines) {
      if (line.trim()) process.stdout.write(`${this.prefix} ${line}\n`);
    }
  }

  write(data: string): void {
    const cleaned = colorize(data).replace(/\b/g, '').replace(/\r/g, '');
    process.stdout.write(cleaned.split('\n').map((l) => (l ? `${this.prefix} ${l}` : '')).join('\n'));
  }

  // In plain mode there's no TUI to forward to — the child runs in the background
  setActiveChild(_child: ChildProcess | null): void {
    // no-op
  }
}

export class PlainUI implements OrchestratorUI {
  private readonly loggers = new Map<string, PlainServerLogger>();

  init(serverNames: string[]): void {
    for (const name of serverNames) {
      this.loggers.set(name, new PlainServerLogger(name));
    }
  }

  getLogger(serverName: string): ServerLogger {
    const logger = this.loggers.get(serverName);
    if (!logger) throw new Error(`No logger for server "${serverName}"`);
    return logger;
  }

  confirm: ConfirmFn = (message, title) => {
    return new Promise((resolve) => {
      const cleaned = stripTags(message);
      process.stdout.write(`\n--- ${title} ---\n${cleaned}\n[Y/n] `);

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.once('line', (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() !== 'n');
      });
    });
  };

  updateStatus(update: StatusUpdate): void {
    const { serverName, scriptsDone, totalScripts, serversDone, totalServers } = update;
    process.stdout.write(
      `[STATUS] ${serverName}: ${scriptsDone}/${totalScripts} scripts | servers: ${serversDone}/${totalServers}\n`
    );
  }

  markServerDone(serverName: string, success: boolean): void {
    const label = success ? '\x1b[32mSUCCESS\x1b[0m' : '\x1b[31mFAILED\x1b[0m';
    process.stdout.write(`[${serverName}] ${label}\n`);
  }

  showFinalStatus(anyFailed: boolean): Promise<void> {
    const label = anyFailed ? '\x1b[31mSOME SERVERS FAILED\x1b[0m' : '\x1b[32mALL SERVERS SUCCEEDED\x1b[0m';
    process.stdout.write(`\n=== ${label} ===\n`);
    return Promise.resolve();
  }

  destroy(): void {
    // nothing to tear down
  }
}
