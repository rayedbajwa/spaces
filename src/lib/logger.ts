/**
 * Zero-dependency structured JSON logger.
 *
 * Emits one JSON object per line to stdout (info/debug) or stderr (warn/error).
 * The format is intentionally the same shape pino/winston use so downstream
 * log shippers (Vector, Loki, Datadog agent, etc.) can parse it out of the box.
 *
 * Toggle to human-friendly single-line output for local dev with:
 *   LOG_FORMAT=pretty
 *
 * Set the minimum level with:
 *   LOG_LEVEL=debug|info|warn|error   (default: info)
 */

type Level = 'debug' | 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const ENV_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level
const MIN_LEVEL = LEVELS[ENV_LEVEL] ?? LEVELS.info
const PRETTY = (process.env.LOG_FORMAT ?? '').toLowerCase() === 'pretty'

function emit(level: Level, msg: string, fields?: Fields): void {
  if (LEVELS[level] < MIN_LEVEL) return
  const record = { level, time: new Date().toISOString(), msg, ...fields }
  const line = PRETTY ? formatPretty(record) : JSON.stringify(record)
  // stdout for info/debug, stderr for warn/error — standard convention.
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

function formatPretty(r: Record<string, unknown>): string {
  const { level, time, msg, ...rest } = r as { level: Level; time: string; msg: string }
  const tag = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' }[level]
  const restStr = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''
  return `${time} ${tag} ${msg}${restStr}`
}

export interface Logger {
  debug(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields | Error, err?: Error): void
  child(bindings: Fields): Logger
}

function serializeErr(err: unknown): Fields {
  if (!(err instanceof Error)) return { err }
  return {
    err: {
      name: err.name,
      message: err.message,
      stack: err.stack,
    },
  }
}

function makeLogger(bindings: Fields = {}): Logger {
  return {
    debug: (msg, fields) => emit('debug', msg, { ...bindings, ...fields }),
    info: (msg, fields) => emit('info', msg, { ...bindings, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...bindings, ...fields }),
    error: (msg, fieldsOrErr, err) => {
      // Accept both: log.error('msg', {foo:1}, err) and log.error('msg', err)
      let extra: Fields = {}
      if (fieldsOrErr instanceof Error) extra = serializeErr(fieldsOrErr)
      else if (fieldsOrErr) extra = { ...fieldsOrErr }
      if (err) extra = { ...extra, ...serializeErr(err) }
      emit('error', msg, { ...bindings, ...extra })
    },
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  }
}

/** Root application logger. Child loggers should namespace with `.child({ mod: 'name' })`. */
export const log: Logger = makeLogger()
