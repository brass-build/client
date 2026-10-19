// The ceilings an op can hit, measured before it is sent.

// The client's own SEND bound, deliberately smaller than the platform's
// 128 KiB server-push bound: the two are different limits, not one shared
// constant. A frame over this closes the connection, taking every other op
// and presence down with it, and the reconnect re-sends the oversized
// frame, so the document never saves anything. The transport also caps a
// message at 128 KiB, but the frame binds first in a browser: it negotiates
// `permessage-deflate` and Chromium sends a message as one frame, so what
// gets through depends on how the op compresses (43,264 bytes for
// incompressible base64, measured). Staying at the frame limit is what makes
// the bound independent of the content.
/** @internal Exported so a test can pin it against the server's bound. */
export const WS_SEND_FRAME_MAX_BYTES = 32 * 1024;

// Past this the blob is uploaded to storage and the write names the staged
// object instead of carrying it. Set by what a request body delivers
// (6,289,920 bytes measured), with room for the envelope and headers. Not a
// ceiling on op size.
/** @internal Exported so a test can size against it rather than restate it. */
export const OP_ROW_MAX_BLOB_CHARS = 5 * 1024 * 1024;

// The largest op the platform accepts. A single value past this cannot be
// split (a record is the merge unit), which is why the refusal points at
// storing the bulk as a file instead.
/** @internal Exported so a producer can derive its ceiling from it. */
export const MAX_OP_BLOB_CHARS = 8 * 1024 * 1024;

export interface OpFrame {
  type: 'op';
  topic: string;
  op_blob: string;
  client_op_id: string;
  base_import_seq?: number;
}

/**
 * True when the serialized frame would exceed what the socket carries.
 *
 * The envelope is measured with the blob emptied, so a multi-megabyte
 * value is never serialized just to be counted. Every byte is ASCII
 * (base64 blob, topic, id), so length is byte length.
 */
export function opFrameExceedsWsLimit(frame: OpFrame): boolean {
  const envelopeChars = JSON.stringify({ ...frame, op_blob: '' }).length;
  return envelopeChars + frame.op_blob.length > WS_SEND_FRAME_MAX_BYTES;
}

/** True when the blob is too large to ride in a request body, so it is
 *  uploaded to storage first and the write names the staged object. */
export function opBlobNeedsStaging(opBlobB64: string): boolean {
  return opBlobB64.length > OP_ROW_MAX_BLOB_CHARS;
}

/** True when no single op can hold the blob, so the server could only
 *  refuse it. Checked locally to save an upload that ends in a 400. */
export function opBlobExceedsDurableLimit(opBlobB64: string): boolean {
  return opBlobB64.length > MAX_OP_BLOB_CHARS;
}
