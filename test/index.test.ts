import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { PETITION_ID } from "../src/petition";

const validPayload = {
  id: PETITION_ID,
  isClosed: false,
  signatureClosingDate: "2027-01-15T00:00:00+13:00",
  signatureCount: 12_357,
  status: { statusName: "Open" },
};

type RecordedRun = Readonly<{ args: readonly unknown[]; sql: string }>;

const fakeDatabase = (): { DB: D1Database; runs: RecordedRun[] } => {
  const runs: RecordedRun[] = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: () => {
          runs.push({ args, sql });
          return Promise.resolve({ success: true });
        },
      }),
    }),
  } as unknown as D1Database;
  return { DB, runs };
};

const invokeScheduled = (DB: D1Database, scheduledTime: number) =>
  worker.scheduled(
    { scheduledTime } as ScheduledController,
    { DB } as unknown as Env
  );

describe("scheduled pulse", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records a failed pulse and resolves when upstream returns an HTTP error", async () => {
    const checkedAt = 1_789_650_885_000;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(null, { status: 503 }))
      )
    );
    const { DB, runs } = fakeDatabase();

    await expect(invokeScheduled(DB, checkedAt)).resolves.toBeUndefined();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.sql).toContain("INSERT INTO pulse_checks");
    expect(runs[0]?.args).toStrictEqual([checkedAt, "upstream_http_error"]);
  });

  it("records a successful pulse when upstream responds", async () => {
    const checkedAt = 1_789_650_885_000;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(Response.json(validPayload)))
    );
    const { DB, runs } = fakeDatabase();

    await expect(invokeScheduled(DB, checkedAt)).resolves.toBeUndefined();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.sql).toContain("INSERT INTO pulse_checks");
    expect(runs[0]?.args?.[0]).toBe(checkedAt);
    expect(runs[0]?.args?.[1]).toBe(12_357);
  });
});
