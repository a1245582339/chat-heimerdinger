import { Command } from 'commander';
import { consola } from 'consola';
import { ClaudeCodeService } from '../services/claude-code';

export const projectsCommand = new Command('projects')
  .description('List Claude Code projects')
  .option('-s, --sessions', 'Show sessions for each project')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const claudeService = new ClaudeCodeService();

    try {
      const projects = await claudeService.getProjects();

      if (projects.length === 0) {
        consola.warn('No Claude Code projects found.');
        consola.info('Start using Claude Code in a project directory to see it here.');
        return;
      }

      if (options.json) {
        if (options.sessions) {
          const projectsWithSessions = await Promise.all(
            projects.map(async (project) => ({
              ...project,
              sessions: await claudeService.getSessions(project.path),
            }))
          );
          console.log(JSON.stringify(projectsWithSessions, null, 2));
        } else {
          console.log(JSON.stringify(projects, null, 2));
        }
        return;
      }

      consola.info(`Found ${projects.length} project(s):\n`);

      for (const project of projects) {
        console.log(`  ${project.name}`);
        console.log(`    Path: ${project.path}`);

        if (options.sessions) {
          const sessions = await claudeService.getSessions(project.path);
          if (sessions.length > 0) {
            console.log(`    Sessions (${sessions.length}):`);
            for (const session of sessions.slice(0, 5)) {
              const date = new Date(session.modified).toLocaleDateString();
              console.log(
                `      - ${session.summary || session.firstPrompt.slice(0, 50)}... (${date})`
              );
            }
            if (sessions.length > 5) {
              console.log(`      ... and ${sessions.length - 5} more`);
            }
          } else {
            console.log('    Sessions: (none)');
          }
        }

        console.log('');
      }
    } catch (error) {
      consola.error('Failed to get projects:', error);
      process.exit(1);
    }
  });
