import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { consola } from 'consola';
import { CLAUDE_CONFIG_FILE, CLAUDE_PROJECTS_DIR } from '../constants';
import type {
  ClaudeProject,
  ClaudeSession,
  ClaudeSessionsIndex,
  ClaudeStreamChunk,
} from '../types';

export class ClaudeCodeService {
  private claudeConfigPath: string;
  private projectsDir: string;
  private claudeBinaryPath: string;

  constructor(claudeConfigPath: string = CLAUDE_CONFIG_FILE) {
    this.claudeConfigPath = claudeConfigPath;
    this.projectsDir = CLAUDE_PROJECTS_DIR;
    this.claudeBinaryPath = this.findClaudeBinary();
  }

  /**
   * Find the claude binary path
   */
  private findClaudeBinary(): string {
    try {
      // Try to find claude using which command
      const path = execSync('which claude', { encoding: 'utf-8' }).trim();
      if (path && existsSync(path)) {
        consola.debug('Found claude binary at:', path);
        return path;
      }
    } catch {
      // which command failed
    }

    // Common installation paths
    const commonPaths = [
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      `${process.env.HOME}/.local/bin/claude`,
      `${process.env.HOME}/.nvm/versions/node/${process.version}/bin/claude`,
    ];

    for (const p of commonPaths) {
      if (existsSync(p)) {
        consola.debug('Found claude binary at:', p);
        return p;
      }
    }

    // Fallback to 'claude' and hope PATH is set correctly
    consola.warn('Could not find claude binary, using "claude" and relying on PATH');
    return 'claude';
  }

  /**
   * Check if Claude Code is installed and configured
   */
  async isAvailable(): Promise<boolean> {
    return existsSync(this.claudeConfigPath);
  }

