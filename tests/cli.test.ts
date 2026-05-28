import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli';

describe('parseArgs — --exec', () => {
  it('is undefined when not provided', () => {
    const opts = parseArgs(['node', 'index.js']);
    expect(opts.exec).toBeUndefined();
  });

  it('captures the command string', () => {
    const opts = parseArgs(['node', 'index.js', '--exec', 'systemctl restart nginx']);
    expect(opts.exec).toBe('systemctl restart nginx');
  });

  it('captures a command with flags', () => {
    const opts = parseArgs(['node', 'index.js', '--exec', 'docker pull myapp:latest && docker compose up -d']);
    expect(opts.exec).toBe('docker pull myapp:latest && docker compose up -d');
  });
});

describe('parseArgs — --servers', () => {
  it('is undefined when not provided', () => {
    const opts = parseArgs(['node', 'index.js']);
    expect(opts.servers).toBeUndefined();
  });

  it('parses a single server name', () => {
    const opts = parseArgs(['node', 'index.js', '--servers', 'web']);
    expect(opts.servers).toEqual(['web']);
  });

  it('splits a comma-separated list', () => {
    const opts = parseArgs(['node', 'index.js', '--servers', 'web,db,cache']);
    expect(opts.servers).toEqual(['web', 'db', 'cache']);
  });

  it('trims whitespace around names', () => {
    const opts = parseArgs(['node', 'index.js', '--servers', 'web, db , cache']);
    expect(opts.servers).toEqual(['web', 'db', 'cache']);
  });

  it('filters out empty segments', () => {
    const opts = parseArgs(['node', 'index.js', '--servers', 'web,,db']);
    expect(opts.servers).toEqual(['web', 'db']);
  });
});

describe('parseArgs — --exec and --servers combined', () => {
  it('both options are captured together', () => {
    const opts = parseArgs([
      'node', 'index.js',
      '--exec', 'uptime',
      '--servers', 'web,db',
    ]);
    expect(opts.exec).toBe('uptime');
    expect(opts.servers).toEqual(['web', 'db']);
  });
});
