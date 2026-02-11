import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { consola } from 'consola';
import { FeishuAdapter } from '../adapters/feishu';
import { SlackAdapter } from '../adapters/slack';
import { PID_FILE } from '../constants';
import type { FeishuAdapterConfig, IMAdapter } from '../types';
import type { ConfigManager } from './config-manager';
import { MessageProcessor } from './message-processor';

export class HeimerdingerServer {
  private configManager: ConfigManager;
  private adapter: IMAdapter | null = null;
  private messageProcessor: MessageProcessor;
  private httpServer: Server | null = null;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    this.messageProcessor = new MessageProcessor(configManager);
  }

  async start(): Promise<void> {
    const port = this.configManager.get<number>('server.port') || 3150;
    const activeAdapter = this.configManager.get<string>('activeAdapter');

    // Write PID file
    writeFileSync(PID_FILE, process.pid.toString());

    // Start HTTP server for health checks
    this.httpServer = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);

      // Health check endpoint
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // Status endpoint
      if (url.pathname === '/status') {
        const status = {
          service: 'heimerdinger',
          status: 'running',
          adapter: this.configManager.get('activeAdapter'),
          projectDir: this.configManager.get('projectDir'),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.httpServer.listen(port);
    consola.success(`HTTP server started on port ${port}`);

    // Initialize IM adapter
    if (activeAdapter === 'slack') {
      await this.initSlackAdapter();
    } else if (activeAdapter === 'feishu') {
      await this.initFeishuAdapter();
    } else if (activeAdapter) {
      consola.warn(`Unknown adapter: ${activeAdapter}`);
    } else {
      consola.warn('No IM adapter configured. Only HTTP endpoints available.');
    }

    consola.success('Heimerdinger service started');
  }

  async stop(): Promise<void> {
    consola.info('Stopping Heimerdinger service...');

    // Stop adapter
    if (this.adapter) {
      await this.adapter.stop();
    }

    // Stop HTTP server
    if (this.httpServer) {
      this.httpServer.close();
    }

    // Remove PID file
    try {
      if (existsSync(PID_FILE)) {
        unlinkSync(PID_FILE);
      }
    } catch {
      // Ignore
    }

    consola.success('Service stopped');
  }

  private async initSlackAdapter(): Promise<void> {
    const slackConfig = this.configManager.get<{
      botToken: string;
      appToken: string;
      signingSecret: string;
      socketMode: boolean;
    }>('adapters.slack');

    if (!slackConfig) {
      consola.warn('Slack adapter not configured');
      return;
    }

    try {
      consola.info('Initializing Slack adapter...');

      const adapter = new SlackAdapter({
        botToken: slackConfig.botToken,
        appToken: slackConfig.appToken,
        signingSecret: slackConfig.signingSecret,
        socketMode: slackConfig.socketMode ?? true,
      });
      this.adapter = adapter;

      // Register message handler
      adapter.onMessage(async (message) => {
        consola.debug('Received message:', message.text);
        await this.messageProcessor.handleMessage(message, adapter);
      });

      // Register audio message handler (for voice messages)
      if (adapter.onAudioMessage) {
        adapter.onAudioMessage(async (message) => {
          consola.debug('Received audio message:', message.mimeType);
          await this.messageProcessor.handleAudioMessage(message, adapter);
        });
      }

      // Register interaction handler
      adapter.onInteraction(async (action, value, context) => {
        consola.debug('Received interaction:', action);
        await this.messageProcessor.handleInteraction(action, value, context, adapter);
      });

      await adapter.start();
      consola.success('Slack adapter started');

      // Notify known channels that the bot is online
      const channelStates = this.messageProcessor.getChannelIds();
      for (const channelId of channelStates) {
        try {
          await adapter.sendMessage(channelId, `🟢 Heimerdinger online (${new Date().toLocaleTimeString()})`);
        } catch {
          // Channel might not be accessible
        }
      }
    } catch (error) {
      consola.error('Failed to initialize Slack adapter:', error);
    }
  }

  private async initFeishuAdapter(): Promise<void> {
    const feishuConfig = this.configManager.get<FeishuAdapterConfig>('adapters.feishu');

    if (!feishuConfig) {
      consola.warn('Feishu adapter not configured');
      return;
    }

    try {
      consola.info('Initializing Feishu adapter...');

      const adapter = new FeishuAdapter({
        enabled: feishuConfig.enabled,
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
        encryptKey: feishuConfig.encryptKey,
        verificationToken: feishuConfig.verificationToken,
        connectionMode: feishuConfig.connectionMode ?? 'websocket',
        webhookPort: feishuConfig.webhookPort,
        domain: feishuConfig.domain ?? 'feishu',
      });
      this.adapter = adapter;

      // Register message handler
      adapter.onMessage(async (message) => {
        consola.debug('Received message:', message.text);
        await this.messageProcessor.handleMessage(message, adapter);
      });

      // Register audio message handler (for voice messages)
      if (adapter.onAudioMessage) {
        adapter.onAudioMessage(async (message) => {
          consola.debug('Received audio message:', message.mimeType);
          await this.messageProcessor.handleAudioMessage(message, adapter);
        });
      }

      // Register interaction handler
      adapter.onInteraction(async (action, value, context) => {
        consola.debug('Received interaction:', action);
        await this.messageProcessor.handleInteraction(action, value, context, adapter);
      });

      await adapter.start();
      consola.success('Feishu adapter started');
    } catch (error) {
      consola.error('Failed to initialize Feishu adapter:', error);
    }
  }
}
