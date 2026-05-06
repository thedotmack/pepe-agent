type Level = "debug" | "info" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function emit(level: Level, tag: string, msg: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const color = COLORS[level];
  const head = `${color}${ts} [${level}] [${tag}]${RESET} ${msg}`;
  if (meta !== undefined) {
    console.log(head, typeof meta === "string" ? meta : JSON.stringify(meta));
  } else {
    console.log(head);
  }
}

export interface Logger {
  debug: (msg: string, meta?: unknown) => void;
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}

export function createLogger(tag: string): Logger {
  return {
    debug: (msg, meta) => emit("debug", tag, msg, meta),
    info: (msg, meta) => emit("info", tag, msg, meta),
    warn: (msg, meta) => emit("warn", tag, msg, meta),
    error: (msg, meta) => emit("error", tag, msg, meta),
  };
}
