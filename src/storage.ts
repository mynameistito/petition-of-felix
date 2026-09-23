import type { PetitionFetchErrorCode, PetitionSnapshot } from "./petition";

/** A persisted pulse row as returned by D1. */
export type PulseRow = Readonly<{
  checked_at: number;
  closing_at: string | null;
  error_code: PetitionFetchErrorCode | null;
  is_closed: number | null;
  outcome: "error" | "ok";
  petition_status: string | null;
  signature_count: number | null;
}>;

/** Records a successful check, idempotently keyed by its scheduled timestamp. */
export const recordSuccess = async (
  database: D1Database,
  checkedAt: number,
  snapshot: PetitionSnapshot
): Promise<void> => {
  await database
    .prepare(
      `INSERT INTO pulse_checks (
        checked_at, outcome, signature_count, petition_status, is_closed, closing_at, error_code
      ) VALUES (?, 'ok', ?, ?, ?, ?, NULL)
      ON CONFLICT(checked_at) DO UPDATE SET
        outcome = excluded.outcome,
        signature_count = excluded.signature_count,
        petition_status = excluded.petition_status,
        is_closed = excluded.is_closed,
        closing_at = excluded.closing_at,
        error_code = NULL`
    )
    .bind(
      checkedAt,
      snapshot.signatureCount,
      snapshot.status,
      snapshot.isClosed ? 1 : 0,
      snapshot.closingAt
    )
    .run();
};

/** Records a classified failed check without persisting arbitrary error text. */
export const recordFailure = async (
  database: D1Database,
  checkedAt: number,
  errorCode: PetitionFetchErrorCode
): Promise<void> => {
  await database
    .prepare(
      `INSERT INTO pulse_checks (
        checked_at, outcome, signature_count, petition_status, is_closed, closing_at, error_code
      ) VALUES (?, 'error', NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(checked_at) DO UPDATE SET
        outcome = excluded.outcome,
        signature_count = NULL,
        petition_status = NULL,
        is_closed = NULL,
        closing_at = NULL,
        error_code = excluded.error_code`
    )
    .bind(checkedAt, errorCode)
    .run();
};

/** Returns the most recently attempted pulse, if one exists. */
export const getLatestCheck = (
  database: D1Database
): Promise<PulseRow | null> =>
  database
    .prepare("SELECT * FROM pulse_checks ORDER BY checked_at DESC LIMIT 1")
    .first<PulseRow>();

/** Returns the most recent successful pulse, if one exists. */
export const getLatestSuccess = (
  database: D1Database
): Promise<PulseRow | null> =>
  database
    .prepare(
      "SELECT * FROM pulse_checks WHERE outcome = 'ok' ORDER BY checked_at DESC LIMIT 1"
    )
    .first<PulseRow>();

/** Returns up to the requested number of pulse rows, newest first. */
export const getHistory = async (
  database: D1Database,
  limit: number
): Promise<readonly PulseRow[]> => {
  const result = await database
    .prepare("SELECT * FROM pulse_checks ORDER BY checked_at DESC LIMIT ?")
    .bind(limit)
    .all<PulseRow>();
  return result.results;
};
