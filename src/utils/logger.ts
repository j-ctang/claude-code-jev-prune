import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import winston from "winston";

export interface AppLogger {
  info(message: string, metadata?: Record<string, unknown>): unknown;
  warn(message: string, metadata?: Record<string, unknown>): unknown;
  error(message: string, metadata?: Record<string, unknown>): unknown;
  debug(message: string, metadata?: Record<string, unknown>): unknown;
}

interface LoggerOptions {
  logPath?: string;
  console?: boolean;
  level?: "info" | "debug";
}

export function createLogger(options: LoggerOptions = {}): winston.Logger {
  const logPath =
    options.logPath ?? join(homedir(), ".claude", "jev-prune.log");
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const fileDescriptor = openSync(logPath, "a", 0o600);
  closeSync(fileDescriptor);
  chmodSync(logPath, 0o600);

  const transports: winston.transport[] = [
    new winston.transports.File({ filename: logPath }),
  ];
  if (options.console !== false) {
    transports.push(
      new winston.transports.Console({
        format:
          process.env.NODE_ENV === "production"
            ? winston.format.json()
            : winston.format.combine(
                winston.format.colorize(),
                winston.format.simple(),
              ),
      }),
    );
  }

  return winston.createLogger({
    level: options.level ?? "info",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports,
  });
}
