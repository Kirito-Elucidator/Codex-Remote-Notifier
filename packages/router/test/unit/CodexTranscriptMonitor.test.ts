import { describe, expect, it } from 'vitest';

import { parseTranscriptCompletion } from '../../src/codex/CodexTranscriptMonitor';

describe('CodexTranscriptMonitor', () => {
  it('extracts only a structured terminal completion error', () => {
    const completion = parseTranscriptCompletion(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'private partial answer',
          error: {
            message:
              'stream disconnected before completion: stream closed before response.completed',
            codex_error_info: {
              response_stream_disconnected: { http_status_code: 502 },
            },
          },
        },
      }),
    );

    expect(completion).toEqual({
      turnId: 'turn-1',
      error: {
        message: 'stream disconnected before completion: stream closed before response.completed',
        code: 'responseStreamDisconnected',
        http_status_code: 502,
      },
    });
    expect(JSON.stringify(completion)).not.toContain('private partial answer');
  });

  it('uses successful and interrupted terminal records only to close the watched turn', () => {
    expect(
      parseTranscriptCompletion(
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'turn-completed' },
        }),
      ),
    ).toEqual({ turnId: 'turn-completed' });
    expect(
      parseTranscriptCompletion(
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'turn_aborted', turn_id: 'turn-interrupted' },
        }),
      ),
    ).toEqual({ turnId: 'turn-interrupted' });
  });

  it('ignores malformed and non-terminal transcript records', () => {
    expect(parseTranscriptCompletion('{invalid')).toBeUndefined();
    expect(
      parseTranscriptCompletion(
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            turn_id: 'turn-1',
            message: 'stream disconnected before completion',
          },
        }),
      ),
    ).toBeUndefined();
  });
});
