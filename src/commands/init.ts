import * as p from '@clack/prompts';
import { Command } from 'commander';
import { consola } from 'consola';
import { FEISHU_ADAPTER_NAME, SLACK_ADAPTER_NAME } from '../constants';
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
        { value: 'slack', label: 'Slack' },
        { value: 'feishu', label: 'Feishu (Lark)' },
        { value: 'discord', label: 'Discord', hint: 'coming soon' },
      ],
    });

    if (p.isCancel(adapter)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    if (adapter === 'discord') {
      p.cancel('Discord adapter is not yet supported. Please choose Slack or Feishu.');
      process.exit(0);
    }

    let adapterConfig: Record<string, unknown> = {};
    let activeAdapterName = '';

    if (adapter === 'slack') {
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

      activeAdapterName = SLACK_ADAPTER_NAME;
      adapterConfig = {
        enabled: true,
        botToken: slackConfig.botToken,
        appToken: slackConfig.appToken,
        signingSecret: slackConfig.signingSecret,
        socketMode: true,
      };
    } else if (adapter === 'feishu') {
      // Feishu configuration
      p.note(
        '1. Visit https://open.feishu.cn/app and create a new app\n' +
          '2. In "Credentials & Basic Info", get App ID and App Secret\n' +
          '3. In "Event Subscriptions", add "im.message.receive_v1" event\n' +
          '4. In "Permissions & Scopes", add:\n' +
          '   - im:message, im:message:send_as_bot, im:resource, im:chat:readonly\n' +
          '5. Enable the bot capability and publish the app',
        'Feishu App Setup'
      );

      const feishuConfig = await p.group(
        {
          appId: () =>
            p.text({
              message: 'App ID (Credentials & Basic Info > App ID):',
              placeholder: 'cli_xxxxxxxxxx',
              initialValue: '',
              validate: (value) => {
                if (!value) return 'App ID is required';
              },
            }),
          appSecret: () =>
            p.text({
              message: 'App Secret (Credentials & Basic Info > App Secret):',
              placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
              initialValue: '',
              validate: (value) => {
                if (!value) return 'App Secret is required';
              },
            }),
          connectionMode: () =>
            p.select({
              message: 'Connection mode:',
              options: [
                {
                  value: 'websocket',
                  label: 'WebSocket (Recommended)',
                  hint: 'No public IP needed',
                },
                { value: 'webhook', label: 'Webhook', hint: 'Requires public URL' },
              ],
              initialValue: 'websocket',
            }),
          domain: () =>
            p.select({
              message: 'Feishu domain:',
              options: [
                { value: 'feishu', label: 'feishu.cn (China)', hint: 'For China users' },
                { value: 'lark', label: 'larksuite.com (International)', hint: 'For global users' },
              ],
              initialValue: 'feishu',
            }),
        },
        {
          onCancel: () => {
            p.cancel('Setup cancelled.');
            process.exit(0);
          },
        }
      );

      // Additional config for webhook mode
      let encryptKey = '';
      let verificationToken = '';
      let webhookPort = 3151;

      if (feishuConfig.connectionMode === 'webhook') {
        const webhookConfig = await p.group(
          {
            encryptKey: () =>
              p.text({
                message: 'Encrypt Key (Event Subscriptions > Encrypt Key):',
                placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
                initialValue: '',
                validate: (value) => {
                  if (!value) return 'Encrypt Key is required for webhook mode';
                },
              }),
            verificationToken: () =>
              p.text({
                message: 'Verification Token (Event Subscriptions > Verification Token):',
                placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
                initialValue: '',
              }),
            webhookPort: () =>
              p.text({
                message: 'Webhook server port:',
                placeholder: '3151',
                initialValue: '3151',
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

        encryptKey = webhookConfig.encryptKey;
        verificationToken = webhookConfig.verificationToken;
        webhookPort = Number.parseInt(webhookConfig.webhookPort, 10);
      }

      activeAdapterName = FEISHU_ADAPTER_NAME;
      adapterConfig = {
        enabled: true,
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
        connectionMode: feishuConfig.connectionMode,
        domain: feishuConfig.domain,
        encryptKey,
        verificationToken,
        webhookPort,
      };
    }

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
      configManager.set('activeAdapter', activeAdapterName);
      configManager.set(`adapters.${activeAdapterName}`, adapterConfig);
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
