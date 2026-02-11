import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { consola } from 'consola';
import { SESSIONS_STATE_FILE } from '../constants';
import type {
  IMAdapter,
  IMAudioMessage,
  IMMessage,
  MessageContext,
  PermissionDenial,
} from '../types';
import { ClaudeCodeService } from './claude-code';
import type { ConfigManager } from './config-manager';
import { WhisperService } from './whisper';

interface ChannelState {
  projectPath?: string;
  sessionId?: string;
  pendingPrompt?: string;
}

interface PendingRetry {
  prompt: string;
  projectDir: string;
  channelId: string;
  sessionId?: string;
}

interface SessionsState {
  // channel -> state
  channels: Record<string, ChannelState>;
  // project -> last session ID (for auto-resume)
  projectSessions: Record<string, string>;
}

export class MessageProcessor {
  private configManager: ConfigManager;
  private claudeService: ClaudeCodeService;
  private whisperService: WhisperService;

  // Track user states (channel -> state)
  private userStates: Map<string, ChannelState> = new Map();
  // Track project -> session mapping for persistence
  private projectSessions: Map<string, string> = new Map();
  // Track pending retries (retryId -> retry info)
  private pendingRetries: Map<string, PendingRetry> = new Map();
  // Track active executions per channel (for /stop command)
  private activeExecutions: Map<string, { abort: () => void; messageTs: string; aborted: boolean }> = new Map();

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    this.claudeService = new ClaudeCodeService();
    this.whisperService = new WhisperService();
    this.loadState();
  }

  /**
   * Load persisted state from file
   */
  private loadState(): void {
    try {
      if (existsSync(SESSIONS_STATE_FILE)) {
        const content = readFileSync(SESSIONS_STATE_FILE, 'utf-8');
        const state: SessionsState = JSON.parse(content);

        // Restore channel states
        for (const [channel, channelState] of Object.entries(state.channels || {})) {
          this.userStates.set(channel, channelState);
        }

        // Restore project sessions
        for (const [project, sessionId] of Object.entries(state.projectSessions || {})) {
          this.projectSessions.set(project, sessionId);
        }

        consola.info(
          `Loaded ${this.userStates.size} channel states, ${this.projectSessions.size} project sessions`
        );
        // Log channel states for debugging
        for (const [channel, channelState] of this.userStates) {
          consola.debug('Loaded channel state:', 'channel=', channel, 'projectPath=', channelState.projectPath);
        }
      }
    } catch (error) {
      consola.warn('Failed to load sessions state:', error);
    }
  }

  /**
   * Save state to file for persistence
   */
  private saveState(): void {
    try {
      const state: SessionsState = {
        channels: Object.fromEntries(this.userStates),
        projectSessions: Object.fromEntries(this.projectSessions),
      };
      writeFileSync(SESSIONS_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
      consola.warn('Failed to save sessions state:', error);
    }
  }

  /**
   * Get or resolve session ID for a project
   * Priority: 1. state.sessionId, 2. projectSessions map, 3. latest from Claude's sessions-index
   */
  private async resolveSessionId(
    projectPath: string,
    stateSessionId?: string
  ): Promise<string | undefined> {
    // 1. Use explicit session from state
    if (stateSessionId) {
      return stateSessionId;
    }

    // 2. Check project sessions map (persisted)
    const savedSession = this.projectSessions.get(projectPath);
    if (savedSession) {
      consola.info(`Found saved session for project: ${savedSession.slice(0, 8)}...`);
      return savedSession;
    }

    // 3. Try to get latest session from Claude's history
    const sessions = await this.claudeService.getSessions(projectPath);
    if (sessions.length > 0) {
      const latestSession = sessions[0].sessionId;
      consola.info(`Resuming latest Claude session: ${latestSession.slice(0, 8)}...`);
      // Save for future use
      this.projectSessions.set(projectPath, latestSession);
      this.saveState();
      return latestSession;
    }

    return undefined;
  }

  getChannelIds(): string[] {
    return [...this.userStates.keys()];
  }

  async handleMessage(message: IMMessage, adapter: IMAdapter): Promise<void> {
    const { text, context } = message;
    const command = text.trim().toLowerCase();

    consola.info(`[handleMessage] text="${text}" command="${command}" channel=${context.channelId}`);

    // Handle commands
    if (command === 'help' || command === '/help') {
      consola.info('[handleMessage] -> help');
      await this.sendHelp(adapter, context);
      return;
    }

    if (command === '/projects' || command === 'projects') {
      consola.info('[handleMessage] -> projects');
      await this.sendProjectList(adapter, context);
      return;
    }

    if (command === '/status' || command === 'status') {
      consola.info('[handleMessage] -> status');
      await this.sendStatus(adapter, context);
      return;
    }

    if (command === '/project' || command === 'project') {
      consola.info('[handleMessage] -> showProjectSelector');
      await this.showProjectSelector(adapter, context);
      return;
    }

    if (command.startsWith('/project ') || command.startsWith('project ')) {
      const projectName = command.startsWith('/') ? text.slice(9).trim() : text.slice(8).trim();
      consola.info(`[handleMessage] -> selectProject: ${projectName}`);
      await this.selectProject(adapter, context, projectName);
      return;
    }

    if (command.startsWith('/session ') || command.startsWith('session ')) {
      const sessionId = command.startsWith('/') ? text.slice(9).trim() : text.slice(8).trim();
      consola.info(`[handleMessage] -> selectSession: ${sessionId}`);
      await this.selectSession(adapter, context, sessionId);
      return;
    }

    if (command === '/stop' || command === 'stop') {
      consola.info('[handleMessage] -> stop');
      await this.handleStopExecution(adapter, context);
      return;
    }

    if (command === '/clear' || command === 'clear') {
      consola.info('[handleMessage] -> clear');
      await this.handleClearSession(adapter, context);
      return;
    }

    // Default: treat as prompt for Claude
    consola.info('[handleMessage] -> handlePrompt');
    await this.handlePrompt(adapter, context, text);
  }

  /**
   * Handle audio message - transcribe and process as text
   */
  async handleAudioMessage(message: IMAudioMessage, adapter: IMAdapter): Promise<void> {
    const { audioBuffer, mimeType, context } = message;

    consola.info(`Received audio message: ${mimeType}, ${audioBuffer.length} bytes`);

    // Check if whisper is available
    const whisperAvailable = await this.whisperService.isAvailable();
    if (!whisperAvailable) {
      await adapter.sendMessage(
        context.channelId,
        '语音转文字服务不可用。请检查 whisper-cli 是否已安装。'
      );
      return;
    }

    // Send processing message (directly to channel, not thread)
    const messageTs = await adapter.sendMessage(context.channelId, '🎤 正在转写语音...');

    try {
      // Transcribe audio
      const text = await this.whisperService.transcribe(audioBuffer);

      if (!text || text.trim() === '') {
        await adapter.updateMessage(context.channelId, messageTs, '❌ 无法识别语音内容');
        return;
      }

      consola.info(`Transcribed: ${text.slice(0, 100)}...`);

      // Update message with transcription
      await adapter.updateMessage(
        context.channelId,
        messageTs,
        `🎤 _"${text}"_\n\n🔄 Processing...`
      );

      // Process as normal text message
      await this.handlePromptWithMessage(adapter, context, text, messageTs);
    } catch (error) {
      consola.error('Transcription failed:', error);
      await adapter.updateMessage(
        context.channelId,
        messageTs,
        `❌ 语音转写失败: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle prompt with existing message (for audio transcription)
   */
  private async handlePromptWithMessage(
    adapter: IMAdapter,
    context: MessageContext,
    prompt: string,
    messageTs: string
  ): Promise<void> {
    // Ensure state exists for this channel
    let state = this.userStates.get(context.channelId);
    if (!state) {
      state = {};
      this.userStates.set(context.channelId, state);
    }

    const projectDir = state.projectPath || this.configManager.get<string>('projectDir');

    if (!projectDir) {
      // No project selected - show project selection
      const projects = await this.claudeService.getProjects();

      if (projects.length === 0) {
        await adapter.updateMessage(
          context.channelId,
          messageTs,
          '没有找到 Claude Code 项目。请先在项目目录中使用 Claude Code。'
        );
        return;
      }

      // Store pending prompt
      state.pendingPrompt = prompt;

      // Show project selection
      if (adapter.sendProjectSelectionCard) {
        await adapter.updateMessage(context.channelId, messageTs, `🎤 _"${prompt}"_`);
        await adapter.sendProjectSelectionCard(
          context.channelId,
          projects.map((p) => ({ name: p.name, path: p.path })),
          prompt
        );
      }
      return;
    }

    // Resolve session ID
    const sessionId = await this.resolveSessionId(projectDir, state.sessionId);

    // Set up execution tracking early so /stop can work during setup phase
    const execution = { abort: () => {}, messageTs, aborted: false };
    this.activeExecutions.set(context.channelId, execution);
    consola.debug(`Execution started (audio): channelId=${context.channelId}, messageTs=${messageTs}`);

    const allowedTools = this.configManager.get<string[]>('permissions.allowedTools') || [];
    const permissionMode = this.configManager.get<string>('claude.permissionMode') || 'acceptEdits';

    let currentOutput = `🎤 _"${prompt}"_\n\n`;
    let isProcessing = true;
    const processingIndicator = '\n\n_⏳ Claude is still working..._';
    const processedMessageIds = new Set<string>();

    interface FileChange {
      file: string;
      tool: string;
      input: Record<string, unknown>;
    }
    const fileChanges: FileChange[] = [];

    const updateWithIndicator = async (content: string) => {
      // Skip updates if execution was aborted
      if (execution.aborted) return;
      const displayContent = isProcessing ? content + processingIndicator : content;
      await this.updateMessageThrottled(adapter, context.channelId, messageTs, displayContent);
    };

    // Check if already aborted before starting Claude
    if (execution.aborted) {
      this.activeExecutions.delete(context.channelId);
      return;
    }

    try {
      const { promise, abort } = this.claudeService.execute(projectDir, prompt, {
        sessionId,
        allowedTools,
        permissionMode: permissionMode as 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
        outputFormat: 'stream-json',
        onChunk: async (chunk) => {
          const messageId = chunk.uuid || chunk.message?.id;
          if (messageId && processedMessageIds.has(messageId)) return;
          if (messageId) processedMessageIds.add(messageId);

          if (chunk.type === 'assistant' && chunk.message?.content) {
            for (const block of chunk.message.content) {
              if (block.type === 'text' && block.text) {
                currentOutput += block.text;
              } else if (block.type === 'tool_use' && block.name && block.input) {
                if (block.name === 'Edit' || block.name === 'Write') {
                  const filePath = block.input.file_path as string;
                  if (filePath) {
                    fileChanges.push({ file: filePath, tool: block.name, input: block.input });
                  }
                }
              }
            }
            await updateWithIndicator(currentOutput);
          } else if (chunk.type === 'result') {
            isProcessing = false;
          }
        },
      });

      // Update the abort function now that we have the real one
      execution.abort = abort;

      // If aborted while setting up, abort immediately
      if (execution.aborted) {
        abort();
        this.activeExecutions.delete(context.channelId);
        return;
      }

      const result = await promise;
      this.activeExecutions.delete(context.channelId);
      consola.debug(`Execution completed: channelId=${context.channelId}`);

      // If aborted, don't process further (message already updated by handleStopExecution)
      if (execution.aborted || !result) return;

      isProcessing = false;

      if (result.session_id) {
        state.sessionId = result.session_id;
        state.projectPath = projectDir;
        this.userStates.set(context.channelId, state);
        this.projectSessions.set(projectDir, result.session_id);
        this.saveState();
      }

      const cost = result.total_cost_usd || result.cost_usd;
      if (cost) {
        currentOutput += `\n\n_Cost: $${cost.toFixed(4)}_`;
      }

      await adapter.updateMessage(
        context.channelId,
        messageTs,
        this.truncateForSlack(currentOutput)
      );

      if (fileChanges.length > 0) {
        await this.showFileChanges(adapter, context.channelId, messageTs, fileChanges);
      }
    } catch (error) {
      this.activeExecutions.delete(context.channelId);
      consola.debug(`Execution errored: channelId=${context.channelId}`);
      consola.error('Error executing Claude:', error);
      await adapter.updateMessage(
        context.channelId,
        messageTs,
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async handleInteraction(
    action: string,
    value: string,
    context: MessageContext,
    adapter: IMAdapter
  ): Promise<void> {
    consola.debug(`Interaction: ${action} = ${value}`);

    if (action === 'select_project') {
      // Select project and execute pending prompt if exists
      await this.selectProjectAndExecute(adapter, context, value);
    } else if (action === 'show_project_selector') {
      // Show project selection card (from /project slash command)
      await this.showProjectSelector(adapter, context);
    } else if (action === 'select_session') {
      await this.selectSession(adapter, context, value);
    } else if (action === 'new_session') {
      const state = this.userStates.get(context.channelId);
      if (state) {
        state.sessionId = undefined;
        // Clear project session so it won't auto-resume
        if (state.projectPath) {
          this.projectSessions.delete(state.projectPath);
        }
        this.saveState();
      }
      await adapter.sendMessage(context.channelId, '✅ Next message will start a new session.');
    } else if (action === 'permission_approve') {
      // Handle permission approval
      await this.handlePermissionResponse(adapter, context, value, true);
    } else if (action === 'permission_deny') {
      // Handle permission denial
      await this.handlePermissionResponse(adapter, context, value, false);
    } else if (action === 'retry_with_permissions') {
      // Retry with full permissions
      await this.handleRetryWithPermissions(adapter, context, value);
    } else if (action === 'cancel_retry') {
      // Cancel retry - just remove from pending
      this.pendingRetries.delete(value);
      await adapter.sendMessage(context.channelId, '❌ Retry cancelled.');
    } else if (action === 'stop_execution') {
      // Stop current Claude execution
      await this.handleStopExecution(adapter, context);
    } else if (action === 'clear_session') {
      // Clear session and start fresh
      await this.handleClearSession(adapter, context);
    }
  }

  /**
   * Stop the current Claude execution for this channel
   */
  private async handleStopExecution(adapter: IMAdapter, context: MessageContext): Promise<void> {
    consola.debug(`handleStopExecution called: channelId=${context.channelId}`);
    consola.debug(`Active executions keys: [${Array.from(this.activeExecutions.keys()).join(', ')}]`);

    const execution = this.activeExecutions.get(context.channelId);

    if (!execution) {
      // Provide more helpful debug info
      const activeCount = this.activeExecutions.size;
      const debugMsg = activeCount > 0
        ? `当前有 ${activeCount} 个任务在运行，但不在此频道。`
        : '没有正在运行的任务。';
      consola.warn(`No execution found for channel ${context.channelId}. ${debugMsg}`);
      await adapter.sendMessage(context.channelId, `${debugMsg}`);
      return;
    }

    // Mark as aborted first to prevent further message updates
    execution.aborted = true;
    // Abort the execution
    execution.abort();

    // Update the message to show it was stopped
    try {
      await adapter.updateMessage(context.channelId, execution.messageTs, '🛑 已停止');
    } catch {
      // If update fails, send a new message
      await adapter.sendMessage(context.channelId, '🛑 已停止当前任务。');
    }

    consola.info(`Execution stopped for channel ${context.channelId}`);
  }

  /**
   * Clear session - start fresh conversation (like /clear in Claude Code)
   */
  private async handleClearSession(adapter: IMAdapter, context: MessageContext): Promise<void> {
    const state = this.userStates.get(context.channelId);

    if (!state?.projectPath) {
      await adapter.sendMessage(context.channelId, '当前没有选择项目，无需清除。');
      return;
    }

    const projectPath = state.projectPath;

    // Clear session ID from state
    state.sessionId = undefined;

    // Clear from project sessions mapping
    this.projectSessions.delete(projectPath);

    // Save state
    this.saveState();

    await adapter.sendMessage(
      context.channelId,
      `🧹 已清除会话。下一条消息将在 \`${projectPath}\` 中开始新的对话。`
    );

    consola.info(`Session cleared for channel ${context.channelId}, project ${projectPath}`);
  }

  private async sendHelp(adapter: IMAdapter, context: MessageContext): Promise<void> {
    const help = `*Heimerdinger - Claude Code Bridge*

Available commands:
• \`project\` - Select a project (interactive)
• \`project <name>\` - Select a project by name
• \`projects\` - List available projects
• \`session <id>\` - Resume a session
• \`stop\` - Stop current execution
• \`clear\` - Clear session
• \`status\` - Show current status
• \`help\` - Show this help

Or just send a message to start coding with Claude!`;

    await adapter.sendMessage(context.channelId, help);
  }

  private async sendProjectList(adapter: IMAdapter, context: MessageContext): Promise<void> {
    const projects = await this.claudeService.getProjects();

    if (projects.length === 0) {
      await adapter.sendMessage(
        context.channelId,
        'No Claude Code projects found. Start using Claude Code in a project directory first.'
      );
      return;
    }

    const projectList = projects.map((p, i) => `${i + 1}. \`${p.name}\` - ${p.path}`).join('\n');

    const message = `*Available Projects:*\n\n${projectList}\n\nUse \`/project <name>\` to select one.`;

    await adapter.sendMessage(context.channelId, message);
  }

  private async sendStatus(adapter: IMAdapter, context: MessageContext): Promise<void> {
    const state = this.userStates.get(context.channelId);
    const projectDir = this.configManager.get<string>('projectDir');

    let status = '*Current Status:*\n\n';

    if (state?.projectPath) {
      status += `Project: \`${state.projectPath}\`\n`;
    } else if (projectDir) {
      status += `Default Project: \`${projectDir}\`\n`;
    } else {
      status += 'Project: (not selected)\n';
    }

    if (state?.sessionId) {
      status += `Session: \`${state.sessionId.slice(0, 8)}...\`\n`;
    } else {
      status += 'Session: (new session)\n';
    }

    await adapter.sendMessage(context.channelId, status);
  }

  private async selectProject(
    adapter: IMAdapter,
    context: MessageContext,
    projectName: string
  ): Promise<void> {
    const projects = await this.claudeService.getProjects();
    const project = projects.find(
      (p) => p.name.toLowerCase() === projectName.toLowerCase() || p.path === projectName
    );

    if (!project) {
      await adapter.sendMessage(
        context.channelId,
        `Project "${projectName}" not found. Use \`/projects\` to see available projects.`
      );
      return;
    }

    // Update state - keep sessionId undefined, resolveSessionId will find the right one
    const state = this.userStates.get(context.channelId) || {};
    state.projectPath = project.path;
    state.sessionId = undefined; // Will be resolved from projectSessions or Claude's history
    this.userStates.set(context.channelId, state);
    this.saveState();

    // Get sessions for this project
    const sessions = await this.claudeService.getSessions(project.path);
    const savedSessionId = this.projectSessions.get(project.path);

    let message = `Selected project: \`${project.name}\`\n`;

    if (savedSessionId) {
      const savedSession = sessions.find((s) => s.sessionId === savedSessionId);
      if (savedSession) {
        message += `\n*Will resume session:* \`${savedSessionId.slice(0, 8)}...\`\n`;
        message += `_${savedSession.summary || savedSession.firstPrompt.slice(0, 50)}..._\n`;
      }
    } else if (sessions.length > 0) {
      message += `\n*Will resume latest session:* \`${sessions[0].sessionId.slice(0, 8)}...\`\n`;
      message += `_${sessions[0].summary || sessions[0].firstPrompt.slice(0, 50)}..._\n`;
    }

    if (sessions.length > 0) {
      message += '\n*Other sessions:*\n';
      for (const session of sessions.slice(0, 5)) {
        const date = new Date(session.modified).toLocaleDateString();
        const summary = session.summary || `${session.firstPrompt.slice(0, 40)}...`;
        const marker = session.sessionId === savedSessionId ? ' ✓' : '';
        message += `• \`${session.sessionId.slice(0, 8)}...\`${marker} - ${summary} (${date})\n`;
      }
      message += '\nUse `/session <id>` to switch, or `/session new` for a fresh start.';
    } else {
      message += '\nNo previous sessions. Send a message to start coding!';
    }

    await adapter.sendMessage(context.channelId, message);
  }

  /**
   * Select project from interactive card and execute pending prompt
   */
  private async selectProjectAndExecute(
    adapter: IMAdapter,
    context: MessageContext,
    projectPath: string
  ): Promise<void> {
    consola.debug('selectProjectAndExecute called:', 'channelId=', context.channelId, 'projectPath=', projectPath);

    // Update state with selected project
    let state = this.userStates.get(context.channelId);
    if (!state) {
      state = {};
      this.userStates.set(context.channelId, state);
    }

    state.projectPath = projectPath;
    state.sessionId = undefined; // Will be resolved from projectSessions or Claude's history
    this.saveState();

    // Persist project selection to config
    this.configManager.set('projectDir', projectPath);

    // Display the path directly (it's more useful than just the name)
    const displayPath = projectPath || '(unknown)';

    await adapter.sendMessage(context.channelId, `✅ Selected project: \`${displayPath}\``);

    // Execute pending prompt if exists
    const pendingPrompt = state.pendingPrompt;
    if (pendingPrompt) {
      state.pendingPrompt = undefined; // Clear pending prompt
      await this.handlePrompt(adapter, context, pendingPrompt);
    }
  }

  /**
   * Show project selection card (triggered by /project slash command)
   */
  private async showProjectSelector(adapter: IMAdapter, context: MessageContext): Promise<void> {
    const projects = await this.claudeService.getProjects();

    if (projects.length === 0) {
      await adapter.sendMessage(
        context.channelId,
        'No Claude Code projects found. Please use Claude Code in a project directory first.'
      );
      return;
    }

    // Get current project for display
    const state = this.userStates.get(context.channelId);
    const currentProject = state?.projectPath || this.configManager.get<string>('projectDir');

    // Use interactive card if available
    if (adapter.sendProjectSelectionCard) {
      await adapter.sendProjectSelectionCard(
        context.channelId,
        projects.map((p) => ({ name: p.name, path: p.path })),
        currentProject ? `Current: ${currentProject}` : 'Select a project'
      );
    } else {
      // Fallback to text message
      const projectList = projects
        .slice(0, 10)
        .map((p) => `• \`${p.path}\``)
        .join('\n');
      await adapter.sendMessage(
        context.channelId,
        `*Available Projects:*\n${projectList}\n\nUse \`/project <path>\` to select one.`
      );
    }
  }

  private async selectSession(
    adapter: IMAdapter,
    context: MessageContext,
    sessionId: string
  ): Promise<void> {
    const state = this.userStates.get(context.channelId);

    if (!state?.projectPath) {
      await adapter.sendMessage(
        context.channelId,
        'Please select a project first with `/project <name>`'
      );
      return;
    }

    // Handle "new" to start a fresh session
    if (sessionId.toLowerCase() === 'new') {
      state.sessionId = undefined;
      // Remove from project sessions so it won't auto-resume
      this.projectSessions.delete(state.projectPath);
      this.userStates.set(context.channelId, state);
      this.saveState();
      await adapter.sendMessage(context.channelId, '✅ Next message will start a new session.');
      return;
    }

    const sessions = await this.claudeService.getSessions(state.projectPath);
    const session = sessions.find((s) => s.sessionId.startsWith(sessionId));

    if (!session) {
      await adapter.sendMessage(
        context.channelId,
        `Session "${sessionId}" not found in current project.`
      );
      return;
    }

    state.sessionId = session.sessionId;
    this.userStates.set(context.channelId, state);
    // Also save to project mapping
    this.projectSessions.set(state.projectPath, session.sessionId);
    this.saveState();

    await adapter.sendMessage(
      context.channelId,
      `✅ Switched to session: ${session.summary || session.firstPrompt.slice(0, 50)}...`
    );
  }

  private async handlePrompt(
    adapter: IMAdapter,
    context: MessageContext,
    prompt: string
  ): Promise<void> {
    consola.debug('handlePrompt called with prompt:', prompt);

    // Ensure state exists for this channel
    let state = this.userStates.get(context.channelId);
    const stateExisted = !!state;
    if (!state) {
      state = {};
      this.userStates.set(context.channelId, state);
    }

    const configProjectDir = this.configManager.get<string>('projectDir');
    const projectDir = state.projectPath || configProjectDir;
    consola.debug(
      'handlePrompt debug:',
      'channelId=', context.channelId,
      'stateExisted=', stateExisted,
      'state.projectPath=', state.projectPath,
      'configProjectDir=', configProjectDir,
      'projectDir=', projectDir,
      'sessionId=', state.sessionId
    );

    if (!projectDir) {
      // No project selected - show project selection card if adapter supports it
      const projects = await this.claudeService.getProjects();

      if (projects.length === 0) {
        await adapter.sendMessage(
          context.channelId,
          'No Claude Code projects found. Please use Claude Code in a project directory first.'
        );
        return;
      }

      // Store pending prompt
      if (!state) {
        state = {};
        this.userStates.set(context.channelId, state);
      }
      state.pendingPrompt = prompt;

      // Use interactive card if available
      if (adapter.sendProjectSelectionCard) {
        await adapter.sendProjectSelectionCard(
          context.channelId,
          projects.map((p) => ({ name: p.name, path: p.path })),
          prompt
        );
      } else {
        // Fallback to text message
        const projectList = projects
          .slice(0, 10)
          .map((p) => `• \`${p.name}\``)
          .join('\n');
        await adapter.sendMessage(
          context.channelId,
          `Please select a project first:\n${projectList}\n\nUse \`/project <name>\` to select one.`
        );
      }
      return;
    }

    // Resolve session ID (from state, persisted mapping, or Claude's history)
    const sessionId = await this.resolveSessionId(projectDir, state.sessionId);

    // Send initial response
    const messageTs = await adapter.sendMessage(context.channelId, '🔄 Processing...');

    // Set up execution tracking early so /stop can work during setup phase
    const execution = { abort: () => {}, messageTs, aborted: false };
    this.activeExecutions.set(context.channelId, execution);
    consola.debug(`Execution started: channelId=${context.channelId}, messageTs=${messageTs}`);

    const allowedTools = this.configManager.get<string[]>('permissions.allowedTools') || [];
    const permissionMode = this.configManager.get<string>('claude.permissionMode') || 'acceptEdits';

    let currentOutput = '';
    let isProcessing = true;
    const processingIndicator = '\n\n_⏳ Claude is still working..._';
    const processedMessageIds = new Set<string>();

    // Track file modifications made by Claude in this execution
    interface FileChange {
      file: string;
      tool: string;
      input: Record<string, unknown>;
    }
    const fileChanges: FileChange[] = [];

    // Helper to update message with or without processing indicator
    const updateWithIndicator = async (content: string) => {
      // Skip updates if execution was aborted
      if (execution.aborted) return;
      const displayContent = isProcessing ? content + processingIndicator : content;
      await this.updateMessageThrottled(adapter, context.channelId, messageTs, displayContent);
    };

    // Check if already aborted before starting Claude
    if (execution.aborted) {
      this.activeExecutions.delete(context.channelId);
      return;
    }

    try {
      consola.debug('Executing Claude with projectDir:', projectDir, 'prompt:', prompt);
      const { promise, abort } = this.claudeService.execute(projectDir, prompt, {
        sessionId,
        allowedTools,
        permissionMode: permissionMode as 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
        outputFormat: 'stream-json',
        onChunk: async (chunk) => {
          consola.debug('Received chunk:', chunk.type, chunk.subtype || '');

          // Log permission denials if present
          if (chunk.permission_denials?.length) {
            consola.info(`Chunk has ${chunk.permission_denials.length} permission denials`);
          }

          // Skip already processed messages
          const messageId = chunk.uuid || chunk.message?.id;
          if (messageId && processedMessageIds.has(messageId)) {
            return;
          }
          if (messageId) {
            processedMessageIds.add(messageId);
          }

          if (chunk.type === 'assistant' && chunk.message?.content) {
            // Extract text and track tool_use from content blocks
            for (const block of chunk.message.content) {
              if (block.type === 'text' && block.text) {
                currentOutput += block.text;
              } else if (block.type === 'tool_use' && block.name && block.input) {
                // Track file modifications (Edit, Write tools)
                if (block.name === 'Edit' || block.name === 'Write') {
                  const filePath = block.input.file_path as string;
                  if (filePath) {
                    fileChanges.push({
                      file: filePath,
                      tool: block.name,
                      input: block.input,
                    });
                    consola.info(`Tracked ${block.name} on ${filePath}`);
                  }
                }
              }
            }
            await updateWithIndicator(currentOutput);
          } else if (chunk.type === 'result') {
            // Mark processing as done
            isProcessing = false;
            consola.debug(
              'Result chunk received:',
              JSON.stringify({
                session_id: chunk.session_id,
                has_denials: !!chunk.permission_denials?.length,
                denials_count: chunk.permission_denials?.length || 0,
                cost: chunk.total_cost_usd || chunk.cost_usd,
              })
            );
          }
        },
      });

      // Update the abort function now that we have the real one
      execution.abort = abort;

      // If aborted while setting up, abort immediately
      if (execution.aborted) {
        abort();
        this.activeExecutions.delete(context.channelId);
        return;
      }

      // Wait for result
      const result = await promise;

      // Clean up active execution
      this.activeExecutions.delete(context.channelId);

      // If aborted, don't process further (message already updated by handleStopExecution)
      if (execution.aborted || !result) {
        return;
      }

      // Mark processing as complete
      isProcessing = false;

      // Update with final result
      if (result) {
        // Log result info
        consola.info('Claude result:', {
          session_id: result.session_id?.slice(0, 8),
          has_denials: !!result.permission_denials?.length,
          denials_count: result.permission_denials?.length || 0,
          cost: result.total_cost_usd || result.cost_usd,
        });

        // Save session ID for context continuity
        if (result.session_id) {
          consola.info(`Session saved: ${result.session_id.slice(0, 8)}...`);
          state.sessionId = result.session_id;
          state.projectPath = projectDir; // Ensure project is saved
          this.userStates.set(context.channelId, state);
          // Also save to project mapping for cross-channel/restart persistence
          this.projectSessions.set(projectDir, result.session_id);
          this.saveState();
        }

        // Check for permission denials from Claude result
        const hasPermissionDenials =
          result.permission_denials && result.permission_denials.length > 0;

        if (hasPermissionDenials) {
          const denials = result
            .permission_denials!.map(
              (d) => `• \`${d.tool_name}\`: ${JSON.stringify(d.tool_input).slice(0, 80)}...`
            )
            .join('\n');

          currentOutput += `\n\n⚠️ *Some operations were blocked:*\n${denials}`;
        }

        const cost = result.total_cost_usd || result.cost_usd;
        if (cost) {
          currentOutput += `\n\n_Cost: $${cost.toFixed(4)}_`;
        }

        // Final update without processing indicator
        const finalContent = this.truncateForSlack(currentOutput || 'Done.');
        try {
          await adapter.updateMessage(context.channelId, messageTs, finalContent);
        } catch (updateError) {
          consola.warn('Failed to update final message, sending as new:', updateError);
          try {
            await adapter.sendMessage(context.channelId, finalContent);
          } catch {
            // Give up
          }
        }

        // If there were permission denials, offer retry button
        if (hasPermissionDenials) {
          consola.info(
            `Sending retry card for ${result.permission_denials!.length} permission denials`
          );
          try {
            await this.sendRetryWithPermissionsCard(
              adapter,
              context,
              prompt,
              projectDir,
              result.permission_denials!
            );
          } catch (cardError: unknown) {
            const errMsg = cardError instanceof Error ? cardError.message : String(cardError);
            consola.error('Failed to send retry card:', errMsg);
            // If it's a Slack scope error, notify the user
            if (errMsg.includes('missing_scope')) {
              await adapter.sendMessage(
                context.channelId,
                '⚠️ 无法发送权限请求卡片：Slack App 缺少必要权限。请在 Slack App 设置中添加相应的 OAuth Scopes。'
              );
            }
          }
        }
      }

      // Show file changes made by Claude in this execution
      if (fileChanges.length > 0) {
        await this.showFileChanges(adapter, context.channelId, messageTs, fileChanges);
      }
    } catch (error) {
      // Clean up active execution on error
      this.activeExecutions.delete(context.channelId);
      consola.error('Error executing Claude:', error);
      consola.error('Error details:', error instanceof Error ? error.stack : String(error));
      try {
        await adapter.updateMessage(
          context.channelId,
          messageTs,
          `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      } catch {
        // If update fails, try sending a new message
        try {
          await adapter.sendMessage(
            context.channelId,
            `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        } catch {
          // Give up
        }
      }
    }
  }

  /**
   * Show file changes made by Claude in this execution
   */
  private async showFileChanges(
    adapter: IMAdapter,
    channel: string,
    threadTs: string,
    fileChanges: Array<{ file: string; tool: string; input: Record<string, unknown> }>
  ): Promise<void> {
    try {
      consola.info(`Showing ${fileChanges.length} file change(s) in thread`);

      // Group changes by file
      const changesByFile = new Map<
        string,
        Array<{ tool: string; input: Record<string, unknown> }>
      >();
      for (const change of fileChanges) {
        const existing = changesByFile.get(change.file) || [];
        existing.push({ tool: change.tool, input: change.input });
        changesByFile.set(change.file, existing);
      }

      // Build diff content for each file
      for (const [file, changes] of changesByFile) {
        let diffContent = '';
        let isNewFile = false;

        for (const change of changes) {
          if (change.tool === 'Edit') {
            const oldStr = (change.input.old_string as string) || '';
            const newStr = (change.input.new_string as string) || '';
            // Build unified diff format
            const oldLines = oldStr
              .split('\n')
              .map((l) => `- ${l}`)
              .join('\n');
            const newLines = newStr
              .split('\n')
              .map((l) => `+ ${l}`)
              .join('\n');
            diffContent += `${oldLines}\n${newLines}\n`;
          } else if (change.tool === 'Write') {
            isNewFile = true;
            const content = (change.input.content as string) || '';
            diffContent = content
              .split('\n')
              .map((l) => `+ ${l}`)
              .join('\n');
          }
        }

        // Get filename from path
        const fileName = file.split('/').pop() || 'changes';
        const title = isNewFile ? `New: ${fileName}` : `Modified: ${fileName}`;

        // Upload as snippet with diff format for syntax highlighting
        if (adapter.uploadSnippet) {
          try {
            await adapter.uploadSnippet(channel, diffContent, {
              filename: `${fileName}.diff`,
              title,
              threadTs,
            });
            continue; // Success, move to next file
          } catch (uploadError) {
            consola.warn(
              'Snippet upload failed:',
              uploadError instanceof Error ? uploadError.message : uploadError
            );
          }
        }

        // Fallback: send as regular message
        const truncatedDiff =
          diffContent.length > 2900
            ? `${diffContent.slice(0, 2900)}\n... (truncated)`
            : diffContent;
        await adapter.sendMessage(
          channel,
          `📝 *${file}*\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
          threadTs
        );
      }
    } catch (error) {
      consola.error('Failed to show file changes:', error);
    }
  }

  private async handlePermissionResponse(
    adapter: IMAdapter,
    context: MessageContext,
    requestId: string,
    approved: boolean
  ): Promise<void> {
    // TODO: Implement permission approval flow
    await adapter.sendMessage(
      context.channelId,
      approved ? '✅ Permission granted' : '❌ Permission denied'
    );
  }

  /**
   * Send a card offering to retry with full permissions
   */
  private async sendRetryWithPermissionsCard(
    adapter: IMAdapter,
    context: MessageContext,
    prompt: string,
    projectDir: string,
    denials: PermissionDenial[]
  ): Promise<void> {
    // Generate a unique retry ID
    const retryId = `retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Store retry info
    const state = this.userStates.get(context.channelId);
    this.pendingRetries.set(retryId, {
      prompt,
      projectDir,
      channelId: context.channelId,
      sessionId: state?.sessionId,
    });

    // Create summary of blocked operations
    const blockedOps = denials
      .slice(0, 5)
      .map((d) => `• \`${d.tool_name}\``)
      .join('\n');
    const moreCount = denials.length > 5 ? `\n• _...and ${denials.length - 5} more_` : '';

    // Send interactive card if adapter supports it
    if (adapter.sendInteractiveMessage) {
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔒 *Permission required*\n\nThe following operations were blocked:\n${blockedOps}${moreCount}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '✅ Authorize & Retry',
              },
              style: 'primary',
              action_id: 'retry_with_permissions',
              value: retryId,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '❌ Cancel',
              },
              action_id: 'cancel_retry',
              value: retryId,
            },
          ],
        },
      ];

      // Send to main channel, not thread, so user can easily see and respond
      await adapter.sendInteractiveMessage!(context.channelId, 'Permission required', blocks);
    } else {
      // Fallback message
      await adapter.sendMessage(
        context.channelId,
        `🔒 Some operations were blocked. Re-run with \`/retry ${retryId}\` to authorize.`,
        context.threadTs
      );
    }
  }

  /**
   * Handle retry with full permissions
   */
  private async handleRetryWithPermissions(
    adapter: IMAdapter,
    context: MessageContext,
    retryId: string
  ): Promise<void> {
    const retryInfo = this.pendingRetries.get(retryId);

    if (!retryInfo) {
      await adapter.sendMessage(context.channelId, '❌ Retry request expired or not found.');
      return;
    }

    // Remove from pending
    this.pendingRetries.delete(retryId);

    // Acknowledge
    await adapter.sendMessage(context.channelId, '🔓 Retrying with full permissions...');

    // Re-execute with bypassPermissions mode
    await this.executeWithPermissions(adapter, context, retryInfo);
  }

  /**
   * Execute prompt with bypassPermissions mode
   */
  private async executeWithPermissions(
    adapter: IMAdapter,
    context: MessageContext,
    retryInfo: PendingRetry
  ): Promise<void> {
    const { prompt, projectDir, sessionId } = retryInfo;

    // Send initial response
    const messageTs = await adapter.sendMessage(
      context.channelId,
      '🔄 Processing with elevated permissions...'
    );

    // Set up execution tracking early so /stop can work during setup phase
    const execution = { abort: () => {}, messageTs, aborted: false };
    this.activeExecutions.set(context.channelId, execution);
    consola.debug(`Execution started (retry): channelId=${context.channelId}, messageTs=${messageTs}`);

    let currentOutput = '';
    let isProcessing = true;
    const processingIndicator = '\n\n_⏳ Claude is still working..._';
    const processedMessageIds = new Set<string>();

    // Track file modifications
    interface FileChange {
      file: string;
      tool: string;
      input: Record<string, unknown>;
    }
    const fileChanges: FileChange[] = [];

    const updateWithIndicator = async (content: string) => {
      // Skip updates if execution was aborted
      if (execution.aborted) return;
      const displayContent = isProcessing ? content + processingIndicator : content;
      await this.updateMessageThrottled(adapter, context.channelId, messageTs, displayContent);
    };

    // Check if already aborted before starting Claude
    if (execution.aborted) {
      this.activeExecutions.delete(context.channelId);
      return;
    }

    try {
      const { promise, abort } = this.claudeService.execute(projectDir, prompt, {
        sessionId,
        permissionMode: 'bypassPermissions', // Full permissions
        outputFormat: 'stream-json',
        onChunk: async (chunk) => {
          const messageId = chunk.uuid || chunk.message?.id;
          if (messageId && processedMessageIds.has(messageId)) return;
          if (messageId) processedMessageIds.add(messageId);

          if (chunk.type === 'assistant' && chunk.message?.content) {
            for (const block of chunk.message.content) {
              if (block.type === 'text' && block.text) {
                currentOutput += block.text;
              } else if (block.type === 'tool_use' && block.name && block.input) {
                // Track file modifications (Edit, Write tools)
                if (block.name === 'Edit' || block.name === 'Write') {
                  const filePath = block.input.file_path as string;
                  if (filePath) {
                    fileChanges.push({
                      file: filePath,
                      tool: block.name,
                      input: block.input,
                    });
                    consola.info(`Tracked ${block.name} on ${filePath}`);
                  }
                }
              }
            }
            await updateWithIndicator(currentOutput);
          } else if (chunk.type === 'result') {
            isProcessing = false;
          }
        },
      });

      // Update the abort function now that we have the real one
      execution.abort = abort;

      // If aborted while setting up, abort immediately
      if (execution.aborted) {
        abort();
        this.activeExecutions.delete(context.channelId);
        return;
      }

      // Wait for result
      const result = await promise;

      // Clean up active execution
      this.activeExecutions.delete(context.channelId);
      consola.debug(`Execution completed (retry): channelId=${context.channelId}`);

      // If aborted, don't process further (message already updated by handleStopExecution)
      if (execution.aborted || !result) {
        return;
      }

      isProcessing = false;

      // Update session if needed
      if (result?.session_id) {
        const state = this.userStates.get(context.channelId) || {};
        state.sessionId = result.session_id;
        state.projectPath = projectDir;
        this.userStates.set(context.channelId, state);
        this.projectSessions.set(projectDir, result.session_id);
        this.saveState();
      }

      // Add cost info
      const cost = result?.total_cost_usd || result?.cost_usd;
      if (cost) {
        currentOutput += `\n\n_Cost: $${cost.toFixed(4)}_`;
      }

      // Final update
      await adapter.updateMessage(
        context.channelId,
        messageTs,
        this.truncateForSlack(currentOutput || 'Done.')
      );

      // Show file changes in thread
      if (fileChanges.length > 0) {
        await this.showFileChanges(adapter, context.channelId, messageTs, fileChanges);
      }
    } catch (error) {
      // Clean up active execution on error
      this.activeExecutions.delete(context.channelId);
      consola.debug(`Execution errored (retry): channelId=${context.channelId}`);
      consola.error('Error in retry execution:', error);
      await adapter.updateMessage(
        context.channelId,
        messageTs,
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Slack message limit - use byte length for safety with CJK characters
  // Official limit is 40000 characters, but CJK chars may count as multiple bytes
  private static readonly SLACK_MAX_BYTES = 38000;

  /**
   * Convert Markdown to Slack mrkdwn format
   * Markdown: **bold**, *italic*, [text](url), # header
   * Slack:    *bold*,  _italic_, <url|text>,   *header*
   */
  private markdownToSlack(content: string): string {
    try {
      // Preserve code blocks first (```...```)
      const codeBlocks: string[] = [];
      let result = content.replace(/```[\s\S]*?```/g, (match) => {
        codeBlocks.push(match);
        return `<<<CODE_BLOCK_${codeBlocks.length - 1}>>>`;
      });

      // Preserve inline code (`...`)
      const inlineCodes: string[] = [];
      result = result.replace(/`[^`\n]+`/g, (match) => {
        inlineCodes.push(match);
        return `<<<INLINE_CODE_${inlineCodes.length - 1}>>>`;
      });

      // Convert headers (# ## ### etc.) to bold
      result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

      // Convert bold: **text** or __text__ → *text* (non-greedy, single line)
      result = result.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
      result = result.replace(/__([^_\n]+)__/g, '*$1*');

      // Convert links: [text](url) → <url|text>
      result = result.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '<$2|$1>');

      // Convert Markdown tables to simple format (Slack doesn't support tables)
      // Remove table separator lines (|---|---|)
      result = result.replace(/^\|[-:\s|]+\|$/gm, '');
      // Convert table rows to bullet points
      result = result.replace(/^\|(.+)\|$/gm, (_, row) => {
        const cells = row.split('|').map((c: string) => c.trim()).filter((c: string) => c);
        if (cells.length >= 2) {
          return `• ${cells[0]}: ${cells.slice(1).join(' | ')}`;
        }
        return `• ${cells.join(' ')}`;
      });

      // Restore inline codes
      inlineCodes.forEach((code, i) => {
        result = result.replace(`<<<INLINE_CODE_${i}>>>`, code);
      });

      // Restore code blocks
      codeBlocks.forEach((block, i) => {
        result = result.replace(`<<<CODE_BLOCK_${i}>>>`, block);
      });

      return result;
    } catch (error) {
      consola.error('Markdown conversion failed:', error);
      return content; // Return original content if conversion fails
    }
  }

  /**
   * Get byte length of a string (for CJK characters)
   */
  private getByteLength(str: string): number {
    return Buffer.byteLength(str, 'utf8');
  }

  /**
   * Truncate string to fit within byte limit
   */
  private truncateToByteLimit(str: string, maxBytes: number): string {
    if (this.getByteLength(str) <= maxBytes) {
      return str;
    }
    // Binary search for the right length
    let low = 0;
    let high = str.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (this.getByteLength(str.slice(0, mid)) <= maxBytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return str.slice(0, low);
  }

  /**
   * Truncate message to fit Slack's limit
   */
  private truncateForSlack(content: string): string {
    // Convert Markdown to Slack format first
    const converted = this.markdownToSlack(content);
    const byteLength = this.getByteLength(converted);

    if (byteLength <= MessageProcessor.SLACK_MAX_BYTES) {
      return converted;
    }

    consola.warn(`Truncating message: ${byteLength} bytes (limit: ${MessageProcessor.SLACK_MAX_BYTES})`);
    // Leave room for truncation notice (~100 bytes for CJK)
    const truncated = this.truncateToByteLimit(converted, MessageProcessor.SLACK_MAX_BYTES - 100);
    return `${truncated}\n\n_⚠️ Message truncated (too long for Slack)_`;
  }

  // Throttle message updates to avoid rate limits (per message)
  private updateState = new Map<string, { lastUpdate: number; queue: string | null }>();

  private async updateMessageThrottled(
    adapter: IMAdapter,
    channel: string,
    messageTs: string,
    content: string
  ): Promise<void> {
    const key = `${channel}:${messageTs}`;
    const now = Date.now();
    const minInterval = 1000; // 1 second between updates

    let state = this.updateState.get(key);
    if (!state) {
      state = { lastUpdate: 0, queue: null };
      this.updateState.set(key, state);
    }

    if (now - state.lastUpdate < minInterval) {
      state.queue = content;
      return;
    }

    state.lastUpdate = now;
    state.queue = null;

    try {
      await adapter.updateMessage(channel, messageTs, this.truncateForSlack(content));
    } catch (error) {
      // Log but don't throw - message updates are best-effort
      consola.debug('Message update failed:', error);
    }

    // Process queued update after interval
    if (state.queue) {
      const queuedContent = state.queue;
      setTimeout(async () => {
        try {
          await adapter.updateMessage(channel, messageTs, this.truncateForSlack(queuedContent));
        } catch {
          // Ignore
        }
        // Clean up old state entries
        this.updateState.delete(key);
      }, minInterval);
    } else {
      // Clean up if no queue
      this.updateState.delete(key);
    }
  }
}
