import { App, type GenericMessageEvent } from '@slack/bolt';
import { consola } from 'consola';
import type {
  AudioMessageHandler,
  ConfigField,
  IMAdapter,
  InteractionHandler,
  MessageContext,
  MessageHandler,
  ValidationResult,
} from '../types';

interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
  socketMode: boolean;
}

export class SlackAdapter implements IMAdapter {
  readonly name = 'slack';

  private app: App;
  private config: SlackAdapterConfig;
  private messageHandlers: MessageHandler[] = [];
  private audioMessageHandlers: AudioMessageHandler[] = [];
  private interactionHandlers: InteractionHandler[] = [];

  constructor(config: SlackAdapterConfig) {
    this.config = config;
    this.app = new App({
      token: config.botToken,
      signingSecret: config.signingSecret,
      socketMode: config.socketMode,
      appToken: config.appToken,
    });

    this.setupEventHandlers();
  }


  getConfigTemplate(): ConfigField[] {
    return [
      {
        name: 'botToken',
        type: 'string',
        required: true,
        description: 'Bot User OAuth Token (xoxb-...)',
        secret: true,
      },
      {
        name: 'appToken',
        type: 'string',
        required: true,
        description: 'App-Level Token (xapp-...)',
        secret: true,
      },
      {
        name: 'signingSecret',
        type: 'string',
        required: true,
        description: 'Signing Secret',
        secret: true,
      },
      {
        name: 'socketMode',
        type: 'boolean',
        required: false,
        description: 'Use Socket Mode (recommended)',
        default: true,
      },
    ];
  }

