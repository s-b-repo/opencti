import { describe, expect, it } from 'vitest';
import { findAccessDeniedInComposerLogs, parseAccessDenied, RUN_END_MARKER } from '../../../../src/modules/ingestionHealth/ingestionHealth-accessDenied';

describe('parseAccessDenied', () => {
  it('should read a requests HTTPError', () => {
    expect(parseAccessDenied('401 Client Error: Unauthorized for url: https://api.example.com/v1/feed?key=secret'))
      .toEqual({ http_status: 401, host: 'api.example.com' });
  });
  it('should read an httpx HTTPStatusError', () => {
    expect(parseAccessDenied("Client error '403 Forbidden' for url 'https://api.example.com/x'"))
      .toEqual({ http_status: 403, host: 'api.example.com' });
  });
  it('should read an aiohttp ClientResponseError, with or without URL()', () => {
    expect(parseAccessDenied("402, message='Payment Required', url='https://api.example.com/x'")).toEqual({ http_status: 402, host: 'api.example.com' });
    expect(parseAccessDenied("401, message='Unauthorized', url=URL('https://api.example.com/x')")).toEqual({ http_status: 401, host: 'api.example.com' });
  });
  it('should ignore the statuses not retained', () => {
    expect(parseAccessDenied('429 Client Error: Too Many Requests for url: https://api.example.com/x')).toBeNull();
    expect(parseAccessDenied('500 Server Error: Internal Server Error for url: https://api.example.com/x')).toBeNull();
  });
  it('should ignore the calls to OpenCTI itself', () => {
    expect(parseAccessDenied('401 Client Error: Unauthorized for url: http://opencti:8080/graphql')).toBeNull();
    expect(parseAccessDenied('403 Client Error: Forbidden for url: http://opencti:8080/storage/get/import/x')).toBeNull();
    expect(parseAccessDenied('401 Client Error: Unauthorized for url: https://cti.acme.com/api', 'cti.acme.com')).toBeNull();
  });
  it('should compare the platform hostname without the port, whatever the case', () => {
    expect(parseAccessDenied('401 Client Error: Unauthorized for url: https://cti.acme.com:8443/api', 'cti.acme.com')).toBeNull();
    expect(parseAccessDenied('401 Client Error: Unauthorized for url: https://CTI.acme.com/api', 'Cti.Acme.com')).toBeNull();
    expect(parseAccessDenied('401 Client Error: Unauthorized for url: https://other.acme.com:8443/api', 'cti.acme.com')).toEqual({ http_status: 401, host: 'other.acme.com:8443' });
  });
  it('should return null for a reworded error', () => {
    expect(parseAccessDenied('Invalid API key')).toBeNull();
  });
  it('should keep the status without host when the URL cannot be parsed', () => {
    expect(parseAccessDenied('401 Client Error: Unauthorized for url: not-a-url')).toEqual({ http_status: 401 });
  });
});

