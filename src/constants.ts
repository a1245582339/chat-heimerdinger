import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HeimerdingerConfig } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

export const APP_NAME = 'heimerdinger';
export const CLI_NAME = 'hmdg';
export const VERSION: string = pkg.version;

// Paths
export const HOME_DIR = homedir();
export const CONFIG_DIR = join(HOME_DIR, '.heimerdinger');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const PID_FILE = join(CONFIG_DIR, 'heimerdinger.pid');
export const LOG_DIR = join(CONFIG_DIR, 'logs');
export const LOG_FILE = join(LOG_DIR, 'app.log');
export const SESSIONS_STATE_FILE = join(CONFIG_DIR, 'sessions-state.json');

// Claude Code paths
export const CLAUDE_CONFIG_FILE = join(HOME_DIR, '.claude.json');
export const CLAUDE_DIR = join(HOME_DIR, '.claude');
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');

// Default configuration
export const DEFAULT_CONFIG: HeimerdingerConfig = {
  version: VERSION,
  server: {
    port: 3150,
    host: '0.0.0.0',
    daemon: true,
  },
  claude: {
    configPath: CLAUDE_CONFIG_FILE,
    includeThinking: true,
    defaultModel: 'sonnet',
    timeout: 300000, // 5 minutes
    permissionMode: 'acceptEdits', // Auto-accept edit operations
  },
  permissions: {
    allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    confirmTools: ['Edit', 'Write', 'Bash', 'NotebookEdit'],
    blockedPatterns: ['Bash(rm -rf*)', 'Bash(sudo*)', 'Bash(*credentials*)'],
    confirmTimeout: 60,
    timeoutAction: 'deny',
  },
  projectDir: '',
  adapters: {},
  activeAdapter: '',
  logging: {
    level: 'info',
    file: LOG_FILE,
  },
};

// Adapter names
export const SLACK_ADAPTER_NAME = 'slack';
export const FEISHU_ADAPTER_NAME = 'feishu';