  validateConfig(config: unknown): ValidationResult {
    const errors: string[] = [];
    const c = config as Partial<SlackAdapterConfig>;

    if (!c.botToken || !c.botToken.startsWith('xoxb-')) {
      errors.push('Invalid botToken: must start with xoxb-');
    }

    if (!c.appToken || !c.appToken.startsWith('xapp-')) {
      errors.push('Invalid appToken: must start with xapp-');
    }

    if (!c.signingSecret) {
      errors.push('Missing signingSecret');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  async start(): Promise<void> {
    consola.info('Slack: Starting Socket Mode...');
    await this.app.start();
    consola.success('Slack adapter connected');
  }

  async stop(): Promise<void> {
    await this.app.stop();
    consola.debug('Slack adapter disconnected');
  }

  async sendMessage(channel: string, message: string, threadTs?: string): Promise<string> {
    const result = await this.app.client.chat.postMessage({
      channel,
      text: message,
      mrkdwn: true,
      thread_ts: threadTs,
    });

    return result.ts as string;
  }

  async updateMessage(channel: string, messageTs: string, message: string): Promise<void> {
    await this.app.client.chat.update({
      channel,
      ts: messageTs,
      text: message,
      mrkdwn: true,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onInteraction(handler: InteractionHandler): void {
    this.interactionHandlers.push(handler);
  }

  onAudioMessage(handler: AudioMessageHandler): void {
    this.audioMessageHandlers.push(handler);
  }

  private setupEventHandlers(): void {
    // Handle direct messages and mentions
    this.app.event('message', async ({ event, client }) => {
      const msg = event as GenericMessageEvent & {
        files?: Array<{ id: string; mimetype: string; url_private: string }>;
        subtype?: string;
      };

      // Ignore bot messages (but allow file_share subtype for voice messages)
      if (msg.bot_id) return;

      // Log for debugging
      consola.debug(`Message event: subtype=${msg.subtype}, has_files=${!!msg.files?.length}`);

      // Ignore if not a mention or DM (unless it's a file share in DM)
      const isDM = msg.channel_type === 'im';
      const hasMention = /<@[A-Z0-9]+>/i.test(msg.text || '');
      const isFileShare = msg.subtype === 'file_share';

      if (!isDM && !hasMention && !isFileShare) return;

      const context: MessageContext = {
        channelId: msg.channel,
        userId: msg.user || '',
        threadTs: msg.thread_ts || msg.ts,
        messageTs: msg.ts,
      };

      // Check for audio files (voice messages)
      if (msg.files && msg.files.length > 0) {
        for (const file of msg.files) {
          consola.debug(`File in message: ${file.mimetype}, url: ${file.url_private?.slice(0, 50)}...`);
          // Check if it's an audio file
          if (file.mimetype?.startsWith('audio/') || file.mimetype?.startsWith('video/')) {
            consola.info(`Received audio file: ${file.mimetype}`);
            try {
              const audioBuffer = await this.downloadFile(file.url_private);
              for (const handler of this.audioMessageHandlers) {
                await handler({ audioBuffer, mimeType: file.mimetype, context });
              }
            } catch (error) {
              consola.error('Failed to download audio file:', error);
            }
            return; // Don't process as text message
          }
        }
      }

      // Skip other subtypes (like message_changed, message_deleted, etc.)
      if (msg.subtype && msg.subtype !== 'file_share') return;

      // Remove all @mentions from text
      const text = (msg.text || '').replace(/<@[A-Z0-9]+>/gi, '').trim();

      // Skip empty messages
      if (!text) return;

      for (const handler of this.messageHandlers) {
        await handler({ text, context });
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event }) => {
      // Remove all @mentions from text
      const text = (event.text || '').replace(/<@[A-Z0-9]+>/gi, '').trim();

      const context: MessageContext = {
        channelId: event.channel,
        userId: event.user,
        threadTs: event.thread_ts || event.ts,
        messageTs: event.ts,
      };

      for (const handler of this.messageHandlers) {
        await handler({ text, context });
      }
    });

    // Handle button clicks and other interactions
    this.app.action(/.*/, async ({ action, body, ack }) => {
      await ack();

      const actionId = 'action_id' in action ? action.action_id : '';
      // Handle different action types - buttons have 'value', selects have 'selected_option'
      let value = '';
      if ('value' in action && action.value) {
        value = action.value as string;
      } else if ('selected_option' in action && action.selected_option) {
        value = (action.selected_option as { value: string }).value;
      }

      consola.debug(`Action received: ${actionId} = ${value}`);

      const context: MessageContext = {
        channelId: body.channel?.id || '',
        userId: body.user.id,
        messageTs: 'message' in body ? body.message?.ts : undefined,
      };

      for (const handler of this.interactionHandlers) {
        await handler(actionId, value, context);
      }
    });

    // Handle /project slash command
    this.app.command('/project', async ({ command, ack }) => {
      await ack();

      consola.debug(`Slash command /project from channel: ${command.channel_id}`);

      const context: MessageContext = {
        channelId: command.channel_id,
        userId: command.user_id,
      };

      // Trigger show_project_selector interaction
      for (const handler of this.interactionHandlers) {
        await handler('show_project_selector', '', context);
      }
    });

    // Handle /stop slash command
    this.app.command('/stop', async ({ command, ack }) => {
      await ack();

      consola.debug(`Slash command /stop from channel: ${command.channel_id}`);

      const context: MessageContext = {
        channelId: command.channel_id,
        userId: command.user_id,
      };

      // Trigger stop_execution interaction
      for (const handler of this.interactionHandlers) {
        await handler('stop_execution', '', context);
      }
    });

    // Handle /clear slash command
    this.app.command('/clear', async ({ command, ack }) => {
      await ack();

      consola.debug(`Slash command /clear from channel: ${command.channel_id}`);

      const context: MessageContext = {
        channelId: command.channel_id,
        userId: command.user_id,
      };

      // Trigger clear_session interaction
      for (const handler of this.interactionHandlers) {
        await handler('clear_session', '', context);
      }
    });
  }

  /**
   * Send a message with interactive buttons
   */
  async sendInteractiveMessage(
    channel: string,
    text: string,
    blocks: unknown[],
    threadTs?: string
  ): Promise<string> {
    const result = await this.app.client.chat.postMessage({
      channel,
      text,
      blocks: blocks as never[],
      thread_ts: threadTs,
    });

    return result.ts as string;
  }

  /**
   * Send a permission confirmation card
   */
  async sendPermissionCard(
    channel: string,
    requestId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    threadTs?: string
  ): Promise<string> {
    const inputStr = JSON.stringify(toolInput, null, 2).slice(0, 500);

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '⚠️ Permission Request',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Claude wants to use *${toolName}*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\`\`\`${inputStr}\`\`\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '✅ Allow',
            },
            style: 'primary',
            action_id: 'permission_approve',
            value: requestId,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '❌ Deny',
            },
            style: 'danger',
            action_id: 'permission_deny',
            value: requestId,
          },
        ],
      },
    ];

    return this.sendInteractiveMessage(channel, 'Permission Request', blocks, threadTs);
  }

  /**
   * Send a project selection card with full paths visible
   */
  async sendProjectSelectionCard(
    channel: string,
    projects: Array<{ name: string; path: string }>,
    pendingPrompt: string
  ): Promise<string> {
    const blocks: unknown[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Please select a project to work with:*',
        },
      },
      {
        type: 'divider',
      },
    ];

    // Show each project as a section with full path and select button
    // Limit to 20 projects to avoid message size limits
    for (const project of projects.slice(0, 20)) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\`${project.path}\``,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Select',
          },
          action_id: 'select_project',
          value: project.path,
        },
      });
    }

    // Show remaining count if any
    if (projects.length > 20) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_...and ${projects.length - 20} more projects_`,
          },
        ],
      });
    }

    blocks.push({
      type: 'divider',
    });

    // Show pending prompt context
    if (pendingPrompt && !pendingPrompt.startsWith('Current:')) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Your message: _"${pendingPrompt.slice(0, 100)}${pendingPrompt.length > 100 ? '...' : ''}"_`,
          },
        ],
      });
    }

    return this.sendInteractiveMessage(channel, 'Select a project', blocks);
  }

  /**
   * Upload a code snippet to a channel/thread
   */
  async uploadSnippet(
    channel: string,
    content: string,
    options: {
      filename?: string;
      title?: string;
      threadTs?: string;
      initialComment?: string;
    } = {}
  ): Promise<void> {
    try {
      await this.app.client.files.uploadV2({
        channel_id: channel,
        content,
        filename: options.filename || 'snippet.txt',
        title: options.title,
        thread_ts: options.threadTs,
        initial_comment: options.initialComment,
      });
    } catch (error) {
      consola.error('Failed to upload snippet:', error);
    }
  }

  /**
   * Download a file from Slack using bot token authentication
   */
  private async downloadFile(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
