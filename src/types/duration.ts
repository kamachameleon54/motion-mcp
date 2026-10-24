import { MotionError } from '../core/errors.js';
/**
 * Motion's API accepts duration as the literal strings "NONE" | "REMINDER"
 * or a positive integer of minutes. MCP transports frequently deliver numeric
 * values as strings (e.g. "120"), which Motion rejects with a 400. Normalize
 * here so numeric strings become integers before they reach the API.
 */
export function normalizeDuration(value: string | number | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value;
    throw new MotionError('invalid_duration', 'Duration must be a positive integer of minutes.');
  }
  const upper = value.trim().toUpperCase();
  if (upper === 'NONE' || upper === 'REMINDER') return upper;
  const minutes = Number(value);
  if (Number.isFinite(minutes) && Number.isSafeInteger(minutes) && minutes > 0) {
    return minutes;
  }
  throw new MotionError(
    'invalid_duration',
    `Invalid duration "${value}": use "NONE", "REMINDER", or minutes as a positive integer`
  );
}
