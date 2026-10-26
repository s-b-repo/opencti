import { describe, expect, it } from 'vitest';
import { type ConnectorWork, getConclusiveWork, getWorkFailure } from '../../../../src/modules/ingestionHealth/ingestionHealth-connectorWorks';
import type { ConnectorInfo } from '../../../../src/modules/connector/connector-types';

const RUN_END = '2026-10-26T11:00:00.000Z';
const state = (last_work?: ConnectorWork, connector_type = 'EXTERNAL_IMPORT', last_run_datetime: string | null = RUN_END) => ({
  connector_type,
  connector_info: { last_run_datetime } as ConnectorInfo,
  last_work,
});

describe('getConclusiveWork', () => {
  it('should be conclusive for a processed work of the last run', () => {
    const work = { timestamp: '2026-10-26T10:59:00Z', processed_time: '2026-10-26T10:59:58Z' };
    expect(getConclusiveWork(state(work))).toBe(work);
  });

  it('should not be conclusive for an open or force-closed work (no processed_time)', () => {
    expect(getConclusiveWork(state({ timestamp: '2026-10-26T10:59:00Z', processed_time: null }))).toBeUndefined();
  });

  it('should not be conclusive when the last run left no work (processed long before last_run_datetime)', () => {
    expect(getConclusiveWork(state({ timestamp: '2026-10-26T09:59:00Z', processed_time: '2026-10-26T09:59:58Z' }))).toBeUndefined();
  });

  it('should skip the last run rule when last_run_datetime is unknown', () => {
    const work = { timestamp: '2026-10-26T09:59:00Z', processed_time: '2026-10-26T09:59:58Z' };
    expect(getConclusiveWork(state(work, 'EXTERNAL_IMPORT', null))).toBe(work);
  });

  it('should not be conclusive without any work (purged)', () => {
    expect(getConclusiveWork(state(undefined))).toBeUndefined();
  });
});

describe('getWorkFailure', () => {
  it('should decide the failure on entries without source, and read the CONNECTOR messages first', () => {
    const work = {
      timestamp: 't',
      processed_time: 't',
      errors: [
        { message: '{"type":"indicator"}', source: '{"id":"x"}' },
        { message: 'Connector\'s work finished gracefully', source: null },
        { message: '401 Client Error: Unauthorized for url: https://api.example.com/x', source: 'CONNECTOR' },
      ],
    };
    expect(getWorkFailure(work)).toEqual({
      failed: true,
      messages: ['401 Client Error: Unauthorized for url: https://api.example.com/x', 'Connector\'s work finished gracefully'],
    });
  });

  it('should not count worker errors (with a source other than CONNECTOR) as a failure', () => {
    expect(getWorkFailure({ timestamp: 't', errors: [{ message: 'Element is too large', source: 'Element x' }] }).failed).toBe(false);
  });
});
