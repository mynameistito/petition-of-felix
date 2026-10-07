import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { PETITION_ID } from "../src/petition";
import type { PulseRow } from "../src/storage";

const makeDatabase = (rows: PulseRow[]) => {
  const DB = {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        all: () => Promise.resolve({ results: rows }),
        run: () => Promise.resolve({ success: true }),
      }),
      first: () => {
        if (sql.includes("WHERE outcome = 'ok'")) {
          return Promise.resolve(
            rows.find((row) => row.outcome === "ok") ?? null
          );
        }
        return Promise.resolve(rows[0] ?? null);
      },
    }),
  } as unknown as D1Database;
  return DB;
};

const successfulRow: PulseRow = {
  checked_at: 1_800_000_000_000,
  closing_at: "2027-01-15T00:00:00+13:00",
  error_code: null,
  is_closed: 0,
  outcome: "ok",
  petition_status: "Open",
  signature_count: 12_357,
};

describe("HTTP compatibility", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves /api/current", async () => {
    const DB = makeDatabase([successfulRow]);
    const env = { DB } as Env;

    const current = await worker.fetch(
      new Request("https://petition.test/api/current"),
      env
    );
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({
      petitionId: PETITION_ID,
      signatureCount: 12_357,
    });
  });

  it("preserves /api/history", async () => {
    const DB = makeDatabase([successfulRow]);
    const env = { DB } as Env;
    const history = await worker.fetch(
      new Request("https://petition.test/api/history?limit=1"),
      env
    );
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      pulses: [{ signatureCount: 12_357 }],
    });
  });

  it("preserves /health", async () => {
    const DB = makeDatabase([successfulRow]);
    const env = { DB } as Env;
    const health = await worker.fetch(
      new Request("https://petition.test/health"),
      env
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ healthy: true });
  });

  it("routes the five-minute cron to the same stable coordinator", async () => {
    const fetch = vi.fn<() => Promise<Response>>(() =>
      Promise.resolve(new Response(null, { status: 200 }))
    );
    const env = {
      PETITION_REALTIME: {
        get: () => ({ fetch }),
        idFromName: vi.fn<(name: string) => string>((name) => name),
      },
    } as unknown as Env;

    await worker.scheduled({ scheduledTime: 1 } as ScheduledController, env);

    expect(env.PETITION_REALTIME.idFromName).toHaveBeenCalledWith(
      "felix-petition"
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://realtime/cron" })
    );
  });
});
