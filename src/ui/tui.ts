import * as blessed from 'blessed';
import type { ChildProcess } from 'child_process';
import type { ConfirmFn, OrchestratorUI, ServerLogger, StatusUpdate } from './types';

const MAX_BUFFER = 50_000;

interface PaneState {
  box: blessed.Widgets.BoxElement;
  buffer: string;
  done: boolean;
  success: boolean;
  blinking: boolean;
  blinkState: boolean;
  lastActivity: number;
  activeChild: ChildProcess | null;
}

class TuiServerLogger implements ServerLogger {
  constructor(
    private readonly pane: PaneState,
    private readonly screen: blessed.Widgets.Screen
  ) {}

  write(data: string): void {
    let buf = this.pane.buffer;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\b' || ch === '\x7f') {
        buf = buf.slice(0, -1);
      } else if (ch === '\r') {
        // suppress bare CR
      } else {
        buf += ch;
      }
    }
    if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
    this.pane.buffer = buf;
    this.pane.lastActivity = Date.now();
    this.pane.blinking = false;
    this.pane.blinkState = false;
    this.pane.box.setContent(buf);
    this.pane.box.setScrollPerc(100);
    this.screen.render();
  }

  log(message: string): void {
    this.write(message + '\n');
  }

  setActiveChild(child: ChildProcess | null): void {
    this.pane.activeChild = child;
  }
}

export class TuiUI implements OrchestratorUI {
  private screen!: blessed.Widgets.Screen;
  private topBar!: blessed.Widgets.BoxElement;
  private statusBar!: blessed.Widgets.BoxElement;
  private logContainer!: blessed.Widgets.BoxElement;

  private panes: PaneState[] = [];
  private serverNames: string[] = [];
  private focusIndex = 0;
  private promptActive = false;
  private deploymentDone = false;
  private blinkTimer?: NodeJS.Timeout;

  private lastStatus: StatusUpdate = {
    serverName: '',
    scriptsDone: 0,
    totalScripts: 0,
    totalExecuted: 0,
    totalToExecute: 0,
    serversDone: 0,
    totalServers: 0,
  };

