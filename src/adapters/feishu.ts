import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import * as lark from '@larksuiteoapi/node-sdk';
import { consola } from 'consola';
import type {
  AudioMessageHandler,
  ConfigField,
  FeishuAdapterConfig,
  IMAdapter,
  InteractionHandler,
  MessageContext,
  MessageHandler,
  ValidationResult,
} from '../types';

// Feishu message event data structure (matches SDK's im.message.receive_v1 event)
interface FeishuMessageEvent {
  sender: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
  message: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{
      key?: string;
      id?: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name?: string;
    }>;
  };
}

export class FeishuAdapter implements IMAdapter {
  readonly name = 'feishu';

  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher;
  private cardActionHandler: lark.CardActionHandler | null = null;
  private webhookServer: Server | null = null;
  private config: FeishuAdapterConfig;
  private messageHandlers: MessageHandler[] = [];
  private audioMessageHandlers: AudioMessageHandler[] = [];
  private interactionHandlers: InteractionHandler[] = [];
  private botOpenId: string | null = null;

  // Throttle message updates (max 1 update per second per message)
  private lastUpdateTime: Map<string, number> = new Map();
  private pendingUpdates: Map<string, string> = new Map();
  private updateTimers: Map<string, NodeJS.Timeout> = new Map();
  private static readonly UPDATE_INTERVAL = 1000; // 1 second

