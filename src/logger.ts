import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export class FileLogger {
  private readonly logDir: string;
  private readonly paths = new Map<string, string>();

  constructor(logDir: string) {
    this.logDir = logDir;
    this.prepare();
  }

  private prepare(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
      return;
    }
    for (const file of readdirSync(this.logDir)) {
      try {
        unlinkSync(join(this.logDir, file));
      } catch {
        // best-effort cleanup
      }
    }
  }

  register(serverName: string): string {
    const filePath = join(this.logDir, `${serverName}.log`);
    writeFileSync(filePath, '');
    this.paths.set(serverName, filePath);
    return filePath;
  }

  write(serverName: string, data: string): void {
    const filePath = this.paths.get(serverName);
    if (filePath) appendFileSync(filePath, data);
  }

  writeLine(serverName: string, line: string): void {
    this.write(serverName, line + '\n');
  }

  getPath(serverName: string): string | undefined {
    return this.paths.get(serverName);
  }

  getLogDir(): string {
    return this.logDir;
  }
}
