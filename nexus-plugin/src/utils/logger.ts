/**
 * Structured Logging with Winston
 *
 * Provides centralized logging with:
 * - JSON format for production
 * - Colorized format for development
 * - Daily rotate file transport (14-day retention)
 * - Context enrichment (service, component, requestId)
 * - Child logger support
 */

import winston from 'winston';
// @ts-ignore - winston-daily-rotate-file types not bundled
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug');
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestamp} [${level}]: ${message} ${metaStr}`;
  })
);

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: NODE_ENV === 'production' ? prodFormat : devFormat,
  }),
];

if (NODE_ENV === 'production') {
  transports.push(
    new DailyRotateFile({
      filename: path.join(LOG_DIR, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '14d',
      format: prodFormat,
    })
  );

  transports.push(
    new DailyRotateFile({
      filename: path.join(LOG_DIR, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: prodFormat,
    })
  );
}

const winstonLogger = winston.createLogger({
  levels: LOG_LEVELS,
  level: LOG_LEVEL,
  transports,
  exitOnError: false,
});

export interface LogContext {
  service?: string;
  component?: string;
  userId?: string;
  organizationId?: string;
  requestId?: string;
  taskId?: string;
  runId?: string;
  error?: Error | any;
  [key: string]: any;
}

export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  child(context: LogContext): Logger {
    return new Logger({ ...this.context, ...context });
  }

  error(message: string, context: LogContext = {}): void {
    winstonLogger.error(message, { ...this.context, ...context });
  }

  warn(message: string, context: LogContext = {}): void {
    winstonLogger.warn(message, { ...this.context, ...context });
  }

  info(message: string, context: LogContext = {}): void {
    winstonLogger.info(message, { ...this.context, ...context });
  }

  debug(message: string, context: LogContext = {}): void {
    winstonLogger.debug(message, { ...this.context, ...context });
  }

  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, context: LogContext = {}): void {
    winstonLogger.log(level, message, { ...this.context, ...context });
  }
}

export const defaultLogger = new Logger({
  service: 'nexus-trigger',
});

export const logger = defaultLogger;

export const createLogger = (context: LogContext): Logger => {
  return new Logger({ service: 'nexus-trigger', ...context });
};

export default defaultLogger;
