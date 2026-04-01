import * as core from '@actions/core';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3
}

export class Logger {
  private readonly context: string;
  private readonly isDebug: boolean;
  
  constructor(context: string) {
    this.context = context;
    this.isDebug = core.getBooleanInput('debug') || process.env['RUNNER_DEBUG'] === '1';
  }
  
  debug(message: string, data?: any): void {
    if (this.isDebug) {
      const logMessage = this.formatMessage(LogLevel.DEBUG, message, data);
      // Use core.info so debug output is always visible in the Actions log
      // when the user has enabled the debug input. core.debug only shows
      // when the ACTIONS_STEP_DEBUG repo secret is set.
      core.info(logMessage);
    }
  }
  
  info(message: string, data?: any): void {
    const logMessage = this.formatMessage(LogLevel.INFO, message, data);
    core.info(logMessage);
  }
  
  warn(message: string, data?: any): void {
    const logMessage = this.formatMessage(LogLevel.WARNING, message, data);
    core.warning(logMessage);
  }
  
  warning(message: string, data?: any): void {
    this.warn(message, data);
  }
  
  error(message: string, data?: any): void {
    const logMessage = this.formatMessage(LogLevel.ERROR, message, data);
    core.error(logMessage);
  }
  
  startGroup(name: string): void {
    core.startGroup(name);
  }
  
  endGroup(): void {
    core.endGroup();
  }
  
  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    const sanitizedData = data ? this.sanitizeData(data) : '';
    
    return `[${timestamp}] [${levelStr}] [${this.context}] ${message}${sanitizedData ? ' ' + sanitizedData : ''}`;
  }
  
  private sanitizeData(data: any): string {
    try {
      // Remove sensitive information
      const sanitized = this.removeSensitiveData(data);
      return JSON.stringify(sanitized, this.jsonReplacer, 2);
    } catch (error) {
      return '[Unable to serialize data]';
    }
  }

  private jsonReplacer(_key: string, value: any): any {
    if (value instanceof Error) {
      return { message: value.message, name: value.name, ...(value.stack ? { stack: value.stack } : {}) };
    }
    return value;
  }
  
  private removeSensitiveData(obj: any): any {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    
    const sensitiveKeys = [
      'token', 'password', 'secret', 'key', 'authorization',
      'client_secret', 'access_token', 'refresh_token'
    ];
    
    const cleaned = Array.isArray(obj) ? [...obj] : { ...obj };
    
    for (const key in cleaned) {
      const lowerKey = key.toLowerCase();
      
      if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
        cleaned[key] = '[REDACTED]';
      } else if (typeof cleaned[key] === 'object') {
        cleaned[key] = this.removeSensitiveData(cleaned[key]);
      }
    }
    
    return cleaned;
  }
}