  init(serverNames: string[]): void {
    this.serverNames = serverNames;

    this.screen = blessed.screen({
      smartCSR: true,
      title: 's.Orchestrator',
      fullUnicode: true,
      sendFocus: true,
    });

    this.topBar = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: { bg: 'blue', fg: 'white' },
    });

    this.logContainer = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-2',
    });

    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: { bg: 'magenta', fg: 'white' },
    });

    this.panes = serverNames.map((name, i) => {
      const box = blessed.box({
        parent: this.logContainer,
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        border: { type: 'line' },
        label: ` [${name}] `,
        scrollable: true,
        alwaysScroll: true,
        mouse: true,
        tags: true,
        hidden: i !== 0,
        scrollbar: {
          ch: ' ',
          track: { bg: 'cyan' },
          style: { inverse: true },
        },
        style: { focus: { border: { fg: 'blue' } } },
      });

      return {
        box,
        buffer: '',
        done: false,
        success: false,
        blinking: false,
        blinkState: false,
        lastActivity: Date.now(),
        activeChild: null,
      };
    });

    this.bindKeys();
    this.startBlinkTimer();
    this.render();
  }

  getLogger(serverName: string): ServerLogger {
    const idx = this.serverNames.indexOf(serverName);
    if (idx === -1) throw new Error(`No pane for server "${serverName}"`);
    return new TuiServerLogger(this.panes[idx], this.screen);
  }

  confirm: ConfirmFn = (message, title, color = 'blue') => {
    return new Promise((resolve) => {
      this.promptActive = true;

      const dialog = blessed.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: '60%',
        height: 'shrink',
        padding: 1,
        border: { type: 'line' },
        label: ` {bold}${title}{/bold} `,
        content: `{center}${message}\n\n{yellow-fg}[Y]{/yellow-fg} Yes  /  {yellow-fg}[N]{/yellow-fg} No{/center}`,
        tags: true,
        style: { bg: color, fg: 'white' },
      });
      this.screen.render();

      const handler = (_ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
        if (!key) return;
        if (key.name === 'y') done(true);
        else if (key.name === 'n' || key.name === 'escape') done(false);
      };

      const done = (result: boolean) => {
        this.screen.removeListener('keypress', handler);
        dialog.destroy();
        this.promptActive = false;
        this.render();
        resolve(result);
      };

      this.screen.on('keypress', handler);
    });
  };

  updateStatus(update: StatusUpdate): void {
    this.lastStatus = update;
    this.render();
  }

  markServerDone(serverName: string, success: boolean): void {
    const idx = this.serverNames.indexOf(serverName);
    if (idx === -1) return;
    this.panes[idx].done = true;
    this.panes[idx].success = success;
    this.render();
  }

  showFinalStatus(anyFailed: boolean): Promise<void> {
    this.deploymentDone = true;
    this.stopBlinkTimer();

    return new Promise((resolve) => {
      this.promptActive = true;
      const bg = anyFailed ? 'red' : 'green';
      const headline = anyFailed ? 'SOME SERVERS FAILED' : 'ALL SERVERS SUCCEEDED';
      const hint = anyFailed
        ? '{center}{bold}' + headline + '{/bold}\n\n[ENTER] Dismiss to view logs\n[CTRL+C] Exit{/center}'
        : '{center}{bold}' + headline + '{/bold}\n\n[ENTER] Exit\n[ANY KEY] View logs{/center}';

      const dialog = blessed.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: '50%',
        height: 'shrink',
        padding: 1,
        border: { type: 'line' },
        content: hint,
        tags: true,
        style: { bg, fg: 'white' },
      });
      this.screen.render();

      const handler = (_ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
        if (key?.ctrl && key.name === 'c') return;

        if (!anyFailed) {
          if (key?.name === 'enter') {
            cleanup();
            resolve();
            process.exit(0);
          } else {
            cleanup();
            resolve();
          }
        } else {
          if (key?.name === 'enter') {
            cleanup();
            resolve();
          }
        }
      };

      const cleanup = () => {
        this.screen.removeListener('keypress', handler);
        dialog.destroy();
        this.promptActive = false;
        this.render();
      };

      this.screen.on('keypress', handler);
    });
  }

  destroy(): void {
    this.stopBlinkTimer();
    try {
      this.screen.destroy();
    } catch {
      // may already be destroyed
    }
  }

  private render(): void {
    if (this.promptActive) return;

    const tabs = this.serverNames
      .map((name, i) => {
        if (i === this.focusIndex) {
          this.panes[i].lastActivity = Date.now();
          this.panes[i].blinking = false;
          return `{white-bg}{black-fg} ${name} {/black-fg}{/white-bg}`;
        }
        const pane = this.panes[i];
        if (pane.blinking && pane.blinkState) {
          return `{yellow-bg}{black-fg} ${name} {/black-fg}{/yellow-bg}`;
        }
        const color = pane.done ? (pane.success ? 'green-fg' : 'red-fg') : 'white-fg';
        return ` {${color}}${name}{/${color}} `;
      })
      .join('|');

    this.topBar.setContent(tabs);

    const s = this.lastStatus;
    const pct = s.totalToExecute > 0 ? Math.floor((s.totalExecuted / s.totalToExecute) * 100) : 0;
    const currentPane = this.panes[this.focusIndex];
    const currentScripts = currentPane ? s.scriptsDone : 0;

    this.statusBar.setContent(
      ` Switch: [TAB] | Scroll: [SHIFT]+[↑/↓] [PGUP/PGDN] | Quit: [CTRL+C]` +
        ` | Scripts: ${currentScripts}/${s.totalScripts}` +
        ` | Total: ${s.totalExecuted}/${s.totalToExecute} (${pct}%)` +
        ` | Servers: ${s.serversDone}/${s.totalServers} `
    );

    this.panes.forEach((pane, i) => {
      if (i === this.focusIndex) {
        pane.box.show();
        pane.box.focus();
      } else {
        pane.box.hide();
      }
    });

    this.screen.render();
  }

  private bindKeys(): void {
    this.screen.key(['C-c'], async () => {
      if (this.deploymentDone) process.exit(0);
      const ok = await this.confirm('Abort deployment and kill all processes?', 'ABORT?', 'red');
      if (ok) process.exit(1);
    });

    this.screen.on('keypress', (ch, key) => {
      if (this.promptActive) return;
      if (!key) return;

      if (key.name === 'tab') {
        this.focusIndex = key.shift
          ? (this.focusIndex - 1 + this.panes.length) % this.panes.length
          : (this.focusIndex + 1) % this.panes.length;
        this.render();
        return;
      }

      const activeBox = this.panes[this.focusIndex]?.box;
      if (!activeBox) return;

      if (key.name === 'pageup') {
        activeBox.scroll(-(activeBox.height as number || 10));
        this.screen.render();
        return;
      }
      if (key.name === 'pagedown') {
        activeBox.scroll(activeBox.height as number || 10);
        this.screen.render();
        return;
      }
      if (key.shift && key.name === 'up') {
        activeBox.scroll(-1);
        this.screen.render();
        return;
      }
      if (key.shift && key.name === 'down') {
        activeBox.scroll(1);
        this.screen.render();
        return;
      }

      // Forward remaining input to the active SSH child process
      const activeChild = this.panes[this.focusIndex]?.activeChild;
      if (activeChild?.stdin && !activeChild.stdin.destroyed) {
        if (ch) {
          activeChild.stdin.write(ch);
        } else if (key.sequence) {
          activeChild.stdin.write(key.sequence);
        }
      }
    });
  }

  private startBlinkTimer(): void {
    this.blinkTimer = setInterval(() => {
      let needsRender = false;
      const now = Date.now();

      this.panes.forEach((pane, i) => {
        if (pane.done || i === this.focusIndex) return;
        if (pane.activeChild && now - pane.lastActivity > 5_000) {
          pane.blinking = true;
          pane.blinkState = !pane.blinkState;
          needsRender = true;
        }
      });

      if (needsRender && !this.promptActive) this.render();
    }, 500);
  }

  private stopBlinkTimer(): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = undefined;
    }
  }
}