describe('findAccessDeniedInComposerLogs', () => {
  const EVALUATED_AT = '2026-10-26T12:00:00.000Z';
  const line = (timestamp: string, level: string, message: string, meta: Record<string, unknown> = {}) => JSON.stringify({ timestamp, level, name: 'c', message, ...meta });
  const MARKER = (timestamp: string) => line(timestamp, 'INFO', RUN_END_MARKER);
  const DENIED = (timestamp: string) => line(timestamp, 'ERROR', 'Error while fetching', { attributes: { reason: '401 Client Error: Unauthorized for url: https://api.example.com/x' } });

  it('should find an access denied in the last finished run, also inside the attributes of the pycti logger', () => {
    const lines = [MARKER('2026-10-26T10:00:00Z'), DENIED('2026-10-26T11:00:01Z'), MARKER('2026-10-26T11:00:02Z')];
    expect(findAccessDeniedInComposerLogs(lines, { evaluatedAt: EVALUATED_AT })).toEqual({ http_status: 401, host: 'api.example.com' });
  });
  it('should find an access denied in the message, or in an array of the attributes', () => {
    const inMessage = line('2026-10-26T11:00:01Z', 'ERROR', '403 Client Error: Forbidden for url: https://api.example.com/x');
    expect(findAccessDeniedInComposerLogs([inMessage], { evaluatedAt: EVALUATED_AT })).toEqual({ http_status: 403, host: 'api.example.com' });
    const inArray = line('2026-10-26T11:00:01Z', 'ERROR', 'failed', { attributes: { errors: [{ reason: '401 Client Error: Unauthorized for url: https://api.example.com/x' }] } });
    expect(findAccessDeniedInComposerLogs([inArray], { evaluatedAt: EVALUATED_AT })).toEqual({ http_status: 401, host: 'api.example.com' });
  });
  it('should ignore an access denied of an older run, before the second-to-last marker', () => {
    const lines = [DENIED('2026-10-26T09:00:01Z'), MARKER('2026-10-26T09:00:02Z'), line('2026-10-26T10:00:00Z', 'INFO', 'ok'), MARKER('2026-10-26T10:00:02Z')];
    expect(findAccessDeniedInComposerLogs(lines, { evaluatedAt: EVALUATED_AT })).toBeNull();
  });
  it('should consider every line when fewer than two markers are in the buffer', () => {
    expect(findAccessDeniedInComposerLogs([DENIED('2026-10-26T11:00:01Z')], { evaluatedAt: EVALUATED_AT })).not.toBeNull();
  });
  it('should only read ERROR lines', () => {
    const warning = line('2026-10-26T11:00:01Z', 'WARNING', '401 Client Error: Unauthorized for url: https://api.example.com/x');
    expect(findAccessDeniedInComposerLogs([warning], { evaluatedAt: EVALUATED_AT })).toBeNull();
  });
  it('should ignore lines that are not JSON, without throwing', () => {
    expect(findAccessDeniedInComposerLogs(['Traceback (most recent call last):', '401 Client Error: Unauthorized for url: https://api.example.com/x'], { evaluatedAt: EVALUATED_AT })).toBeNull();
  });
  it('should ignore a line with a broken JSON object, without throwing', () => {
    expect(findAccessDeniedInComposerLogs(['{"level": "ERROR", "message": '], { evaluatedAt: EVALUATED_AT })).toBeNull();
  });
  it('should conclude nothing on a stale snapshot: no line since the expected next run', () => {
    const lines = [DENIED('2026-10-26T08:00:01Z'), MARKER('2026-10-26T08:00:02Z')];
    expect(findAccessDeniedInComposerLogs(lines, { evaluatedAt: EVALUATED_AT, nextRunDatetime: '2026-10-26T09:00:00Z' })).toBeNull();
  });
  it('should not consider the snapshot stale when a line is newer than the expected next run', () => {
    const lines = [DENIED('2026-10-26T09:30:01Z'), MARKER('2026-10-26T09:30:02Z')];
    expect(findAccessDeniedInComposerLogs(lines, { evaluatedAt: EVALUATED_AT, nextRunDatetime: '2026-10-26T09:00:00Z' })).not.toBeNull();
  });
  it('should not consider the snapshot stale within 10 minutes of the expected next run', () => {
    const lines = [DENIED('2026-10-26T08:00:01Z'), MARKER('2026-10-26T08:00:02Z')];
    expect(findAccessDeniedInComposerLogs(lines, { evaluatedAt: '2026-10-26T09:05:00.000Z', nextRunDatetime: '2026-10-26T09:00:00Z' })).not.toBeNull();
  });
  it('should return the most recent denial, skipping the calls to OpenCTI itself', () => {
    const own = line('2026-10-26T11:00:03Z', 'ERROR', 'x', { reason: '403 Client Error: Forbidden for url: https://cti.acme.com/api' });
    const lines = [DENIED('2026-10-26T11:00:01Z'), own];
    expect(findAccessDeniedInComposerLogs(lines, { evaluatedAt: EVALUATED_AT })).toEqual({ http_status: 403, host: 'cti.acme.com' });
    expect(findAccessDeniedInComposerLogs(lines, { evaluatedAt: EVALUATED_AT, platformHost: 'cti.acme.com' })).toEqual({ http_status: 401, host: 'api.example.com' });
  });
});
