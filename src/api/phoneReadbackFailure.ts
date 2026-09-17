import { HttpError } from "../http/errors.js";
import { KeyDeadError, RateLimitError } from "../types.js";

/** Only locally generated, allowlisted messages may reach the UI or logs. */
export function phoneReadbackFailure(error: unknown): string {
  if (error instanceof RateLimitError) return "DuoPlus is rate limiting phone commands; retrying after its cooldown.";
  if (error instanceof KeyDeadError) return "DuoPlus rejected command authentication. Check the workspace API key.";
  if (error instanceof HttpError) {
    const allowed = [
      "DuoPlus phone command timed out after 10 seconds.",
      "DuoPlus rejected the phone command execution.",
      "DuoPlus phone command response is missing its success flag.",
      "DuoPlus phone command returned no text output.",
      "DuoPlus phone command output exceeded the size limit.",
      "DuoPlus request failed. Check the connection and try again.",
    ];
    if (allowed.includes(error.message)) return error.message;
    if (/^DuoPlus request failed \(code \d+\)$/.test(error.message)) return error.message;
  }
  return "Android location readback failed unexpectedly.";
}