  constructor(config: FeishuAdapterConfig) {
    this.config = config;

    const domain = config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain,
    });

    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: config.encryptKey || '',
      verificationToken: config.verificationToken || '',
    });

    this.setupEventHandlers();
  }

  async init(): Promise<void> {
    // Bot open_id will be set when we receive our first message
    // The SDK doesn't have a direct API to get bot info
    consola.debug('Feishu adapter initialized');
  }

  getConfigTemplate(): ConfigField[] {
    return [
      {
        name: 'appId',
        type: 'string',
        required: true,
        description: 'App ID from Feishu Open Platform',
      },
      {
        name: 'appSecret',
        type: 'string',
        required: true,
        description: 'App Secret from Feishu Open Platform',
        secret: true,
      },
      {
        name: 'encryptKey',
        type: 'string',
        required: false,
        description: 'Encrypt Key for event subscription (Webhook mode)',
        secret: true,
      },
      {
        name: 'verificationToken',
        type: 'string',
        required: false,
        description: 'Verification Token for card callbacks',
        secret: true,
      },
      {
        name: 'connectionMode',
        type: 'select',
        required: true,
        description: 'Connection mode for receiving events',
        options: ['websocket', 'webhook'],
        default: 'websocket',
      },
      {
        name: 'webhookPort',
        type: 'number',
        required: false,
        description: 'Port for webhook server (Webhook mode only)',
        default: 3151,
      },
      {
        name: 'domain',
        type: 'select',
        required: false,
        description: 'Feishu domain (feishu.cn or larksuite.com)',
        options: ['feishu', 'lark'],
        default: 'feishu',
      },
    ];
  }

  validateConfig(config: unknown): ValidationResult {
    const errors: string[] = [];
    const c = config as Partial<FeishuAdapterConfig>;

    if (!c.appId) {
      errors.push('Missing appId');
    }

    if (!c.appSecret) {
      errors.push('Missing appSecret');
    }

    if (c.connectionMode === 'webhook' && !c.encryptKey) {
      errors.push('encryptKey is required for webhook mode');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  async start(): Promise<void> {
    await this.init();

    if (this.config.connectionMode === 'websocket') {
      await this.startWebSocket();
    } else {
      await this.startWebhook();
    }
  }

  async stop(): Promise<void> {
    // Clear all pending update timers
    for (const timer of this.updateTimers.values()) {
      clearTimeout(timer);
    }
    this.updateTimers.clear();
    this.pendingUpdates.clear();
    this.lastUpdateTime.clear();

    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
    }

    // WSClient doesn't have a stop method, it auto-reconnects
    this.wsClient = null;

    consola.debug('Feishu adapter stopped');
  }

  async sendMessage(channel: string, message: string, threadTs?: string): Promise<string> {
    // Determine receive_id_type based on channel prefix
    // oc_ = chat_id (group), ou_ = open_id (user)
    const receiveIdType = channel.startsWith('ou_') ? 'open_id' : 'chat_id';

    // Convert markdown to Feishu format
    const content = this.convertToFeishuMarkdown(message);

    // If threadTs is provided, reply to that message
    if (threadTs) {
      const result = await this.client.im.message.reply({
        path: {
          message_id: threadTs,
        },
        data: {
          content: JSON.stringify({ text: content }),
          msg_type: 'text',
        },
      });

      if (result.code !== 0) {
        throw new Error(`Failed to reply message: ${result.msg}`);
      }

      return result.data?.message_id || '';
    }

    // Send new message
    const result = await this.client.im.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: channel,
        content: JSON.stringify({ text: content }),
        msg_type: 'text',
      },
    });

    if (result.code !== 0) {
      throw new Error(`Failed to send message: ${result.msg}`);
    }

    return result.data?.message_id || '';
  }

  async updateMessage(channel: string, messageTs: string, message: string): Promise<void> {
    const now = Date.now();
    const lastUpdate = this.lastUpdateTime.get(messageTs) || 0;
    const timeSinceLastUpdate = now - lastUpdate;

    // If we're within the throttle interval, queue the update
    if (timeSinceLastUpdate < FeishuAdapter.UPDATE_INTERVAL) {
      this.pendingUpdates.set(messageTs, message);

      // Set a timer to perform the update if not already set
      if (!this.updateTimers.has(messageTs)) {
        const delay = FeishuAdapter.UPDATE_INTERVAL - timeSinceLastUpdate;
        const timer = setTimeout(() => {
          this.flushPendingUpdate(channel, messageTs);
        }, delay);
        this.updateTimers.set(messageTs, timer);
      }
      return;
    }

    // Perform immediate update
    await this.doUpdateMessage(messageTs, message);
  }

  private async flushPendingUpdate(channel: string, messageTs: string): Promise<void> {
    const pendingMessage = this.pendingUpdates.get(messageTs);
    this.pendingUpdates.delete(messageTs);
    this.updateTimers.delete(messageTs);

    if (pendingMessage) {
      await this.doUpdateMessage(messageTs, pendingMessage);
    }
  }

  private async doUpdateMessage(messageTs: string, message: string): Promise<void> {
    this.lastUpdateTime.set(messageTs, Date.now());

    // Feishu only supports updating interactive cards, not text messages
    // For text messages, we need to send a card initially
    // Here we try to update as a card, which requires the message to be a card
    const content = this.convertToFeishuMarkdown(message);

    try {
      // Try to patch as an interactive card
      const cardContent = {
        config: {
          wide_screen_mode: true,
        },
        elements: [
          {
            tag: 'markdown',
            content,
          },
        ],
      };

      await this.client.im.message.patch({
        path: {
          message_id: messageTs,
        },
        data: {
          content: JSON.stringify(cardContent),
        },
      });
    } catch (error) {
      consola.debug('Failed to update message (may be text message):', error);
      // If patch fails, the original message was not a card
      // This is expected for text messages
    }
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

  /**
   * Send a message card for streaming updates
   * Unlike text messages, cards can be updated
   */
  async sendStreamingMessage(channel: string, message: string, threadTs?: string): Promise<string> {
    const receiveIdType = channel.startsWith('ou_') ? 'open_id' : 'chat_id';
    const content = this.convertToFeishuMarkdown(message);

    const cardContent = {
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'markdown',
          content,
        },
      ],
    };

    if (threadTs) {
      const result = await this.client.im.message.reply({
        path: {
          message_id: threadTs,
        },
        data: {
          content: JSON.stringify(cardContent),
          msg_type: 'interactive',
        },
      });

      if (result.code !== 0) {
        throw new Error(`Failed to send streaming message: ${result.msg}`);
      }

      return result.data?.message_id || '';
    }

    const result = await this.client.im.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: channel,
        content: JSON.stringify(cardContent),
        msg_type: 'interactive',
      },
    });

    if (result.code !== 0) {
      throw new Error(`Failed to send streaming message: ${result.msg}`);
    }

    return result.data?.message_id || '';
  }

  /**
   * Send a project selection card
   */
  async sendProjectSelectionCard(
    channel: string,
    projects: Array<{ name: string; path: string }>,
    pendingPrompt: string
  ): Promise<string> {
    const receiveIdType = channel.startsWith('ou_') ? 'open_id' : 'chat_id';

    const elements: unknown[] = [
      {
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: 'Please select a project to work with:',
        },
      },
      {
        tag: 'hr',
      },
    ];

    // Add project buttons (limit to 20)
    for (const project of projects.slice(0, 20)) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: project.path,
            },
            type: 'default',
            value: {
              action: 'select_project',
              path: project.path,
            },
          },
        ],
      });
    }

    if (projects.length > 20) {
      elements.push({
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `...and ${projects.length - 20} more projects`,
          },
        ],
      });
    }

    elements.push({
      tag: 'hr',
    });

    // Show pending prompt context
    if (pendingPrompt && !pendingPrompt.startsWith('Current:')) {
      const truncatedPrompt =
        pendingPrompt.length > 100 ? `${pendingPrompt.slice(0, 100)}...` : pendingPrompt;
      elements.push({
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `Your message: "${truncatedPrompt}"`,
          },
        ],
      });
    }

    const cardContent = {
      config: {
        wide_screen_mode: true,
      },
      header: {
        title: {
          tag: 'plain_text',
          content: 'Select Project',
        },
        template: 'blue',
      },
      elements,
    };

    const result = await this.client.im.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: channel,
        content: JSON.stringify(cardContent),
        msg_type: 'interactive',
      },
    });

    if (result.code !== 0) {
      throw new Error(`Failed to send project selection card: ${result.msg}`);
    }

    return result.data?.message_id || '';
  }

  /**
   * Send an interactive message with custom elements
   */
  async sendInteractiveMessage(
    channel: string,
    text: string,
    blocks: unknown[],
    threadTs?: string
  ): Promise<string> {
    const receiveIdType = channel.startsWith('ou_') ? 'open_id' : 'chat_id';

    const cardContent = {
      config: {
        wide_screen_mode: true,
      },
      elements: blocks,
    };

    if (threadTs) {
      const result = await this.client.im.message.reply({
        path: {
          message_id: threadTs,
        },
        data: {
          content: JSON.stringify(cardContent),
          msg_type: 'interactive',
        },
      });

      if (result.code !== 0) {
        throw new Error(`Failed to send interactive message: ${result.msg}`);
      }

      return result.data?.message_id || '';
    }

    const result = await this.client.im.message.create({
      params: {
        receive_id_type: receiveIdType,
      },
      data: {
        receive_id: channel,
        content: JSON.stringify(cardContent),
        msg_type: 'interactive',
      },
    });

    if (result.code !== 0) {
      throw new Error(`Failed to send interactive message: ${result.msg}`);
    }

    return result.data?.message_id || '';
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

    const elements = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `Claude wants to use **${toolName}**`,
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `\`\`\`json\n${inputStr}\n\`\`\``,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: 'Allow',
            },
            type: 'primary',
            value: {
              action: 'permission_approve',
              requestId,
            },
          },
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: 'Deny',
            },
            type: 'danger',
            value: {
              action: 'permission_deny',
              requestId,
            },
          },
        ],
      },
    ];

    const cardContent = {
      config: {
        wide_screen_mode: true,
      },
      header: {
        title: {
          tag: 'plain_text',
          content: 'Permission Request',
        },
        template: 'orange',
      },
      elements,
    };

    return this.sendInteractiveMessage(channel, 'Permission Request', [cardContent], threadTs);
  }

  /**
   * Upload a code snippet
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
    // Feishu doesn't have a direct snippet upload like Slack
    // Send as a code block in a card instead
    const receiveIdType = channel.startsWith('ou_') ? 'open_id' : 'chat_id';

    const elements: unknown[] = [];

    if (options.title) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: options.title,
        },
      });
    }

    if (options.initialComment) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: options.initialComment,
        },
      });
    }

    // Truncate content if too long (Feishu has ~30000 char limit)
    const truncatedContent = content.slice(0, 25000);
    const filename = options.filename || 'snippet.txt';

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${filename}**\n\`\`\`\n${truncatedContent}\n\`\`\``,
      },
    });

    if (content.length > 25000) {
      elements.push({
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '(Content truncated)',
          },
        ],
      });
    }

    const cardContent = {
      config: {
        wide_screen_mode: true,
      },
      elements,
    };

    if (options.threadTs) {
      await this.client.im.message.reply({
        path: {
          message_id: options.threadTs,
        },
        data: {
          content: JSON.stringify(cardContent),
          msg_type: 'interactive',
        },
      });
    } else {
      await this.client.im.message.create({
        params: {
          receive_id_type: receiveIdType,
        },
        data: {
          receive_id: channel,
          content: JSON.stringify(cardContent),
          msg_type: 'interactive',
        },
      });
    }
  }

  private setupEventHandlers(): void {
    // Register message receive handler
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: FeishuMessageEvent) => {
        await this.handleMessageEvent(data);
      },
    });

    // Setup card action handler if verification token is provided
    if (this.config.verificationToken) {
      this.cardActionHandler = new lark.CardActionHandler(
        {
          encryptKey: this.config.encryptKey || '',
          verificationToken: this.config.verificationToken,
        },
        async (data: lark.InteractiveCardActionEvent) => {
          await this.handleCardAction(data);
          return undefined; // Don't update the card automatically
        }
      );
    }
  }

  private async handleMessageEvent(data: FeishuMessageEvent): Promise<void> {
    const { sender, message } = data;

    // Validate required fields
    const senderId = sender?.sender_id?.open_id;
    const chatId = message?.chat_id;
    const messageId = message?.message_id;
    const content = message?.content;

    if (!senderId || !chatId || !messageId) {
      consola.debug('Missing required fields in message event');
      return;
    }

    // Ignore messages from bot itself
    if (sender.sender_type === 'bot') return;

    const isPrivateChat = message.chat_type === 'p2p';
    const hasMention = message.mentions?.some(
      (m) => this.botOpenId && m.id?.open_id === this.botOpenId
    );

    // Only process private chats or messages that mention the bot
    if (!isPrivateChat && !hasMention) return;

    const context: MessageContext = {
      channelId: chatId,
      userId: senderId,
      threadTs: message.root_id || messageId,
      messageTs: messageId,
    };

    // Handle audio messages
    if (message.message_type === 'audio') {
      try {
        if (!content) return;
        const contentJson = JSON.parse(content);
        const audioBuffer = await this.downloadAudioFile(messageId, contentJson.file_key);

        for (const handler of this.audioMessageHandlers) {
          await handler({
            audioBuffer,
            mimeType: 'audio/ogg', // Feishu uses opus in ogg container
            context,
          });
        }
      } catch (error) {
        consola.error('Failed to process audio message:', error);
      }
      return;
    }

    // Handle text messages
    if (message.message_type !== 'text') return;

    let text = '';
    try {
      if (!content) return;
      const contentJson = JSON.parse(content);
      text = contentJson.text || '';
    } catch {
      consola.warn('Failed to parse message content');
      return;
    }

    // Remove @mentions from text
    // Feishu mentions are like @_user_1 in the text
    text = text.replace(/@_user_\d+/g, '').trim();

    // Skip empty messages
    if (!text) return;

    consola.debug(`Received message from ${senderId}: ${text}`);

    for (const handler of this.messageHandlers) {
      await handler({ text, context });
    }
  }

  private async handleCardAction(data: lark.InteractiveCardActionEvent): Promise<void> {
    const { action, open_id, open_message_id } = data;
    const value = action.value as Record<string, unknown>;

    const actionType = (value.action as string) || action.tag;
    const actionValue = JSON.stringify(value);

    consola.debug(`Card action: ${actionType} = ${actionValue}`);

    const context: MessageContext = {
      channelId: '', // Will be determined by the handler
      userId: open_id,
      messageTs: open_message_id,
    };

    // Handle specific actions
    if (actionType === 'select_project') {
      for (const handler of this.interactionHandlers) {
        await handler('select_project', value.path as string, context);
      }
    } else if (actionType === 'permission_approve') {
      for (const handler of this.interactionHandlers) {
        await handler('permission_approve', value.requestId as string, context);
      }
    } else if (actionType === 'permission_deny') {
      for (const handler of this.interactionHandlers) {
        await handler('permission_deny', value.requestId as string, context);
      }
    } else {
      // Generic action handling
      for (const handler of this.interactionHandlers) {
        await handler(actionType, actionValue, context);
      }
    }
  }

  private async downloadAudioFile(messageId: string, fileKey: string): Promise<Buffer> {
    const response = await this.client.im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type: 'file',
      },
    });

    const stream = response.getReadableStream();
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private async startWebSocket(): Promise<void> {
    consola.info('Feishu: Starting WebSocket connection...');

    const domain = this.config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.info,
    });

    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });

    consola.success('Feishu adapter connected (WebSocket)');
  }

  private async startWebhook(): Promise<void> {
    const port = this.config.webhookPort || 3151;
    consola.info(`Feishu: Starting Webhook server on port ${port}...`);

    this.webhookServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Handle event webhook
      if (req.url === '/webhook/event' && req.method === 'POST') {
        this.handleWebhookRequest(req, res, this.eventDispatcher);
        return;
      }

      // Handle card action webhook
      if (req.url === '/webhook/card' && req.method === 'POST' && this.cardActionHandler) {
        this.handleWebhookRequest(req, res, this.cardActionHandler);
        return;
      }

      // Health check
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.webhookServer.listen(port);
    consola.success(`Feishu adapter started (Webhook on port ${port})`);
  }

  private handleWebhookRequest(
    req: IncomingMessage,
    res: ServerResponse,
    handler: lark.EventDispatcher | lark.CardActionHandler
  ): void {
    let body = '';
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        // Handle URL verification challenge
        if (data.type === 'url_verification') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ challenge: data.challenge }));
          return;
        }

        // Process event/card action
        const result = await handler.invoke(data, { needCheck: true });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result || {}));
      } catch (error) {
        consola.error('Webhook error:', error);
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });
  }

  /**
   * Convert markdown to Feishu lark_md format
   * Feishu uses slightly different markdown syntax
   */
  private convertToFeishuMarkdown(text: string): string {
    // Slack uses *bold* and _italic_, Feishu uses **bold** and *italic*
    // Convert Slack-style bold to Feishu-style
    let result = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '**$1**');

    // Convert Slack-style italic to Feishu-style (after bold conversion)
    result = result.replace(/_([^_]+)_/g, '*$1*');

    // Feishu @mention format: <at user_id="xxx"></at>
    // Leave @mentions as-is for now, they need user context

    return result;
  }
}
