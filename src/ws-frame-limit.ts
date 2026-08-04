// The ceilings an op can hit, measured before it is sent.
//
// Duplicated from the server's `frameExceedsWsLimit` / `op-blob.ts`
// rather than imported: this package ships unbundled and can only import
// its own relative files. The server owns the contract; these follow it.

// The transport does not deliver a message above this. It closes the
// connection instead, taking down everything else multiplexed onto the
// socket, so an oversized frame must never be sent.
const WS_FRAME_MAX_BYTES = 128 * 1024;

// What one stored record holds inline. Past it the blob is uploaded
// straight to storage rather than carried in a request body, so this is
// where the write path changes shape, not where it stops.
const OP_ROW_MAX_BLOB_CHARS = 350 * 1024;

// The largest op the platform accepts. A single value past this cannot
// be split (a record is the merge unit, so one assignment is the
// smallest thing a commit carries), which is why the refusal points at
// storing the bulk as a file instead.
const MAX_OP_BLOB_CHARS = 8 * 1024 * 1024;

export interface OpFrame {
  type: 'op';
  topic: string;
  op_blob: string;
  client_op_id: string;
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
  return envelopeChars + frame.op_blob.length > WS_FRAME_MAX_BYTES;
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
