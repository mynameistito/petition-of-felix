import { renderOverlayHtml } from "./overlay";
import { fetchPetitionSnapshot, PETITION_ID } from "./petition";
import {
  getHistory,
  getLatestCheck,
  getLatestSuccess,
  recordFailure,
  recordSuccess,
} from "./storage";
import type { PulseRow } from "./storage";

const JSON_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

const HEALTH_MAX_AGE_MS = 8 * 60 * 1000;

type PublicPulse = Readonly<{
  checkedAt: string;
  closingAt: string | null;
  errorCode: string | null;
  isClosed: boolean | null;
  outcome: "error" | "ok";
  petitionStatus: string | null;
  signatureCount: number | null;
}>;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { headers: JSON_HEADERS, status });

const toPublicPulse = (row: PulseRow): PublicPulse => ({
  checkedAt: new Date(row.checked_at).toISOString(),
  closingAt: row.closing_at,
  errorCode: row.error_code,
  isClosed: row.is_closed === null ? null : row.is_closed === 1,
  outcome: row.outcome,
  petitionStatus: row.petition_status,
  signatureCount: row.signature_count,
});

const parseHistoryLimit = (value: string | null): number | null => {
  if (value === null) {
    return 100;
  }
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1440
    ? parsed
    : null;
};

const handleFetch = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  if (url.pathname === "/") {
    return new Response(renderOverlayHtml(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  if (url.pathname === "/api/current") {
    const [latestSuccess, latestCheck] = await Promise.all([
      getLatestSuccess(env.DB),
      getLatestCheck(env.DB),
    ]);
    if (latestSuccess === null || latestCheck === null) {
      return json({ error: "no_pulses_recorded" }, 404);
    }
    return json({
      latestCheck: toPublicPulse(latestCheck),
      petitionId: PETITION_ID,
      signatureCount: latestSuccess.signature_count,
      signatureCountCheckedAt: new Date(latestSuccess.checked_at).toISOString(),
    });
  }

  if (url.pathname === "/api/history") {
    const limit = parseHistoryLimit(url.searchParams.get("limit"));
    if (limit === null) {
      return json({ error: "limit_must_be_an_integer_from_1_to_1440" }, 400);
    }
    const rows = await getHistory(env.DB, limit);
    return json({
      petitionId: PETITION_ID,
      pulses: rows.map(toPublicPulse),
    });
  }

  if (url.pathname === "/health") {
    const latestCheck = await getLatestCheck(env.DB);
    const healthy =
      latestCheck !== null &&
      latestCheck.outcome === "ok" &&
      Date.now() - latestCheck.checked_at <= HEALTH_MAX_AGE_MS;
    return json(
      {
        healthy,
        latestCheck: latestCheck === null ? null : toPublicPulse(latestCheck),
      },
      healthy ? 200 : 503
    );
  }

  return json({ error: "not_found" }, 404);
};

/** Cloudflare Worker entry point for the public API and minute cron pulse. */
export default {
  fetch(request, env): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(controller, env): Promise<void> {
    const checkedAt = controller.scheduledTime;
    const result = await fetchPetitionSnapshot();
    if (!result.ok) {
      await recordFailure(env.DB, checkedAt, result.errorCode);
      console.error(
        JSON.stringify({
          checkedAt,
          errorCode: result.errorCode,
          event: "petition_pulse_failed",
        })
      );
      return;
    }

    await recordSuccess(env.DB, checkedAt, result.snapshot);
    console.log(
      JSON.stringify({
        checkedAt,
        event: "petition_pulse_succeeded",
        signatureCount: result.snapshot.signatureCount,
      })
    );
  },
} satisfies ExportedHandler<Env>;
