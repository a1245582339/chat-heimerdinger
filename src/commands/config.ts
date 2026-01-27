import * as p from '@clack/prompts';
import { Command } from 'commander';
import { consola } from 'consola';
import { ConfigManager } from '../services/config-manager';

export const configCommand = new Command('config')
  .description('View or modify configuration')
  .option('-l, --list', 'List all configuration')
  .option('-g, --get <key>', 'Get a specific configuration value')
  .option('-s, --set <key=value>', 'Set a configuration value')
  .option('-r, --reset', 'Reset configuration to defaults')
  .action(async (options) => {
    const configManager = new ConfigManager();

    // List all config
    if (options.list || Object.keys(options).length === 0) {
      if (!configManager.exists()) {
        consola.warn('No configuration found. Run `hmdg init` first.');
        return;
      }

      const config = configManager.getAll();
      consola.info('Current configuration:\n');

      // Pretty print config (hide sensitive values)
      const safeConfig = JSON.parse(JSON.stringify(config));
      if (safeConfig.adapters?.slack) {
        if (safeConfig.adapters.slack.botToken) {
          safeConfig.adapters.slack.botToken = '***hidden***';
        }
        if (safeConfig.adapters.slack.appToken) {
          safeConfig.adapters.slack.appToken = '***hidden***';
        }
        if (safeConfig.adapters.slack.signingSecret) {
          safeConfig.adapters.slack.signingSecret = '***hidden***';
        }
      }

      console.log(JSON.stringify(safeConfig, null, 2));
      return;
    }

    // Get specific value
    if (options.get) {
      const value = configManager.get(options.get);
      if (value === undefined) {
        consola.warn(`Configuration key "${options.get}" not found.`);
        return;
      }

      // Hide sensitive values
      const sensitiveKeys = ['botToken', 'appToken', 'signingSecret'];
      if (sensitiveKeys.some((key) => options.get.includes(key))) {
        consola.info(`${options.get}: ***hidden***`);
      } else {
        consola.info(`${options.get}: ${JSON.stringify(value)}`);
      }
      return;
    }

    // Set value
    if (options.set) {
      const [key, ...valueParts] = options.set.split('=');
      const valueStr = valueParts.join('=');

      if (!key || valueStr === undefined) {
        consola.error('Invalid format. Use: --set key=value');
        return;
      }

      // Try to parse as JSON, otherwise use as string
      let value: unknown;
      try {
        value = JSON.parse(valueStr);
      } catch {
        value = valueStr;
      }

      configManager.set(key, value);
      consola.success(`Set ${key} = ${JSON.stringify(value)}`);
      return;
    }

    // Reset config
    if (options.reset) {
      const confirm = await p.confirm({
        message: 'Are you sure you want to reset all configuration to defaults?',
        initialValue: false,
      });

      if (p.isCancel(confirm) || !confirm) {
        consola.info('Reset cancelled.');
        return;
      }

      configManager.reset();
      consola.success('Configuration reset to defaults.');
      return;
    }
  });
