const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { name: serviceName, version } = require('../package.json');
const { requestContext } = require('./middleware/requestId');
const { redactFormat } = require('./services/logRedaction');
const { nowIso } = require('./utils/dates');

// ==================== LOG LEVEL ====================
const getLogLevel = () => {
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }
  const env = process.env.NODE_ENV || 'development';
  if (env === 'production') return 'info';
  if (env === 'test') return 'warn';
  return 'debug';
};

// ==================== FORMAT DECISION ====================
const env = process.env.NODE_ENV || 'development';
const logFormat = process.env.LOG_FORMAT || (env === 'production' ? 'json' : 'pretty');
const useJsonFormat = logFormat === 'json';

// ==================== REQUEST CONTEXT ====================
const requestIdFormat = winston.format((info) => {
  const store = requestContext.getStore();
  const requestId = store?.requestId || store?.correlationId || 'system';
  info.requestId = requestId;
  // snake_case alias so structured log output matches the request_id field
  // name used on delivery records and in API responses (issue #250).
  // `requestId` is kept for existing dashboards and queries.
  if (info.request_id === undefined) info.request_id = requestId;
  if (info.correlationId === undefined) info.correlationId = requestId;
  if (info.correlation_id === undefined) info.correlation_id = requestId;
  return info;
});

const errorTrackerFormat = winston.format((info) => {
  if (info.level === 'error') {
    const errorObj = info.error instanceof Error ? info.error : (info.stack ? info : new Error(info.message || 'Logged Error'));
    const { level, message, timestamp, ...extra } = info;
    require('./services/errorTracker').captureException(errorObj, extra);
  }
  return info;
});


// ==================== LOG SAMPLING (#734) ====================
const DEFAULT_SAMPLE_RATE = 1.0;

function parseSampleRate(value, fallback = DEFAULT_SAMPLE_RATE) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

let configuredSampleRate = parseSampleRate(process.env.LOG_SAMPLE_RATE, DEFAULT_SAMPLE_RATE);

function getLogSampleRate() {
  return configuredSampleRate;
}

function setLogSampleRate(rate) {
  configuredSampleRate = parseSampleRate(rate, DEFAULT_SAMPLE_RATE);
  return configuredSampleRate;
}

function shouldSampleLog(sampleRate = configuredSampleRate, randomFn = Math.random) {
  const rate = parseSampleRate(sampleRate, configuredSampleRate);
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return randomFn() < rate;
}

const samplingFormat = winston.format((info) => {
  const hasExplicitRate = info && info.sampleRate !== undefined;
  const isHighSeverity = info.level === 'error' || info.level === 'warn';
  if (!hasExplicitRate && isHighSeverity) {
    return info;
  }
  const effectiveRate = hasExplicitRate
    ? parseSampleRate(info.sampleRate, configuredSampleRate)
    : configuredSampleRate;
  if (hasExplicitRate) {
    delete info.sampleRate;
  }
  if (!shouldSampleLog(effectiveRate)) {
    return false;
  }
  return info;
});

// ==================== BASE FORMATS ====================
const baseFormats = [
  samplingFormat(),
  winston.format.timestamp({ format: () => nowIso() }),
  winston.format.errors({ stack: true }),
  requestIdFormat(),
  redactFormat(),
  errorTrackerFormat(),
];

// ==================== JSON FORMAT ====================
const jsonFormat = winston.format.combine(
  ...baseFormats,
  winston.format.json()
);

// ==================== PRETTY FORMAT ====================
const prettyFormat = winston.format.combine(
  ...baseFormats,
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    // request_id is a snake_case alias of requestId (issue #250); printing
    // both would duplicate the same value in every pretty-formatted line.
    const { service, version: ver, request_id: _requestIdAlias, ...rest } = meta;
    const metaStr = Object.keys(rest).length
      ? ` ${JSON.stringify(rest)}`
      : '';

    return `${timestamp} [${level}] [${service}@${ver}] ${message}${metaStr}${stack ? `\n${stack}` : ''}`;
  })
);

// ==================== TRANSPORTS ====================
const transports = [
  new winston.transports.Console({
    format: useJsonFormat ? jsonFormat : prettyFormat
  })
];

// Optional file logging
if (process.env.LOG_FILE_PATH) {
  transports.push(
    new DailyRotateFile({
      filename: `${process.env.LOG_FILE_PATH}/application-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      // Issue #494 — winston-daily-rotate-file resolves %DATE% from the host
      // wall clock by default, so two servers in different time zones named
      // (and rotated) the same UTC log window differently. utc: true pins the
      // filename/rotation date to UTC.
      utc: true,
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: jsonFormat
    })
  );
}

// ==================== LOGGER ====================
const logger = winston.createLogger({
  level: getLogLevel(),
  defaultMeta: { service: serviceName, version },
  transports,
  exitOnError: false
});

// #524 — Runtime log level configuration
const VALID_LEVELS = ['debug', 'info', 'warn', 'error'];

function setLogLevel(level) {
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`Invalid log level: ${level}. Must be one of: ${VALID_LEVELS.join(', ')}`);
  }
  logger.level = level;
  logger.info(`Log level changed to ${level}`);
  return level;
}

function getCurrentLogLevel() {
  return logger.level;
}

logger.sampled = function sampled(level, message, meta = {}, sampleRate = configuredSampleRate) {
  if (!shouldSampleLog(sampleRate)) {
    return logger;
  }
  return logger.log(level, message, { ...meta });
};

module.exports = logger;
module.exports.setLogLevel = setLogLevel;
module.exports.getCurrentLogLevel = getCurrentLogLevel;
module.exports.VALID_LEVELS = VALID_LEVELS;
module.exports.DEFAULT_SAMPLE_RATE = DEFAULT_SAMPLE_RATE;
module.exports.getLogSampleRate = getLogSampleRate;
module.exports.setLogSampleRate = setLogSampleRate;
module.exports.shouldSampleLog = shouldSampleLog;