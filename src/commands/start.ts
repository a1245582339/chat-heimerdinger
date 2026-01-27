import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { consola } from 'consola';
import { ConfigManager } from '../services/config-manager';
import { ServiceManager } from '../services/service-manager';

export const startCommand = new Command('start')
  .description('Start the heimerdinger service')
  .option('-f, --foreground', 'Run in foreground (default: daemon mode)')
  .option('-p, --port <port>', 'Override server port')
  .option('-d, --project-dir <dir>', 'Set project directory to watch')
  .action(async (options) => {
    const configManager = new ConfigManager();

    // Check if configured
    if (!configManager.exists()) {
      consola.error('No configuration found. Run `hmdg init` first.');
      process.exit(1);
    }

    // Check if adapter is configured
    const activeAdapter = configManager.get('activeAdapter');
    if (!activeAdapter) {
      consola.error('No IM adapter configured. Run `hmdg init` first.');
      process.exit(1);
    }

    const adapterConfig = configManager.get(`adapters.${activeAdapter}`);
    if (!adapterConfig?.enabled) {
      consola.error(`Adapter "${activeAdapter}" is not enabled or configured.`);
      process.exit(1);
    }

    // Override port if specified
    if (options.port) {
      const port = Number.parseInt(options.port, 10);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        consola.error('Invalid port number.');
        process.exit(1);
      }
      configManager.set('server.port', port);
    }

    // Override project directory if specified
    if (options.projectDir) {
      configManager.set('projectDir', options.projectDir);
    }

    const serviceManager = new ServiceManager(configManager);

    // Check if already running
    if (await serviceManager.isRunning()) {
      const status = await serviceManager.getStatus();
      consola.warn(`Service is already running (PID: ${status.pid}).`);
      consola.info('Use `hmdg stop` to stop the service first.');
      return;
    }

    const port = configManager.get('server.port');
    const daemon = !options.foreground;

    if (daemon) {
      consola.info('Starting heimerdinger in daemon mode...');
      try {
        await serviceManager.startDaemon();
        consola.success(`Service started on port ${port}`);
        consola.info('Use `hmdg status` to check service status.');
        consola.info('Use `hmdg logs` to view logs.');
      } catch (error) {
        consola.error('Failed to start service:', error);
        process.exit(1);
      }
    } else {
      consola.info(`Starting heimerdinger on port ${port}...`);
      consola.info('Press Ctrl+C to stop.\n');

      // Use tsx/Node.js for Slack Socket Mode compatibility (Bun WebSocket issues)
      const cliPath = new URL(import.meta.url).pathname;
      const projectRoot = dirname(dirname(cliPath));
      const serverScript = join(projectRoot, 'src', 'services', 'daemon-entry.ts');
      const tsxPath = join(projectRoot, 'node_modules', '.bin', 'tsx');

      // Run tsx synchronously in foreground (inherits stdio)
      const result = spawnSync(tsxPath, [serverScript], {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: process.env,
      });

      process.exit(result.status || 0);
    }
  });
