#!/usr/bin/env bun

import { Command } from 'commander';
import { consola } from 'consola';
import { APP_NAME, CLI_NAME, VERSION } from './constants';

import { configCommand } from './commands/config';
// Import commands
import { initCommand } from './commands/init';
import { logsCommand } from './commands/logs';
import { projectCommand } from './commands/project';
import { projectsCommand } from './commands/projects';
import { startCommand } from './commands/start';
import { statusCommand } from './commands/status';
import { stopCommand } from './commands/stop';

const program = new Command();

program
  .name(CLI_NAME)
  .description(`${APP_NAME} - Bridge IM tools with Claude Code for vibe coding`)
  .version(VERSION, '-v, --version', 'Display version number');

// Register commands
program.addCommand(initCommand);
program.addCommand(configCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(statusCommand);
program.addCommand(projectCommand);
program.addCommand(projectsCommand);
program.addCommand(logsCommand);

// Error handling
program.exitOverride((err) => {
  if (err.code === 'commander.help') {
    process.exit(0);
  }
  if (err.code === 'commander.version') {
    process.exit(0);
  }
  consola.error(err.message);
  process.exit(1);
});

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (process.argv.length === 2) {
  program.help();
}
