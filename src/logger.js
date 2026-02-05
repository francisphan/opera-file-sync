const winston = require('winston');

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'warn',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      if (stack) {
        return `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}`;
      }
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, stack }) => {
          if (stack) {
            return `${timestamp} ${level}: ${message}\n${stack}`;
          }
          return `${timestamp} ${level}: ${message}`;
        })
      )
    }),
    // File output - all logs
    new winston.transports.File({
      filename: 'logs/opera-sync.log',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    // File output - errors only
    new winston.transports.File({
      filename: 'logs/opera-sync-errors.log',
      level: 'error',
      maxsize: 10485760,
      maxFiles: 5
    })
  ]
});

module.exports = logger;
