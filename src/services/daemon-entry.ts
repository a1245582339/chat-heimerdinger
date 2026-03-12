#!/usr/bin/env bun

/**
 * Daemon entry point for Heimerdinger service
 * This file is spawned as a separate process when running in daemon mode
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { consola, createConsola } from 'consola';
import { ConfigManager } from './config-manager';
import { HeimerdingerServer } from './server';

// Simple timestamp wrapper for console.log/error (daemon logging)
{
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => origLog(new Date().toISOString(), ...a);
  console.error = (...a: unknown[]) => origErr(new Date().toISOString(), ...a);
}

// Configure consola for daemon mode (simple text output for file logging)
if (process.env.HEIMERDINGER_DAEMON === '1') {
  // Use basic reporter that writes plain text
  (consola.options as { fancy?: boolean }).fancy = false;
  consola.options.formatOptions = {
    colors: false,
    date: false,
  };
  // Set level to debug to capture all logs
  consola.level = 4; // debug level
}

// Global error handlers — ensure no error is silently lost
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] uncaughtException: ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] unhandledRejection: ${reason}`);
});

async function main() {
  // Log code version so we can verify which build is actually running
  let codeHash = 'unknown';
  try {
    const selfPath = new URL(import.meta.url).pathname;
    const selfContent = readFileSync(selfPath);
    codeHash = createHash('md5').update(selfContent).digest('hex').slice(0, 8);
  } catch {}
  console.log(`[startup] daemon pid=${process.pid} codeHash=${codeHash} node=${process.version}`);

  const { ClaudeCodeService } = await import('./claude-code');
  const claudeCheck = new ClaudeCodeService();
  const available = await claudeCheck.isAvailable();

  const binaryPath = claudeCheck.resolveClaudeBinaryPath();
  let realScript = binaryPath;
  try {
    realScript = realpathSync(binaryPath);
  } catch {}

  const nodeOk = existsSync(process.execPath);
  const scriptOk = existsSync(realScript);
  console.log(
    `[startup] claude=${available ? 'ok' : 'missing'} binary=${binaryPath} script=${realScript} nodeExists=${nodeOk} scriptExists=${scriptOk} CLAUDE_BINARY_PATH=${process.env.CLAUDE_BINARY_PATH || '(not set)'}`
  );

  if (!scriptOk) {
    console.error('[startup] FATAL: claude script not found, daemon will fail on first message');
  }

  const configManager = new ConfigManager();
  const server = new HeimerdingerServer(configManager);

  // Handle shutdown signals
  const shutdown = async () => {
    consola.info('Received shutdown signal');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.start();
  } catch (error) {
    consola.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
