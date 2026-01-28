import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

    // Get dist directory from the CLI binary path (dist/cli.js -> dist)
    // import.meta.url points to the bundled file location
    const cliPath = new URL(import.meta.url).pathname;
    const distDir = dirname(cliPath); // dist/cli.js -> dist

    const daemonScript = join(distDir, 'daemon-entry.js');

    // Debug: check paths
    consola.debug('Daemon paths:', { distDir, daemonScript, LOG_FILE });
    if (!existsSync(daemonScript)) {
      throw new Error(`Daemon script not found at: ${daemonScript}`);
    }

    // Start daemon process using node to run the bundled script
    // Use shell redirection for reliable log appending
    const proc = spawn('sh', ['-c', `node "${daemonScript}" >> "${LOG_FILE}" 2>&1`], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEIMERDINGER_DAEMON: '1',
      },
      stdio: 'ignore',
      detached: true,
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
    if (!pid) {
      // No PID file, try to find and kill orphaned processes
      await this.killOrphanedProcesses();
      return;
    }

    process.kill(pid, 'SIGTERM');

    // Wait for process to exit
    const maxWait = 5000; // 5 seconds for graceful shutdown
    const interval = 100;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      waited += interval;

      if (!(await this.isRunning())) {
        // Also kill any orphaned processes
        await this.killOrphanedProcesses();
        return;
      }
    }

    // Graceful shutdown failed, escalate to SIGKILL
    consola.warn('Graceful shutdown timed out, forcing stop...');
    await this.forceStop();
  }

  /**
   * Force stop service
   */
  async forceStop(): Promise<void> {
    const pid = await this.getPid();
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process might already be dead
      }
    }
    await this.removePidFile();
    // Also kill any orphaned processes
    await this.killOrphanedProcesses();
  }

  /**
   * Kill any orphaned daemon processes
   * This handles cases where PID file is stale or out of sync
   */
  private async killOrphanedProcesses(): Promise<void> {
    try {
      // Find and kill any processes running daemon-entry.js
      execSync('pkill -f "node.*daemon-entry" 2>/dev/null || true', { encoding: 'utf-8' });
    } catch {
      // pkill failed or no processes found, ignore
    }
  }

  /**
   * Write PID file
   */
  async writePidFile(pid: number): Promise<void> {
    const dir = dirname(this.pidFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.pidFile, pid.toString());
  }

  /**
   * Get PID from file
   */
  private async getPid(): Promise<number | null> {
    try {
      if (!existsSync(this.pidFile)) {
        return null;
      }
      const content = readFileSync(this.pidFile, 'utf-8');
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
