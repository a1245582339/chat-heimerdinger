import { Command } from 'commander';
import { consola } from 'consola';
import { LOG_FILE } from '../constants';

export const logsCommand = new Command('logs')
  .description('View service logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(async (options) => {
    const logFile = Bun.file(LOG_FILE);

    if (!(await logFile.exists())) {
      consola.warn('No log file found. Service may not have been started yet.');
      return;
    }

    const lines = Number.parseInt(options.lines, 10);

    if (options.follow) {
      consola.info(`Following logs from ${LOG_FILE}...\n`);
      consola.info('Press Ctrl+C to stop.\n');

      // Use tail -f for following
      const proc = Bun.spawn(['tail', '-f', '-n', lines.toString(), LOG_FILE], {
        stdout: 'inherit',
        stderr: 'inherit',
      });

      // Handle Ctrl+C
      process.on('SIGINT', () => {
        proc.kill();
        process.exit(0);
      });

      await proc.exited;
    } else {
      // Read last N lines
      const content = await logFile.text();
      const allLines = content.split('\n').filter(Boolean);
      const lastLines = allLines.slice(-lines);

      if (lastLines.length === 0) {
        consola.info('Log file is empty.');
        return;
      }

      console.log(lastLines.join('\n'));
    }
  });
