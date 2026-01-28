// Heimerdinger Configuration Types

export interface ServerConfig {
  port: number;
  host: string;
  daemon: boolean;
}

export interface ClaudeConfig {
  configPath: string;
  includeThinking: boolean;
  defaultModel: string;
  timeout: number;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

export interface PermissionsConfig {
  allowedTools: string[];
  confirmTools: string[];
  blockedPatterns: string[];
  confirmTimeout: number;
  timeoutAction: 'allow' | 'deny';
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file: string;
}

export interface SlackAdapterConfig {
  enabled: boolean;
  signingSecret: string;
  botToken: string;
  appToken: string;
  socketMode: boolean;
}

export interface FeishuAdapterConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  connectionMode: 'websocket' | 'webhook';
  webhookPort?: number;
  domain?: 'feishu' | 'lark';
}

export interface AdapterConfigs {
  slack?: SlackAdapterConfig;
  feishu?: FeishuAdapterConfig;
  [key: string]: unknown;
}

export interface HeimerdingerConfig {
  version: string;
  server: ServerConfig;
  claude: ClaudeConfig;
  permissions: PermissionsConfig;
  projectDir: string;
  adapters: AdapterConfigs;
  activeAdapter: string;
  logging: LoggingConfig;
}

// Claude Code Types

export interface ClaudeProject {
  path: string;
  name: string;
  allowedTools: string[];
  mcpServers: Record<string, unknown>;
}

export interface ClaudeSession {
  sessionId: string;
  fullPath: string;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
}

export interface ClaudeSessionsIndex {
  version: number;
  entries: ClaudeSession[];
  originalPath: string;
}

export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export interface ClaudeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string; // For tool_result
  tool_use_id?: string; // For tool_result reference
}

export interface ClaudeStreamChunk {
  type: 'system' | 'assistant' | 'user' | 'tool_use' | 'tool_result' | 'result' | 'error';
  message?: {
    id?: string;
    role: string;
    content: ClaudeContentBlock[];
  };
  uuid?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  subtype?: 'init' | 'success' | 'error';
  result?: string;
  session_id?: string;
  permission_denials?: PermissionDenial[];
  cost_usd?: number;
  total_cost_usd?: number;
}

// IM Adapter Types

export interface MessageContext {
  channelId: string;
  userId: string;
  threadTs?: string;
  messageTs?: string;
}

export interface IMMessage {
  text: string;
  context: MessageContext;
}

export interface IMAudioMessage {
  audioBuffer: Buffer;
  mimeType: string;
  context: MessageContext;
}

export type MessageHandler = (message: IMMessage) => Promise<void>;
export type AudioMessageHandler = (message: IMAudioMessage) => Promise<void>;
export type InteractionHandler = (
  action: string,
  value: string,
  context: MessageContext
) => Promise<void>;

export interface ConfigField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  description: string;
  default?: unknown;
  options?: string[];
  secret?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface IMAdapter {
  name: string;
  init(): Promise<void>;
  getConfigTemplate(): ConfigField[];
  validateConfig(config: unknown): ValidationResult;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(channel: string, message: string, threadTs?: string): Promise<string>;
  updateMessage(channel: string, messageTs: string, message: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onAudioMessage?(handler: AudioMessageHandler): void;
  onInteraction(handler: InteractionHandler): void;
  // Optional interactive methods
  sendProjectSelectionCard?(
    channel: string,
    projects: Array<{ name: string; path: string }>,
    pendingPrompt: string
  ): Promise<string>;
  // Optional snippet upload for showing diffs
  uploadSnippet?(
    channel: string,
    content: string,
    options?: {
      filename?: string;
      title?: string;
      threadTs?: string;
      initialComment?: string;
    }
  ): Promise<void>;
  // Optional interactive message with custom blocks
  sendInteractiveMessage?(
    channel: string,
    text: string,
    blocks: unknown[],
    threadTs?: string
  ): Promise<string>;
}

// Service Status

export interface ServiceStatus {
  running: boolean;
  pid?: number;
  port?: number;
  uptime?: number;
  adapter?: string;
  projectDir?: string;
}
