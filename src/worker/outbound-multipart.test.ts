import { describe, it, expect } from 'vitest';

import {
  attachOutboundMultipartFiles,
  buildOutboundMultipartBody,
  outboundMultipartFilename,
  parseOutboundMultipartBody,
  parseOutboundMultipartFilename,
} from './outbound-multipart.js';
import type { WorkerOutboundCallbackPayload } from './types.js';

describe('outbound multipart', () => {
  it('round-trips metadata and file attachments', () => {
    const metadata: WorkerOutboundCallbackPayload = {
      workspace_id: 'ws-1',
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      outbound: [
        {
          id: 'msg-1',
          kind: 'chat',
          channel_type: 'zoho-cliq',
          platform_id: 'zoho-cliq:chat-1',
          thread_id: null,
          content: { text: 'Here is the PDF', files: ['trip.pdf'] },
          files: [{ filename: 'trip.pdf' }],
        },
      ],
    };
    const pdf = Buffer.from('%PDF-1.4 test');
    const { body, contentType } = buildOutboundMultipartBody(metadata, [
      { messageId: 'msg-1', filename: 'trip.pdf', data: pdf },
    ]);
    const boundary = contentType.match(/boundary=(.+)$/)?.[1];
    expect(boundary).toBeTruthy();

    const parsed = parseOutboundMultipartBody(body, boundary!, { maxFileBytes: 1024 * 1024 });
    expect(parsed.metadata.session_id).toBe('sess-1');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].filename).toBe('trip.pdf');
    expect(parsed.files[0].messageId).toBe('msg-1');
    expect(parsed.files[0].data.equals(pdf)).toBe(true);

    const attached = attachOutboundMultipartFiles(parsed.metadata, parsed.files);
    expect(attached.outbound[0].file_buffers?.[0].data.equals(pdf)).toBe(true);
  });

  it('rejects files over max size', () => {
    const metadata: WorkerOutboundCallbackPayload = {
      workspace_id: 'ws-1',
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      outbound: [],
    };
    const big = Buffer.alloc(200);
    const { body, contentType } = buildOutboundMultipartBody(metadata, [
      { messageId: 'msg-1', filename: 'big.bin', data: big },
    ]);
    const boundary = contentType.match(/boundary=(.+)$/)?.[1]!;
    expect(() => parseOutboundMultipartBody(body, boundary, { maxFileBytes: 100 })).toThrow(
      /exceeds max size/i,
    );
  });

  it('parses composite filenames', () => {
    const composite = outboundMultipartFilename('msg-abc', 'itinerary.pdf');
    expect(parseOutboundMultipartFilename(composite)).toEqual({
      messageId: 'msg-abc',
      filename: 'itinerary.pdf',
    });
    expect(parseOutboundMultipartFilename('../evil.pdf')).toBeNull();
  });
});
