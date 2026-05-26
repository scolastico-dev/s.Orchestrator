import type { ChildProcess } from 'child_process';

export type ConfirmFn = (message: string, title: string, color?: string) => Promise<boolean>;

export interface ServerLogger {
  /** Append a tagged line (blessed tag syntax supported) */
  log(message: string): void;
  /** Write raw stream data — handles backspace/CR characters */
  write(data: string): void;
  /** Register the currently-running SSH child so the TUI can forward keystrokes */
  setActiveChild(child: ChildProcess | null): void;
}

export interface StatusUpdate {
  serverName: string;
  scriptsDone: number;
  totalScripts: number;
  totalExecuted: number;
  totalToExecute: number;
  serversDone: number;
  totalServers: number;
}

export interface OrchestratorUI {
  /** Create per-server panes (must be called before any other method) */
  init(serverNames: string[]): void;
  /** Get the logger for a specific server */
  getLogger(serverName: string): ServerLogger;
  /** Show a blocking yes/no confirmation dialog */
  confirm: ConfirmFn;
  /** Update the status bar counters */
  updateStatus(update: StatusUpdate): void;
  /** Mark a server's tab as done (green = success, red = failed) */
  markServerDone(serverName: string, success: boolean): void;
  /** Show the final summary and wait for the user to dismiss */
  showFinalStatus(anyFailed: boolean): Promise<void>;
  /** Tear down the UI (destroy blessed screen / flush output) */
  destroy(): void;
}
