export const DEFAULT_FAMILIES =
  'SIMATIC,S7-1200,S7-1200 G2,S7-1500,ET 200,TIA Portal,STEP 7,WinCC,WinCC Unified,S7-PLCSIM,SINAMICS,SCALANCE,Industrial Edge';
export type PriorityMode = 'recent-severity' | 'newest-first' | 'highest-severity';
export function isPriorityMode(value: string): value is PriorityMode {
  return ['recent-severity', 'newest-first', 'highest-severity'].includes(value);
}
function numeric(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
  integer = true,
): number {
  if (env[key] === undefined) return fallback;
  const value = Number(env[key]);
  if (
    !env[key]?.trim() ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(
      `${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`,
    );
  return value;
}
function list(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const priorityMode = env.PRIORITY_MODE ?? 'recent-severity';
  if (!isPriorityMode(priorityMode))
    throw new Error('PRIORITY_MODE must be recent-severity, newest-first, or highest-severity');
  if (env.POLL_ON_START !== undefined && !/^(true|false|1|0)$/i.test(env.POLL_ON_START))
    throw new Error('POLL_ON_START must be true or false');
  const feedUrl = env.FEED_URL || 'https://cert-portal.siemens.com/productcert/rss/advisories.atom';
  const source = new URL(feedUrl);
  if (source.protocol !== 'https:' || source.username || source.password)
    throw new Error('FEED_URL must use HTTPS without embedded credentials');
  const families = list(env.PRODUCT_FAMILIES ?? DEFAULT_FAMILIES);
  const keywords = list(env.PRODUCT_KEYWORDS ?? 'PROFINET,PROFIBUS,OPC UA');
  if ([...families, ...keywords].some((term) => !/[a-z0-9]/i.test(term)))
    throw new Error('Product filters must contain letters or numbers');
  if (!families.length && !keywords.length)
    throw new Error('PRODUCT_FAMILIES or PRODUCT_KEYWORDS must contain at least one match');
  const timezone = env.TZ || 'Europe/Copenhagen';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const recentDays = numeric(env, 'RECENT_DAYS', 90, 1, 3650);
  const severityDays = numeric(env, 'SEVERITY_DAYS', 7, 1, 3650);
  if (severityDays > recentDays)
    throw new Error('SEVERITY_DAYS must be less than or equal to RECENT_DAYS');
  return {
    port: numeric(env, 'PORT', 8080, 1, 65535),
    feedUrl,
    pollIntervalMin: numeric(env, 'POLL_INTERVAL_MIN', 30, 0.1, 1440, false),
    requestIntervalSeconds: numeric(env, 'REQUEST_INTERVAL_SECONDS', 60, 10, 86400),
    rateLimitCooldownMin: numeric(env, 'RATE_LIMIT_COOLDOWN_MIN', 60, 1, 1440),
    pollOnStart: !/^(false|0)$/i.test(env.POLL_ON_START ?? 'true'),
    dbPath: env.DB_PATH || './data/board.db',
    heroCount: numeric(env, 'HERO_COUNT', 6, 1, 8),
    railCount: numeric(env, 'RAIL_COUNT', 6, 1, 8),
    rotateSeconds: numeric(env, 'ROTATE_SECONDS', 25, 5, 300),
    staleAfterMin: numeric(env, 'STALE_AFTER_MIN', 120, 1, 10080, false),
    recentDays,
    severityDays,
    priorityMode,
    families,
    keywords,
    timezone,
    userAgent:
      env.USER_AGENT || 'SiemensBoard/1.0 (+https://github.com/SCarlsen7757/siemens-board)',
  };
}
export type Config = ReturnType<typeof loadConfig>;
export const config = loadConfig();
