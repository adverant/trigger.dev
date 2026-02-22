/**
 * Plugin Configuration
 *
 * Loads all environment variables and provides typed config objects for:
 * - Trigger.dev connection (self-hosted or external)
 * - Nexus service URLs
 * - Database and Redis connections
 * - Plugin identity and runtime settings
 */

import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export type TriggerMode = 'self-hosted' | 'external';
export type TriggerEnvironment = 'dev' | 'staging' | 'production';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface TriggerConfig {
  mode: TriggerMode;
  apiUrl: string;
  secretKey: string;
  personalAccessToken: string;
  projectRef: string;
  environment: TriggerEnvironment;
}

export interface NexusConfig {
  authUrl: string;
  apiKey: string;
  services: {
    graphrag: string;
    mageagent: string;
    fileprocess: string;
    learningagent: string;
    geoagent: string;
    jupyter: string;
    cvat: string;
    gpuBridge: string;
    sandbox: string;
    n8n: string;
  };
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  maxConnections: number;
}

export interface RedisConfig {
  url: string;
}

export interface PluginConfig {
  id: string;
  version: string;
  port: number;
  logLevel: LogLevel;
  nodeEnv: string;
  uiBuildPath: string;
}

export interface AppConfig {
  trigger: TriggerConfig;
  nexus: NexusConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  plugin: PluginConfig;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function intEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${value}`);
  }
  return parsed;
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

export function loadConfig(): AppConfig {
  const trigger: TriggerConfig = {
    mode: optionalEnv('TRIGGER_MODE', 'self-hosted') as TriggerMode,
    apiUrl: optionalEnv('TRIGGER_API_URL', 'http://trigger-dev-webapp:3030'),
    secretKey: optionalEnv('TRIGGER_SECRET_KEY', ''),
    personalAccessToken: optionalEnv('TRIGGER_PAT', ''),
    projectRef: optionalEnv('TRIGGER_PROJECT_REF', ''),
    environment: optionalEnv('TRIGGER_ENVIRONMENT', 'dev') as TriggerEnvironment,
  };

  const nexus: NexusConfig = {
    authUrl: optionalEnv('NEXUS_AUTH_URL', 'http://nexus-auth.nexus.svc.cluster.local:9100'),
    apiKey: optionalEnv('NEXUS_API_KEY', ''),
    services: {
      graphrag: optionalEnv('GRAPHRAG_URL', 'http://nexus-graphrag-enhanced:9051'),
      mageagent: optionalEnv('MAGEAGENT_URL', 'http://nexus-mageagent:8080'),
      fileprocess: optionalEnv('FILEPROCESS_URL', 'http://nexus-fileprocess:9040'),
      learningagent: optionalEnv('LEARNINGAGENT_URL', 'http://nexus-learningagent:8094'),
      geoagent: optionalEnv('GEOAGENT_URL', 'http://nexus-mageagent:8080'),
      jupyter: optionalEnv('JUPYTER_URL', 'http://nexus-jupyter-auth-proxy:8888'),
      cvat: optionalEnv('CVAT_URL', 'http://nexus-cvat-auth-proxy:8080'),
      gpuBridge: optionalEnv('GPU_BRIDGE_URL', 'http://nexus-gpu-bridge:8090'),
      sandbox: optionalEnv('SANDBOX_URL', 'http://nexus-sandbox:9080'),
      n8n: optionalEnv('N8N_URL', 'http://nexus-n8n:5678'),
    },
  };

  const database: DatabaseConfig = {
    host: optionalEnv('POSTGRES_HOST', 'nexus-postgres.nexus.svc.cluster.local'),
    port: intEnv('POSTGRES_PORT', 5432),
    database: optionalEnv('POSTGRES_DATABASE', 'nexus'),
    user: optionalEnv('POSTGRES_USER', 'nexus'),
    password: optionalEnv('POSTGRES_PASSWORD', ''),
    ssl: boolEnv('POSTGRES_SSL', false),
    maxConnections: intEnv('POSTGRES_MAX_CONNECTIONS', 20),
  };

  const redis: RedisConfig = {
    url: optionalEnv('REDIS_URL', 'redis://nexus-redis.nexus.svc.cluster.local:6379'),
  };

  const plugin: PluginConfig = {
    id: optionalEnv('NEXUS_PLUGIN_ID', 'nexus-trigger'),
    version: optionalEnv('NEXUS_PLUGIN_VERSION', '1.0.0'),
    port: intEnv('PORT', 8080),
    logLevel: optionalEnv('LOG_LEVEL', 'info') as LogLevel,
    nodeEnv: optionalEnv('NODE_ENV', 'production'),
    uiBuildPath: optionalEnv('UI_BUILD_PATH', './ui/out'),
  };

  return { trigger, nexus, database, redis, plugin };
}

export default loadConfig;
