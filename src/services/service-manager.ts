import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { consola } from 'consola';
import { LOG_DIR, LOG_FILE, PID_FILE } from '../constants';
import type { ServiceStatus } from '../types';
import type { ConfigManager } from './config-manager';
import { HeimerdingerServer } from './server';

export class ServiceManager {
  private configManager: ConfigManager;
  private pidFile: string;

  constructor(configManager: ConfigManager, pidFile: string = PID_FILE) {
    this.configManager = configManager;
    this.pidFile = pidFile;
  }

  /**
   * Check if the service is running
   */
  async isRunning(): Promise<boolean> {
    const pid = await this.getPid();
    if (!pid) return false;

    try {
      // Check if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      // Process doesn't exist, clean up stale PID file
      await this.removePidFile();
      return false;
    }
  }

  /**
   * Get current service status
   */
  async getStatus(): Promise<ServiceStatus> {
    const running = await this.isRunning();

    if (!running) {
      return { running: false };
    }

    const pid = await this.getPid();
    const port = this.configManager.get<number>('server.port');
    const adapter = this.configManager.get<string>('activeAdapter');
    const projectDir = this.configManager.get<string>('projectDir');

    return {
      running: true,
      pid: pid || undefined,
      port,
      adapter,
      projectDir,
    };
  }

  /**
   * Start service in foreground
   */
  async startForeground(): Promise<void> {
    const server = new HeimerdingerServer(this.configManager);

    // Handle shutdown signals
    const shutdown = async () => {
      consola.info('\nShutting down...');
      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await server.start();
  }

  /**
   * Start service as daemon
   */
  async startDaemon(): Promise<void> {
    // Ensure log directory exists
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }

    // Get project root from the CLI binary path (dist/cli.js -> project root)
    // import.meta.url points to the bundled file location
    const cliPath = new URL(import.meta.url).pathname;
    const projectRoot = dirname(dirname(cliPath)); // dist/cli.js -> dist -> project root

    const serverScript = join(projectRoot, 'src', 'services', 'daemon-entry.ts');
    const tsxPath = join(projectRoot, 'node_modules', '.bin', 'tsx');

    // Debug: check paths
    consola.debug('Daemon paths:', { projectRoot, serverScript, tsxPath, LOG_FILE });
    if (!existsSync(tsxPath)) {
      throw new Error(`tsx not found at: ${tsxPath}`);
    }
    if (!existsSync(serverScript)) {
      throw new Error(`Server script not found at: ${serverScript}`);
    }

    // Start daemon process (use tsx/Node.js for @slack/bolt WebSocket compatibility)
    // Use shell redirection for reliable log appending
    const proc = Bun.spawn(['sh', '-c', `"${tsxPath}" "${serverScript}" >> "${LOG_FILE}" 2>&1`], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEIMERDINGER_DAEMON: '1',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    // Detach the process
    proc.unref();

    // Wait a bit and check if started successfully
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (!(await this.isRunning())) {
      throw new Error('Failed to start daemon. Check logs with `hmdg logs`');
    }
  }

  /**
   * Stop service gracefully
   */
  async stop(): Promise<void> {
    const pid = await this.getPid();
    if (!pid) return;

    process.kill(pid, 'SIGTERM');

    // Wait for process to exit
    const maxWait = 10000; // 10 seconds
    const interval = 100;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      waited += interval;

      if (!(await this.isRunning())) {
        return;
      }
    }

    throw new Error('Service did not stop gracefully. Use --force to kill.');
  }

  /**
   * Force stop service
   */
  async forceStop(): Promise<void> {
    const pid = await this.getPid();
    if (!pid) return;

    process.kill(pid, 'SIGKILL');
    await this.removePidFile();
  }

  /**
   * Write PID file
   */
  async writePidFile(pid: number): Promise<void> {
    const dir = dirname(this.pidFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await Bun.write(this.pidFile, pid.toString());
  }

  /**
   * Get PID from file
   */
  private async getPid(): Promise<number | null> {
    try {
      const file = Bun.file(this.pidFile);
      if (!(await file.exists())) {
        return null;
      }
      const content = await file.text();
      const pid = Number.parseInt(content.trim(), 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Remove PID file
   */
  private async removePidFile(): Promise<void> {
    try {
      if (existsSync(this.pidFile)) {
        unlinkSync(this.pidFile);
      }
    } catch {
      // Ignore errors
    }
  }
}
