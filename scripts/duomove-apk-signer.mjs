// Read signer certificate digests straight out of an APK Signature Scheme v2/v3 block.
//
// `dumpsys package` does not print certificate digests on every Android version, and the
// acceptance run needs the signer identity to tell a rebuilt artifact from this one (checklist
// A08/G01). Parsing the APK itself avoids depending on a dumpsys output shape that varies.
//
// Format reference: https://source.android.com/docs/security/features/apksigning/v2
import { createHash } from 'node:crypto';

const EOCD_SIGNATURE = 0x06054b50;
const BLOCK_MAGIC = 'APK Sig Block 42';
const SCHEME_IDS = new Map([[0x7109871a, 'v2'], [0xf05368c0, 'v3']]);

function findEocd(buffer) {
  // The comment field is at most 65535 bytes, so the EOCD starts within the last 64 KiB + 22.
  const earliest = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('APK end-of-central-directory record was not found');
}

/** Length-prefixed (uint32 LE) sequence reader over a slice. */
function* sequence(buffer) {
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    if (length === 0 || offset + length > buffer.length) return;
    yield buffer.subarray(offset, offset + length);
    offset += length;
  }
}

function first(iterator) {
  for (const value of iterator) return value;
  return undefined;
}

function certificatesFromSigners(block) {
  const digests = [];
  const signers = first(sequence(block));
  if (!signers) return digests;
  for (const signer of sequence(signers)) {
    const signedData = first(sequence(signer));
    if (!signedData) continue;
    const parts = [...sequence(signedData)];
    // signed data is: digests, certificates, additional attributes.
    const certificates = parts[1];
    if (!certificates) continue;
    for (const der of sequence(certificates)) {
      digests.push({
        sha256: createHash('sha256').update(der).digest('hex'),
        sha1: createHash('sha1').update(der).digest('hex'),
        derBytes: der.length,
      });
    }
  }
  return digests;
}

/**
 * Returns `{ schemes, signers, v1Present }` for an APK buffer.
 * `signers` holds one entry per certificate found, tagged with the scheme that carried it.
 */
export function readApkSigners(buffer) {
  const eocd = findEocd(buffer);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  if (centralDirectoryOffset < 24 || centralDirectoryOffset > buffer.length) {
    throw new Error('APK central directory offset is out of range');
  }
  if (buffer.subarray(centralDirectoryOffset - 16, centralDirectoryOffset).toString('latin1') !== BLOCK_MAGIC) {
    return { schemes: [], signers: [], signingBlockPresent: false };
  }
  const trailingSize = Number(buffer.readBigUInt64LE(centralDirectoryOffset - 24));
  const blockStart = centralDirectoryOffset - trailingSize - 8;
  if (blockStart < 0 || Number(buffer.readBigUInt64LE(blockStart)) !== trailingSize) {
    throw new Error('APK signing block size fields disagree');
  }

  const signers = [];
  const schemes = [];
  let offset = blockStart + 8;
  const end = centralDirectoryOffset - 24;
  while (offset + 12 <= end) {
    const pairSize = Number(buffer.readBigUInt64LE(offset));
    if (pairSize < 4 || offset + 8 + pairSize > centralDirectoryOffset) break;
    const id = buffer.readUInt32LE(offset + 8);
    const value = buffer.subarray(offset + 12, offset + 8 + pairSize);
    const scheme = SCHEME_IDS.get(id);
    if (scheme) {
      schemes.push(scheme);
      for (const certificate of certificatesFromSigners(value)) signers.push({ scheme, ...certificate });
    }
    offset += 8 + pairSize;
  }
  return { schemes, signers, signingBlockPresent: true };
}

/** v1 (JAR) signing leaves `META-INF/*.SF` entries; their absence is itself a finding. */
export function hasV1Signature(buffer) {
  return /META-INF\/[^/]+\.(SF|RSA|DSA|EC)/i.test(buffer.toString('latin1'));
}
