import { HttpError } from '../http/errors.js';
import { sanitizeGpsRejectionText } from './gpsRejectionReason.js';

// Reduce at the credential-aware boundary; never attach Axios config or raw response bodies.
export function providerFailure(path: string, code: number, message: unknown, actualApiKey: string): HttpError {
  const reason = sanitizeGpsRejectionText(message, actualApiKey);
  return new HttpError(502, `DuoPlus ${path} failed (code ${code})${reason ? `: ${reason}` : ''}`);
}
