/** The Parliament petition identifier monitored by this Worker. */
export const PETITION_ID = "1f10c734-0815-4699-b710-08dec0efef41";

/** The public Parliament endpoint that supplies the live signature count. */
export const PETITION_API_URL = `https://petitions.parliament.nz/api/petition/${PETITION_ID}`;

const MAX_FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

const waitBeforeRetry = (attempt: number): Promise<void> =>
  // eslint-disable-next-line promise/avoid-new -- Use the Workers-compatible timer for bounded backoff.
  new Promise((resolve) => {
    setTimeout(() => resolve(), RETRY_DELAY_MS * 2 ** attempt);
  });

/** A parsed, trusted projection of the upstream petition payload. */
export type PetitionSnapshot = Readonly<{
  closingAt: string;
  isClosed: boolean;
  signatureCount: number;
  status: string;
}>;

/** Stable failure categories that are safe to persist and expose. */
export type PetitionFetchErrorCode =
  | "invalid_payload"
  | "upstream_http_error"
  | "upstream_unreachable";

/** The expected result of reading and parsing the public petition API. */
export type PetitionFetchResult =
  | Readonly<{ ok: true; snapshot: PetitionSnapshot }>
  | Readonly<{ errorCode: PetitionFetchErrorCode; ok: false }>;

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isValidSignatureCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Parses the untrusted Parliament API payload into the exact fields used by the
 * checker. Returns null when any required invariant is missing.
 */
export const parsePetitionPayload = (
  value: unknown
): PetitionSnapshot | null => {
  if (
    !isRecord(value) ||
    value["id"] !== PETITION_ID ||
    !isRecord(value["status"])
  ) {
    return null;
  }

  const { signatureCount, isClosed, signatureClosingDate } = value;
  const { statusName } = value["status"];
  if (
    !isValidSignatureCount(signatureCount) ||
    typeof isClosed !== "boolean" ||
    !isNonEmptyString(signatureClosingDate) ||
    !isNonEmptyString(statusName)
  ) {
    return null;
  }

  return {
    closingAt: signatureClosingDate,
    isClosed,
    signatureCount,
    status: statusName,
  };
};

/**
 * Fetches one petition snapshot. Network, HTTP, and payload failures are
 * classified as values so callers can record the failed pulse without logging
 * arbitrary upstream content.
 */
export const fetchPetitionSnapshot = async (
  fetcher: typeof fetch = fetch
): Promise<PetitionFetchResult> => {
  const fetchResponse = async (attempt = 0): Promise<Response | null> => {
    let response: Response;
    try {
      response = await fetcher(PETITION_API_URL, {
        headers: {
          accept: "application/json",
          "user-agent": "petition-of-felix/1.0",
        },
      });
    } catch {
      if (attempt < MAX_FETCH_ATTEMPTS - 1) {
        await waitBeforeRetry(attempt);
        return fetchResponse(attempt + 1);
      }
      return null;
    }

    if (
      response.ok ||
      (response.status < 500 && response.status !== 429) ||
      attempt === MAX_FETCH_ATTEMPTS - 1
    ) {
      return response;
    }

    await waitBeforeRetry(attempt);
    return fetchResponse(attempt + 1);
  };

  const response = await fetchResponse();
  if (response === null) {
    return { errorCode: "upstream_unreachable", ok: false };
  }
  if (!response.ok) {
    return { errorCode: "upstream_http_error", ok: false };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { errorCode: "invalid_payload", ok: false };
  }

  const snapshot = parsePetitionPayload(payload);
  return snapshot === null
    ? { errorCode: "invalid_payload", ok: false }
    : { ok: true, snapshot };
};
