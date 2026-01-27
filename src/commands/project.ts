import { Command } from 'commander';
import { consola } from 'consola';
import { existsSync } from 'node:fs';
import { ClaudeCodeService } from '../services/claude-code';
import { ConfigManager } from '../services/config-manager';

export const projectCommand = new Command('project')
  .description('Set or show current project')
  .argument('[path]', 'Project path to set as current')
  .option('-l, --list', 'List available projects')
  .action(async (path, options) => {
    const configManager = new ConfigManager();
    const claudeService = new ClaudeCodeService();

    // List projects if --list flag
    if (options.list) {
      const projects = await claudeService.getProjects();
      if (projects.length === 0) {
        consola.warn('No Claude Code projects found.');
        return;
      }
      consola.info('Available projects:\n');
      for (const project of projects) {
        console.log(`  ${project.path}`);
      }
      return;
    }

    // Show current project if no path provided
    if (!path) {
      const currentProject = configManager.get<string>('projectDir');
      if (currentProject) {
        consola.info(`Current project: ${currentProject}`);
      } else {
        consola.warn('No project set. Use `hmdg project <path>` to set one.');
        consola.info('Use `hmdg project --list` to see available projects.');
      }
      return;
    }

    // Try to find matching project
    const projects = await claudeService.getProjects();
    let targetPath = path;

    // Check if path is a partial match (project name or partial path)
    if (!existsSync(path)) {
      const matches = projects.filter(
        (p) =>
          p.name.toLowerCase() === path.toLowerCase() ||
          p.path.toLowerCase().includes(path.toLowerCase())
      );

      if (matches.length === 1) {
        targetPath = matches[0].path;
      } else if (matches.length > 1) {
        consola.warn(`Multiple projects match "${path}":`);
        for (const match of matches) {
          console.log(`  ${match.path}`);
        }
        consola.info('Please specify the full path.');
        return;
      } else {
        consola.error(`Project "${path}" not found.`);
        consola.info('Use `hmdg project --list` to see available projects.');
        return;
      }
    }

    // Validate path exists
    if (!existsSync(targetPath)) {
      consola.error(`Path does not exist: ${targetPath}`);
      return;
    }

    // Set the project
    configManager.set('projectDir', targetPath);
    consola.success(`Project set to: ${targetPath}`);
  });
