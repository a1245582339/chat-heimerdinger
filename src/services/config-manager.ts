import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_CONFIG } from '../constants';
import type { HeimerdingerConfig } from '../types';

export class ConfigManager {
  private configPath: string;
  private config: HeimerdingerConfig;

  constructor(configPath: string = CONFIG_FILE) {
    this.configPath = configPath;
    this.config = this.load();
  }

  private load(): HeimerdingerConfig {
    try {
      if (!existsSync(this.configPath)) {
        return { ...DEFAULT_CONFIG };
      }

      const content = readFileSync(this.configPath, 'utf-8');
      if (!content.trim()) {
        return { ...DEFAULT_CONFIG };
      }

      const loaded = JSON.parse(content);
      return this.mergeWithDefaults(loaded);
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private mergeWithDefaults(loaded: Partial<HeimerdingerConfig>): HeimerdingerConfig {
    return {
      ...DEFAULT_CONFIG,
      ...loaded,
      server: { ...DEFAULT_CONFIG.server, ...loaded.server },
      claude: { ...DEFAULT_CONFIG.claude, ...loaded.claude },
      permissions: { ...DEFAULT_CONFIG.permissions, ...loaded.permissions },
      logging: { ...DEFAULT_CONFIG.logging, ...loaded.logging },
      adapters: { ...DEFAULT_CONFIG.adapters, ...loaded.adapters },
    };
  }

  private save(): void {
    // Ensure directory exists
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }

  getAll(): HeimerdingerConfig {
    return { ...this.config };
  }

  get<T = unknown>(key: string): T | undefined {
    const keys = key.split('.');
    let value: unknown = this.config;

    for (const k of keys) {
      if (value === null || value === undefined || typeof value !== 'object') {
        return undefined;
      }
      value = (value as Record<string, unknown>)[k];
    }

    return value as T;
  }

  set(key: string, value: unknown): void {
    const keys = key.split('.');
    let current: Record<string, unknown> = this.config as unknown as Record<string, unknown>;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in current) || typeof current[k] !== 'object' || current[k] === null) {
        current[k] = {};
      }
      current = current[k] as Record<string, unknown>;
    }

    current[keys[keys.length - 1]] = value;
    this.save();
  }

  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.save();
  }

  ensureConfigDir(): void {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }
}
