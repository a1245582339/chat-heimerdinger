import * as p from '@clack/prompts';
import { Command } from 'commander';
import { consola } from 'consola';
import { SLACK_ADAPTER_NAME } from '../constants';
import { ConfigManager } from '../services/config-manager';

export const initCommand = new Command('init')
  .description('Initialize heimerdinger configuration')
  .action(async () => {
    consola.info('Initializing heimerdinger...\n');

    p.intro('Welcome to Heimerdinger Setup');

    const configManager = new ConfigManager();

    // Check if config already exists
    if (configManager.exists()) {
      const overwrite = await p.confirm({
        message: 'Configuration already exists. Do you want to overwrite it?',
        initialValue: false,
      });

      if (p.isCancel(overwrite) || !overwrite) {
        p.cancel('Setup cancelled.');
        process.exit(0);
      }
    }

    // Select IM adapter
    const adapter = await p.select({
      message: 'Select IM tool to connect:',
      options: [
        { value: 'slack', label: 'Slack', hint: 'recommended' },
        { value: 'lark', label: 'Lark (Feishu)', hint: 'coming soon' },
        { value: 'discord', label: 'Discord', hint: 'coming soon' },
      ],
    });

    if (p.isCancel(adapter)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    if (adapter !== 'slack') {
      p.cancel(`${adapter} adapter is not yet supported. Please choose Slack.`);
      process.exit(0);
    }

    // Slack configuration
    p.note(
      '1. Visit https://api.slack.com/apps and create a new app\n' +
        '2. Enable "Socket Mode" in Settings > Socket Mode\n' +
        '3. Add OAuth Scopes in OAuth & Permissions:\n' +
        '   - app_mentions:read, chat:write, im:history, im:read, im:write, files:read\n' +
        '4. Install the app to your workspace',
      'Slack App Setup'
    );

    const slackConfig = await p.group(
      {
        botToken: () =>
          p.text({
            message: 'Bot Token (OAuth & Permissions > Bot User OAuth Token):',
            placeholder: 'xoxb-xxxxx-xxxxx-xxxxx',
            initialValue: '',
            validate: (value) => {
              if (!value) return 'Token is required';
              if (!value.startsWith('xoxb-')) return 'Token should start with xoxb-';
            },
          }),
        appToken: () =>
          p.text({
            message: 'App Token (Settings > Basic Information > App-Level Tokens):',
            placeholder: 'xapp-xxxxx-xxxxx-xxxxx',
            initialValue: '',
            validate: (value) => {
              if (!value) return 'Token is required';
              if (!value.startsWith('xapp-')) return 'Token should start with xapp-';
            },
          }),
        signingSecret: () =>
          p.text({
            message: 'Signing Secret (Settings > Basic Information > App Credentials):',
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
            initialValue: '',
            validate: (value) => {
              if (!value) return 'Signing secret is required';
            },
          }),
      },
      {
        onCancel: () => {
          p.cancel('Setup cancelled.');
          process.exit(0);
        },
      }
    );

    // Server configuration
    const serverConfig = await p.group(
      {
        port: () =>
          p.text({
            message: 'Server port:',
            placeholder: '3150',
            initialValue: '3150',
            validate: (value) => {
              const port = Number.parseInt(value, 10);
              if (Number.isNaN(port) || port < 1 || port > 65535) {
                return 'Please enter a valid port number (1-65535)';
              }
            },
          }),
      },
      {
        onCancel: () => {
          p.cancel('Setup cancelled.');
          process.exit(0);
        },
      }
    );

    // Save configuration
    const s = p.spinner();
    s.start('Saving configuration...');

    try {
      configManager.set('activeAdapter', SLACK_ADAPTER_NAME);
      configManager.set('adapters.slack', {
        enabled: true,
        botToken: slackConfig.botToken,
        appToken: slackConfig.appToken,
        signingSecret: slackConfig.signingSecret,
        socketMode: true,
      });
      configManager.set('server.port', Number.parseInt(serverConfig.port, 10));

      s.stop('Configuration saved!');

      p.outro(
        'Setup complete! Run `hmdg start` to start the service.\n' +
          'Use `hmdg config` to view or modify settings.'
      );
    } catch (error) {
      s.stop('Failed to save configuration');
      consola.error(error);
      process.exit(1);
    }
  });
