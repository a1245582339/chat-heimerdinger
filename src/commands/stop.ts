import { Command } from 'commander';
import { consola } from 'consola';
import { ConfigManager } from '../services/config-manager';
import { ServiceManager } from '../services/service-manager';

export const stopCommand = new Command('stop')
  .description('Stop the heimerdinger service')
  .option('-f, --force', 'Force stop (SIGKILL)')
  .action(async (options) => {
    const configManager = new ConfigManager();
    const serviceManager = new ServiceManager(configManager);

    // Check if running
    if (!(await serviceManager.isRunning())) {
      consola.warn('Service is not running.');
      return;
    }

    const status = await serviceManager.getStatus();
    consola.info(`Stopping service (PID: ${status.pid})...`);

    try {
      if (options.force) {
        await serviceManager.forceStop();
        consola.success('Service forcefully stopped.');
      } else {
        await serviceManager.stop();
        consola.success('Service stopped gracefully.');
      }
    } catch (error) {
      consola.error('Failed to stop service:', error);
      consola.info('Try `hmdg stop --force` to force stop.');
      process.exit(1);
    }
  });
