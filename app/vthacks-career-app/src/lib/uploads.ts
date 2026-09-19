/**
 * uploads.ts — put the original bytes in a Unity Catalog Volume.
 *
 * Why store the file at all, when we only want the extracted fields: because the
 * app's local filesystem is ephemeral (Databricks Apps wipes it on redeploy) and
 * because keeping the PDF is what makes RE-EXTRACTION possible. When the prompt or
 * the schema improves, we re-run over the stored originals. Discard the bytes and
 * that door is closed forever.
 *
 * Path: /Volumes/workspace/vthacks_2026/uploads/<user_id>/<kind>/<sha256>.<ext>
 *
 * Content-addressed on purpose. The same file uploaded twice lands on the same
 * object instead of accumulating copies, which pairs with the (user_id,
 * content_hash) idempotency check in intake.ts.
 */
import { createHash } from 'node:crypto';

import { bearerToken, databricksHost, DatabricksError } from '@/lib/databricks';

export const VOLUME_ROOT = '/Volumes/workspace/vthacks_2026/uploads';

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Only used to build a tidy path — the real type check happens in intake.ts. */
function extensionFor(mimeType: string | undefined, fileName: string | undefined): string {
  if (mimeType === 'application/pdf') return 'pdf';
  const fromName = fileName?.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  return fromName ?? 'bin';
}

/**
 * user_id and kind reach a URL path, so they are constrained rather than trusted.
 * user_id is a server-generated UUID and kind is one of our own literals, but a
 * path-traversal guard next to the string interpolation is cheaper than reasoning
 * about every future caller.
 */
function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new DatabricksError(`Unsafe ${label} for a volume path: ${JSON.stringify(value)}`);
  }
  return value;
}

export type StoredFile = {
  storagePath: string;
  contentHash: string;
  byteSize: number;
};

/**
 * Upload bytes and return where they landed.
 *
 * overwrite=true is safe precisely because the name is the content hash: an
 * overwrite can only ever replace identical bytes.
 */
export async function putUpload(args: {
  userId: string;
  kind: string;
  bytes: Uint8Array;
  fileName?: string;
  mimeType?: string;
}): Promise<StoredFile> {
  const { userId, kind, bytes, fileName, mimeType } = args;
  const contentHash = sha256(bytes);
  const extension = extensionFor(mimeType, fileName);
  const storagePath = `${VOLUME_ROOT}/${safeSegment(userId, 'user id')}/${safeSegment(kind, 'kind')}/${contentHash}.${extension}`;

  const res = await fetch(
    `${databricksHost()}/api/2.0/fs/files${storagePath}?overwrite=true`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await bearerToken()}`,
        'content-type': 'application/octet-stream',
      },
      // Buffer, not the raw Uint8Array: undici rejects some typed-array views.
      body: Buffer.from(bytes),
      cache: 'no-store',
    },
  );

  if (!res.ok) {
    throw new DatabricksError(
      `Volume upload failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }

  return { storagePath, contentHash, byteSize: bytes.byteLength };
}