  /**
   * Get list of all projects from .claude/projects directory
   * This includes all working directories where Claude Code has been used
   */
  async getProjects(): Promise<ClaudeProject[]> {
    try {
      consola.debug('Looking for projects in:', this.projectsDir);
      if (!existsSync(this.projectsDir)) {
        consola.warn('Claude projects directory does not exist:', this.projectsDir);
        return [];
      }

      // Scan projects directory for all project folders
      const projectDirs = readdirSync(this.projectsDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      consola.debug(`Found ${projectDirs.length} project directories`);

      // Decode folder names back to paths and get project info
      const projects: ClaudeProject[] = [];

      for (const encodedPath of projectDirs) {
        const decodedPath = this.decodeProjectPath(encodedPath);

        // Check if path exists
        if (!existsSync(decodedPath)) {
          consola.debug(`Skipping project (path not found): ${encodedPath} -> ${decodedPath}`);
          continue;
        }

        // Try to get allowed tools from config if available
        let allowedTools: string[] = [];
        let mcpServers: Record<string, unknown> = {};

        try {
          if (existsSync(this.claudeConfigPath)) {
            const content = readFileSync(this.claudeConfigPath, 'utf-8');
            const config = JSON.parse(content);
            const projectConfig = config.projects?.[decodedPath];
            if (projectConfig) {
              allowedTools = projectConfig.allowedTools || [];
              mcpServers = projectConfig.mcpServers || {};
            }
          }
        } catch {
          // Ignore config read errors
        }

        projects.push({
          path: decodedPath,
          name: basename(decodedPath),
          allowedTools,
          mcpServers,
        });
      }

      consola.debug(`Returning ${projects.length} valid projects`);
      // Sort by path length (deeper paths first) then alphabetically
      return projects.sort((a, b) => {
        const depthDiff = b.path.split('/').length - a.path.split('/').length;
        if (depthDiff !== 0) return depthDiff;
        return a.path.localeCompare(b.path);
      });
    } catch (error) {
      consola.error('Error getting projects:', error);
      return [];
    }
  }

  /**
   * Get sessions for a specific project
   */
  async getSessions(projectPath: string): Promise<ClaudeSession[]> {
    try {
      const encodedPath = this.encodeProjectPath(projectPath);
      const projectDir = join(this.projectsDir, encodedPath);

      if (!existsSync(projectDir)) {
        return [];
      }

      const indexPath = join(projectDir, 'sessions-index.json');
      if (!existsSync(indexPath)) {
        return [];
      }

      const content = readFileSync(indexPath, 'utf-8');
      const index: ClaudeSessionsIndex = JSON.parse(content);
      return index.entries.sort(
        (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
      );
    } catch {
      return [];
    }
  }

  /**
   * Execute Claude CLI command with streaming output
   * Returns an object with the result promise and an abort function
   */
  execute(
    projectDir: string,
    prompt: string,
    options: {
      sessionId?: string;
      allowedTools?: string[];
      permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
      outputFormat?: 'json' | 'stream-json';
      onChunk?: (chunk: ClaudeStreamChunk) => void;
      abortSignal?: AbortSignal;
    } = {}
  ): { promise: Promise<ClaudeStreamChunk | null>; abort: () => void } {
    const args = ['-p'];

    // Output format (stream-json requires --verbose with -p)
    const outputFormat = options.outputFormat || 'stream-json';
    args.push('--output-format', outputFormat);
    if (outputFormat === 'stream-json') {
      args.push('--verbose');
    }

    // Permission mode
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }

    // Resume session if provided
    if (options.sessionId) {
      args.push('--resume', options.sessionId);
      consola.info(`Resuming session: ${options.sessionId.slice(0, 8)}...`);
    } else {
      consola.info('Starting new session');
    }

    // Add prompt (must be last)
    args.push(prompt);

    consola.debug('Spawning claude with args:', args.join(' '));
    consola.debug('Using claude binary:', this.claudeBinaryPath);
    const proc = spawn(this.claudeBinaryPath, args, {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: false,
    });

    let lastResult: ClaudeStreamChunk | null = null;
    let buffer = '';
    let aborted = false;

    // Abort function to kill the process
    const abort = () => {
      if (!aborted) {
        aborted = true;
        consola.info('Aborting Claude process...');
        proc.kill('SIGTERM');
      }
    };

    // Listen for abort signal if provided
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', abort);
    }

    const promise = new Promise<ClaudeStreamChunk | null>((resolve, reject) => {
      proc.stdout.on('data', (data: Buffer) => {
        buffer += data.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const chunk: ClaudeStreamChunk = JSON.parse(line);
              if (options.onChunk) {
                options.onChunk(chunk);
              }
              if (chunk.type === 'result') {
                lastResult = chunk;
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        // Log stderr for debugging
        consola.error('Claude stderr:', data.toString());
      });

      proc.on('close', (code) => {
        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const chunk: ClaudeStreamChunk = JSON.parse(buffer);
            if (options.onChunk) {
              options.onChunk(chunk);
            }
            if (chunk.type === 'result') {
              lastResult = chunk;
            }
          } catch {
            // Ignore parse errors
          }
        }

        if (aborted) {
          resolve(null); // Resolve with null if aborted
        } else if (code === 0 || lastResult) {
          resolve(lastResult);
        } else {
          reject(new Error(`Claude process exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        consola.error('Claude process error:', err);
        reject(err);
      });
    });

    return { promise, abort };
  }

  /**
   * Encode project path to Claude's directory naming format
   */
  private encodeProjectPath(projectPath: string): string {
    // Claude encodes paths by replacing / with - and removing leading -
    return projectPath.replace(/\//g, '-').replace(/^-/, '');
  }

  /**
   * Decode Claude's directory name back to actual path
   * Uses recursive approach to find the valid path that exists
   */
  private decodeProjectPath(encodedPath: string): string {
    // Remove leading dash
    const path = encodedPath.replace(/^-/, '');
    const parts = path.split('-');

    // Try to find the valid path by checking which combinations exist
    const result = this.findValidPath('', parts, 0);
    return result || `/${path.replace(/-/g, '/')}`; // Fallback to simple replacement
  }

  /**
   * Recursively find valid path by trying different hyphen interpretations
   */
  private findValidPath(current: string, parts: string[], index: number): string | null {
    if (index >= parts.length) {
      return existsSync(current) ? current : null;
    }

    // Try adding parts with / separator
    for (let i = index; i < parts.length; i++) {
      const segment = parts.slice(index, i + 1).join('-');
      const newPath = `${current}/${segment}`;

      // If this is the last possible segment, check if path exists
      if (i === parts.length - 1) {
        if (existsSync(newPath)) {
          return newPath;
        }
      } else {
        // Try continuing from this point
        const result = this.findValidPath(newPath, parts, i + 1);
        if (result) {
          return result;
        }
      }
    }

    return null;
  }

  /**
   * Get all project directories from the Claude projects folder
   */
  async getProjectDirs(): Promise<string[]> {
    try {
      if (!existsSync(this.projectsDir)) {
        return [];
      }

      const dirs = readdirSync(this.projectsDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      return dirs;
    } catch {
      return [];
    }
  }

  /**
   * Get git diff for uncommitted changes in a project
   * Returns null if not a git repo or no changes
   */
  async getGitDiff(projectDir: string): Promise<string | null> {
    return new Promise((resolve) => {
      // Get both staged and unstaged changes
      const proc = spawn('git', ['diff', 'HEAD'], {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';

      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString('utf8');
      });

      proc.on('close', (code) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim());
        } else {
          resolve(null);
        }
      });

      proc.on('error', () => {
        resolve(null);
      });
    });
  }

  /**
   * Get list of changed files (for summary)
   */
  async getChangedFiles(projectDir: string): Promise<string[]> {
    return new Promise((resolve) => {
      const proc = spawn('git', ['diff', '--name-only', 'HEAD'], {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';

      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString('utf8');
      });

      proc.on('close', (code) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim().split('\n').filter(Boolean));
        } else {
          resolve([]);
        }
      });

      proc.on('error', () => {
        resolve([]);
      });
    });
  }
}
