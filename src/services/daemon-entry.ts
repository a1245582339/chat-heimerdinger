#!/usr/bin/env bun

/**
 * Daemon entry point for Heimerdinger service
 * This file is spawned as a separate process when running in daemon mode
 */

import { consola, createConsola } from 'consola';
import { ConfigManager } from './config-manager';
import { HeimerdingerServer } from './server';

// Configure consola for daemon mode (simple text output for file logging)
if (process.env.HEIMERDINGER_DAEMON === '1') {
  // Use basic reporter that writes plain text
  (consola.options as { fancy?: boolean }).fancy = false;
  consola.options.formatOptions = {
    colors: false,
    date: true,
  };
  // Set level to debug to capture all logs
  consola.level = 4; // debug level
}

async function main() {
  // 启动时立即验证 claude binary
  const { ClaudeCodeService } = await import('./claude-code');
  const claudeCheck = new ClaudeCodeService();
  const available = await claudeCheck.isAvailable();
  console.log(
    `[startup] Claude available: ${available}, node: ${process.version}, CLAUDE_BINARY_PATH: ${process.env.CLAUDE_BINARY_PATH || '(not set)'}, PATH: ${(process.env.PATH || '').slice(0, 100)}...`
  );

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
