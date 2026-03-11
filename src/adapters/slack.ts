import { App } from '@slack/bolt';

// Slack message event type (simplified from @slack/bolt)
interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
  bot_id?: string;
  files?: Array<{ id: string; name?: string; mimetype: string; url_private: string }>;
}
import { consola } from 'consola';
import type {
  AudioMessageHandler,
  ConfigField,
  IMAdapter,
  IMImageAttachment,
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
  private botUserId: string | null = null;
  private messageHandlers: MessageHandler[] = [];
  private audioMessageHandlers: AudioMessageHandler[] = [];
  private interactionHandlers: InteractionHandler[] = [];
  // Track recently processed message timestamps to prevent duplicate processing
  // from both 'message' and 'app_mention' events
  private processedMessages: Set<string> = new Set();

  constructor(config: SlackAdapterConfig) {
    this.config = config;
    this.app = new App({
      token: config.botToken,
      signingSecret: config.signingSecret,
      socketMode: config.socketMode,
      appToken: config.appToken,
    });

    // 增加 Socket Mode ping/pong 超时时间，默认 5s 太短，内存紧张时容易断连
    try {
      // biome-ignore lint/suspicious/noExplicitAny: 访问内部 receiver.client 属性
      const receiver = (this.app as any).receiver;
      if (receiver?.client) {
        receiver.client.clientPingTimeoutMS = 30000; // 30s (默认 5s)
        receiver.client.serverPingTimeoutMS = 60000; // 60s (默认 30s)
        consola.info('Socket Mode timeouts set: clientPing=30s, serverPing=60s');
      }
    } catch {
      consola.warn('Failed to set Socket Mode timeouts');
    }

    this.app.error(async (error) => {
      consola.error('Slack Bolt error:', error);
    });

    // 全局中间件：记录所有收到的事件，用于排查事件是否送达
    this.app.use(async ({ body, next }) => {
      // biome-ignore lint/suspicious/noExplicitAny: 需要访问 body 内部字段
      const b = body as any;
      console.log(
        `[slack:middleware] type=${b.type} event=${b.event?.type || 'N/A'} user=${b.event?.user || 'N/A'} channel=${b.event?.channel || 'N/A'}`
      );
      await next();
    });

    this.setupEventHandlers();
  }

  async init(): Promise<void> {
    // No initialization needed for Slack adapter
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

    // Get bot's own user ID to filter self-messages
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id || null;
      consola.info(`Bot user ID: ${this.botUserId}`);
    } catch (error) {
      consola.warn('Failed to get bot user ID:', error);
    }

    consola.success('Slack adapter connected and ready');
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
      try {
        const msg = event as SlackMessageEvent;

        // Filter out message_changed/message_deleted/etc. subtypes early (these are bot edits)
        if (msg.subtype && msg.subtype !== 'file_share') {
          return;
        }

        // Raw log to ensure visibility regardless of consola level
        console.log(
          `[slack:message] ts=${msg.ts} user=${msg.user} channel=${msg.channel} channel_type=${msg.channel_type} text="${(msg.text || '').slice(0, 40)}"`
        );

        // Ignore bot messages (check bot_id, bot's own user ID, and edited messages)
        if (msg.bot_id) {
          consola.info(`[msg filter] skip: bot_id=${msg.bot_id}`);
          return;
        }
        if (this.botUserId && msg.user === this.botUserId) {
          consola.info(`[msg filter] skip: bot user ${msg.user}`);
          return;
        }
        // biome-ignore lint/suspicious/noExplicitAny: Slack event types don't include 'edited'
        if ((msg as any).edited) {
          consola.info(`[msg filter] skip: edited msg from ${msg.user}`);
          return;
        }

        consola.info(
          `[msg event] user=${msg.user} subtype=${msg.subtype} isDM=${msg.channel_type === 'im'} text="${(msg.text || '').slice(0, 50)}"`
        );

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

        // Process files: audio/video → transcription, images → attach to message
        const images: IMImageAttachment[] = [];
        if (msg.files && msg.files.length > 0) {
          for (const file of msg.files) {
            consola.debug(
              `File in message: ${file.mimetype}, url: ${file.url_private?.slice(0, 50)}...`
            );
            // Audio/video files → transcription handler
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
            // Image files → download and attach
            if (file.mimetype?.startsWith('image/')) {
              consola.info(`Received image file: ${file.mimetype}, name=${file.name}`);
              try {
                const imageBuffer = await this.downloadFile(file.url_private);
                const ext = file.name?.split('.').pop() || 'png';
                const filename = file.name || `image-${file.id}.${ext}`;
                images.push({ buffer: imageBuffer, filename, mimetype: file.mimetype });
              } catch (error) {
                consola.error('Failed to download image file:', error);
              }
            }
          }
        }

        // Remove all @mentions from text
        const text = (msg.text || '').replace(/<@[A-Z0-9]+>/gi, '').trim();

        // Skip empty messages (but allow image-only messages)
        if (!text && images.length === 0) return;

        // Mark as processed to prevent duplicate handling from app_mention
        this.processedMessages.add(msg.ts);
        // Clean old entries (keep last 100)
        if (this.processedMessages.size > 100) {
          const entries = [...this.processedMessages];
          this.processedMessages = new Set(entries.slice(-50));
        }

        for (const handler of this.messageHandlers) {
          await handler({ text, context, images: images.length > 0 ? images : undefined });
        }
      } catch (err) {
        console.error('[slack:message] UNCAUGHT ERROR:', err);
        consola.error('[slack:message] handler error:', err);
      }
    });

    // Handle app mentions (for @bot mentions in channels)
    this.app.event('app_mention', async ({ event }) => {
      try {
        // Raw log to ensure visibility regardless of consola level
        console.log(
          `[slack:app_mention] ts=${event.ts} user=${event.user} channel=${event.channel} text="${(event.text || '').slice(0, 40)}"`
        );
        consola.info(
          `[app_mention] user=${event.user} channel=${event.channel} text="${(event.text || '').slice(0, 50)}"`
        );

        // Skip if already processed by the 'message' handler
        if (this.processedMessages.has(event.ts)) {
          consola.info(`[app_mention] skip: already processed by message handler ts=${event.ts}`);
          return;
        }

        // Ignore bot's own messages
        if (this.botUserId && event.user === this.botUserId) {
          consola.info(`[app_mention] skip: bot user ${event.user}`);
          return;
        }

        // Remove all @mentions from text
        const text = (event.text || '').replace(/<@[A-Z0-9]+>/gi, '').trim();

        // Skip empty messages
        if (!text) {
          consola.info('[app_mention] skip: empty text after removing mentions');
          return;
        }

        const context: MessageContext = {
          channelId: event.channel,
          userId: event.user || '',
          threadTs: event.thread_ts || event.ts,
          messageTs: event.ts,
        };

        // Mark as processed
        this.processedMessages.add(event.ts);

        for (const handler of this.messageHandlers) {
          await handler({ text, context });
        }
      } catch (err) {
        console.error('[slack:app_mention] UNCAUGHT ERROR:', err);
        consola.error('[slack:app_mention] handler error:', err);
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

      consola.debug(`Action received: ${actionId} = ${value}, channel=${body.channel?.id}`);

      const context: MessageContext = {
        channelId: body.channel?.id || '',
        userId: body.user.id,
        messageTs: 'message' in body ? body.message?.ts : undefined,
      };

      if (!context.channelId) {
        consola.warn(
          'Action received without channel ID! body.channel:',
          JSON.stringify(body.channel)
        );
      }

      for (const handler of this.interactionHandlers) {
        await handler(actionId, value, context);
      }
    });

    // Handle /project slash command
    this.app.command('/project', async ({ command, ack }) => {
      await ack();

      consola.info(`Slash command /project from channel: ${command.channel_id}`);

      try {
        const context: MessageContext = {
          channelId: command.channel_id,
          userId: command.user_id,
        };

        // Trigger show_project_selector interaction
        for (const handler of this.interactionHandlers) {
          await handler('show_project_selector', '', context);
        }
      } catch (error) {
        consola.error('Error handling /project command:', error);
      }
    });

    // Handle /stop slash command
    this.app.command('/stop', async ({ command, ack }) => {
      await ack();

      consola.info(`Slash command /stop from channel: ${command.channel_id}`);

      try {
        const context: MessageContext = {
          channelId: command.channel_id,
          userId: command.user_id,
        };

        // Trigger stop_execution interaction
        for (const handler of this.interactionHandlers) {
          await handler('stop_execution', '', context);
        }
      } catch (error) {
        consola.error('Error handling /stop command:', error);
      }
    });

    // Handle /clear slash command
    this.app.command('/clear', async ({ command, ack }) => {
      await ack();

      consola.info(`Slash command /clear from channel: ${command.channel_id}`);

      try {
        const context: MessageContext = {
          channelId: command.channel_id,
          userId: command.user_id,
        };

        // Trigger clear_session interaction
        for (const handler of this.interactionHandlers) {
          await handler('clear_session', '', context);
        }
      } catch (error) {
        consola.error('Error handling /clear command:', error);
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
      // Build upload args, only including optional fields if they have values
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      const uploadArgs: Record<string, any> = {
        channel_id: channel,
        content,
        filename: options.filename || 'snippet.txt',
      };

      if (options.title) uploadArgs.title = options.title;
      if (options.threadTs) uploadArgs.thread_ts = options.threadTs;
      if (options.initialComment) uploadArgs.initial_comment = options.initialComment;

      await this.app.client.files.uploadV2(
        uploadArgs as Parameters<typeof this.app.client.files.uploadV2>[0]
      );
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
