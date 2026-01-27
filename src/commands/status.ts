import { Command } from 'commander';
import { consola } from 'consola';
import { ConfigManager } from '../services/config-manager';
import { ServiceManager } from '../services/service-manager';

export const statusCommand = new Command('status')
  .description('Show service status')
  .action(async () => {
    const configManager = new ConfigManager();
    const serviceManager = new ServiceManager(configManager);

    const status = await serviceManager.getStatus();

    if (!status.running) {
      consola.info('Service Status: stopped');
      return;
    }

    consola.info('Service Status: running');
    console.log('');
    console.log(`  PID:          ${status.pid}`);
    console.log(`  Port:         ${status.port}`);
    console.log(`  Adapter:      ${status.adapter}`);
    console.log(`  Project Dir:  ${status.projectDir || '(not set)'}`);

    if (status.uptime) {
      const uptime = formatUptime(status.uptime);
      console.log(`  Uptime:       ${uptime}`);
    }
  });

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
