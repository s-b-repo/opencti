// Only the statuses telling that the credentials are refused: a 429 or a 5xx says nothing about access
export const ACCESS_DENIED_HTTP_STATUSES: readonly number[] = [401, 402, 403];

// Logged by pycti at the end of each run of a connector: the logs between two markers are the logs of one run
export const RUN_END_MARKER = 'Schedule next run of connector';

// A snapshot of logs older than the expected next run by more than this is stale: the connector may not have run since
const STALE_SNAPSHOT_TOLERANCE_MS = 10 * 60 * 1000;

export interface AccessDenied {
  http_status: number;
  // Never the full URL: an API key may sit in its query string
  host?: string;
}

// The error texts of the HTTP clients used by the connectors: requests, httpx, aiohttp
const ACCESS_DENIED_PATTERNS: RegExp[] = [
  /\b(\d{3}) (?:Client|Server) Error: .*? for url: (\S+)/,
  /'(\d{3}) [^']*' for url '([^']+)'/,
  /\b(\d{3}), message=.*?, url=(?:URL\()?'([^']+)'/,
];

/**
 * Reads an HTTP access denied (401, 402, 403) in the text of an error logged by a connector.
 * The calls of the connector to OpenCTI itself are not an access denied of its source.
 *
 * @param text the error text, as logged by the connector
 * @param platformHost the host of the platform, whose calls are ignored
 * @returns the status and the host of the source, or null when the text is not an access denied of a source
 */
export const parseAccessDenied = (text: string, platformHost?: string): AccessDenied | null => {
  for (const pattern of ACCESS_DENIED_PATTERNS) {
    const match = pattern.exec(text);
    const httpStatus = match ? Number(match[1]) : undefined;
    if (match && httpStatus !== undefined && ACCESS_DENIED_HTTP_STATUSES.includes(httpStatus)) {
      try {
        const url = new URL(match[2]);
        // platformHost is a hostname, without port: compared to the hostname of the URL, whatever the case
        const isOpenCtiCall = (!!platformHost && url.hostname === platformHost.toLowerCase()) || url.pathname.endsWith('/graphql') || url.pathname.startsWith('/storage/');
        return isOpenCtiCall ? null : { http_status: httpStatus, host: url.host };
      } catch {
        return { http_status: httpStatus };
      }
    }
  }
  return null;
};

/**
 * The hostname of the platform, from its base url: what parseAccessDenied compares the host of a call to.
 * Undefined when the base url is not absolute (no base url configured, only a base path).
 */
export const getPlatformHost = (baseUrl: string): string | undefined => {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
};

type ComposerLogLine = Record<string, unknown>;

// A line of the composer logs is a JSON object, possibly after a prefix: anything else (traceback, plain text) is dropped
const parseComposerLogLine = (line: string): ComposerLogLine | null => {
  const start = line.indexOf('{');
  if (start === -1) {
    return null;
  }
  try {
    const parsed = JSON.parse(line.slice(start));
    return parsed && typeof parsed === 'object' ? parsed as ComposerLogLine : null;
  } catch {
    return null;
  }
};

// Every string of a value, nested objects and arrays included: pycti wraps the meta of a log in an "attributes" object
const collectStrings = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
};

// NaN when the line has no timestamp, or one that is not a date: such a line is never after nor at a date
const timeOf = (timestamp: unknown) => (typeof timestamp === 'string' ? new Date(timestamp).getTime() : Number.NaN);

const isAfterOrAt = (timestamp: unknown, date: Date | string) => timeOf(timestamp) >= new Date(date).getTime();

/**
 * Looks for an access denied of the source in the logs of a connector, in its last finished run.
 * The lines are bounded by time: most connectors log at the error level by default, so the end of run marker (INFO) is usually absent.
 * When markers are there, the last run is also what follows the second-to-last one: the last marker closes it,
 * the one before closes the run preceding it.
 * A line without a date is ignored: its age cannot be judged.
 *
 * @param lines the lines of the composer logs of the connector, oldest first
 * @param options.platformHost the host of the platform, whose calls are ignored
 * @param options.nextRunDatetime the date at which the connector was expected to run next
 * @param options.evaluatedAt the date of the evaluation
 * @param options.notBefore the lines logged at or before it are ignored. Null or absent: every dated line is read
 * @returns the most recent access denied, or null when there is none or the snapshot is too old to tell
 */
export const findAccessDeniedInComposerLogs = (
  lines: string[],
  options: { platformHost?: string; nextRunDatetime?: Date | string | null; evaluatedAt: string; notBefore?: Date | string | null },
): AccessDenied | null => {
  const { platformHost, nextRunDatetime, evaluatedAt, notBefore } = options;
  const parsedLines = lines.map(parseComposerLogLine).filter((line): line is ComposerLogLine => line !== null);
  // No line since the expected next run while it is overdue: the snapshot says nothing about the current state
  if (nextRunDatetime
    && new Date(evaluatedAt).getTime() > new Date(nextRunDatetime).getTime() + STALE_SNAPSHOT_TOLERANCE_MS
    && !parsedLines.some((line) => isAfterOrAt(line.timestamp, nextRunDatetime))) {
    return null;
  }
  const markerIndexes = parsedLines.flatMap((line, index) => (line.message === RUN_END_MARKER ? [index] : []));
  const lastRunStart = markerIndexes.length >= 2 ? markerIndexes[markerIndexes.length - 2] + 1 : 0;
  const lastRunLines = parsedLines.slice(lastRunStart);
  const notBeforeTime = notBefore ? new Date(notBefore).getTime() : Number.NEGATIVE_INFINITY;
  // The error may be in any field (message, reason, exc_info...): the most recent line telling an access denied wins
  for (const line of lastRunLines.reverse()) {
    if (line.level === 'ERROR' && timeOf(line.timestamp) > notBeforeTime) {
      for (const text of collectStrings(line)) {
        const accessDenied = parseAccessDenied(text, platformHost);
        if (accessDenied) {
          return accessDenied;
        }
      }
    }
  }
  return null;
};
