# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chat Heimerdinger (`hmdg`) is a bridge tool connecting Slack with Claude Code CLI, enabling conversational programming directly from Slack. It runs as a background daemon that receives Slack messages and executes them through Claude Code with streaming responses.

## Build & Development Commands

```bash
pnpm install      # Install dependencies
pnpm dev          # Run in development mode (uses tsx)
pnpm build        # Build for production (bundles to dist/)
pnpm test         # Run tests with Bun
pnpm lint         # Check code with Biome
pnpm lint:fix     # Fix linting issues
pnpm format       # Format code with Biome
```

The build process uses Bun to bundle TypeScript, outputting `dist/cli.js` and `dist/daemon-entry.js`, then replaces the shebang for Node.js compatibility.

## Architecture

### Entry Points
- `src/cli.ts` - CLI entry using Commander.js (commands: init, config, start, stop, status, project, projects, logs)
- `src/services/daemon-entry.ts` - Daemon process entry point

### Core Services (src/services/)
- **claude-code.ts** - Spawns `claude` CLI with streaming JSON output, manages sessions from `~/.claude/projects/`
- **message-processor.ts** - Core message handling, session state management, persists to `~/.heimerdinger/sessions-state.json`
- **service-manager.ts** - Daemon lifecycle, PID file handling at `~/.heimerdinger/heimerdinger.pid`
- **server.ts** - HTTP server + adapter management
- **whisper.ts** - Optional voice transcription (requires whisper-cli, ffmpeg)

### Adapters (src/adapters/)
- **slack.ts** - Uses @slack/bolt with Socket Mode; handles DMs, @mentions, slash commands (/project, /stop, /clear), voice messages, and interactive UI cards

### Key Paths
- `~/.heimerdinger/` - App config directory (config.json, sessions-state.json, logs/)
- `~/.claude/projects/` - Claude Code projects directory

## Code Style

- 2-space indentation, single quotes, semicolons always
- Line width: 100 characters
- ESM modules (`"type": "module"`)

## Testing the CLI

```bash
pnpm build && pnpm link --global  # Build and link globally
hmdg init                          # Initialize configuration
hmdg start -f                      # Start in foreground (for debugging)
hmdg status                        # Check service status
```

## Notes

- Development uses tsx instead of Bun due to Slack Socket Mode WebSocket issues with Bun runtime
- The adapter pattern supports future IM platforms (Lark, Discord mentioned but not yet implemented)
- Claude responses stream in real-time with Slack message updates
- Permission system has interactive approval flow via Slack cards
