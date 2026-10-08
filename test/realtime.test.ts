/* eslint-disable max-classes-per-file -- focused fake Worker runtime */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PETITION_ID } from "../src/petition";
import { PetitionRealtime } from "../src/realtime";
import type { PulseRow } from "../src/storage";

const validPayload = (signatureCount: number) => ({
  id: PETITION_ID,
  isClosed: false,
  signatureClosingDate: "2027-01-15T00:00:00+13:00",
  signatureCount,
  status: { statusName: "Open" },
});

const NativeResponse = globalThis.Response;

class FakeSocket {
  readonly messages: string[] = [];
  close = vi.fn<() => void>();
  send = (message: string) => this.messages.push(message);
}

class FakeResponse {
  readonly status: number;
  readonly webSocket: FakeSocket | undefined;
  readonly body: unknown;

  constructor(
    _body: BodyInit | null,
    init?: ResponseInit & { webSocket?: FakeSocket }
  ) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
    this.body = _body;
  }

  static json(body: unknown, init?: ResponseInit): FakeResponse {
    return new FakeResponse(
      JSON.stringify(body),
      init as ResponseInit & { webSocket?: FakeSocket }
    );
  }
}

class FakeDatabase {
  rows: PulseRow[] = [];
  writes: { args: readonly unknown[]; sql: string }[] = [];

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        all: () =>
          Promise.resolve({
            results: this.rows.toSorted((a, b) => b.checked_at - a.checked_at),
          }),
        run: () => {
          this.writes.push({ args, sql });
          const [checkedAt, second, status, isClosed, closingAt] = args;
          if (sql.includes("'ok'")) {
            this.rows.unshift({
              checked_at: Number(checkedAt),
              closing_at: String(closingAt),
              error_code: null,
              is_closed: Number(isClosed),
              outcome: "ok",
              petition_status: String(status),
              signature_count: Number(second),
            });
          } else {
            this.rows.unshift({
              checked_at: Number(checkedAt),
              closing_at: null,
              error_code: second as PulseRow["error_code"],
              is_closed: null,
              outcome: "error",
              petition_status: null,
              signature_count: null,
            });
          }
          return Promise.resolve({ success: true });
        },
      }),
      first: () => {
        const filtered = sql.includes("WHERE outcome = 'ok'")
          ? this.rows.filter((row) => row.outcome === "ok")
          : this.rows;
        return Promise.resolve(
          [...filtered].toSorted((a, b) => b.checked_at - a.checked_at)[0] ??
            null
        );
      },
    };
  }
}

class FakeState {
  readonly values = new Map<string, unknown>();
  readonly sockets: FakeSocket[] = [];
  readonly alarms: number[] = [];
  deletedAlarms = 0;

  storage = {
    deleteAlarm: () => {
      this.deletedAlarms += 1;
      return Promise.resolve();
    },
    get: <T>(key: string) =>
      Promise.resolve(this.values.get(key) as T | undefined),
    getAlarm: () => Promise.resolve(this.alarms.at(-1) ?? null),
    put: (key: string, value: unknown) => {
      this.values.set(key, value);
      return Promise.resolve();
    },
    setAlarm: (time: number) => {
      this.alarms.push(time);
      return Promise.resolve();
    },
  };

  acceptWebSocket(socket: FakeSocket) {
    this.sockets.push(socket);
  }

  getWebSockets() {
    return this.sockets;
  }
}

const makeRuntime = (initialCount = 12_357) => {
  const state = new FakeState();
  const DB = new FakeDatabase();
  if (initialCount >= 0) {
    DB.rows.push({
      checked_at: Date.now() - 10_000,
      closing_at: "2027-01-15T00:00:00+13:00",
      error_code: null,
      is_closed: 0,
      outcome: "ok",
      petition_status: "Open",
      signature_count: initialCount,
    });
  }
  const env = { DB } as unknown as Env;
  const object = new PetitionRealtime(
    state as unknown as DurableObjectState,
    env
  );
  return { DB, object, state };
};

const connect = async (object: PetitionRealtime) => {
  const response = await object.fetch(
    new Request("https://petition.test/connect", {
      headers: { Upgrade: "websocket" },
    })
  );
  return response as unknown as FakeResponse;
};

const readMessage = (socket: FakeSocket, index = 0) =>
  JSON.parse(socket.messages[index] ?? "{}") as {
    errorCode: string | null;
    snapshot: { signatureCount: number } | null;
    type: string;
  };

describe("petition Durable Object", () => {
  beforeEach(() => {
    vi.stubGlobal("Response", FakeResponse);
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = new FakeSocket();
        1 = new FakeSocket();
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the newest persisted count as soon as the first client connects", async () => {
    const { object, state } = makeRuntime();
    const response = await connect(object);

    expect(response.status).toBe(101);
    expect(response.webSocket).toBeDefined();
    expect(readMessage(state.sockets[0] as FakeSocket)).toMatchObject({
      snapshot: { signatureCount: 12_357 },
      type: "state",
    });
    expect(state.alarms).toHaveLength(1);
  });

  it("shares one count across clients and broadcasts a real jump once", async () => {
    const { DB, object, state } = makeRuntime();
    await connect(object);
    await connect(object);
    const clients = [...state.sockets];
    const fetch = vi.fn<() => Promise<Response>>(() =>
      Promise.resolve(NativeResponse.json(validPayload(12_360)))
    );
    vi.stubGlobal("fetch", fetch);

    await object.alarm();

    expect(fetch).toHaveBeenCalledOnce();
    expect(DB.writes).toHaveLength(1);
    for (const client of clients) {
      expect(client.messages).toHaveLength(2);
      expect(readMessage(client, 1).snapshot?.signatureCount).toBe(12_360);
    }
  });

  it("does not broadcast or write D1 for unchanged two-second samples", async () => {
    const { DB, object, state } = makeRuntime();
    await connect(object);
    const client = state.sockets[0] as FakeSocket;
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(() =>
        Promise.resolve(NativeResponse.json(validPayload(12_357)))
      )
    );

    await object.alarm();

    expect(client.messages).toHaveLength(1);
    expect(DB.writes).toHaveLength(0);
    expect(state.alarms.at(-1)).toBeGreaterThan(Date.now());
  });

  it("rejects malformed upstream data and preserves the last good count on failure", async () => {
    const { object, state } = makeRuntime();
    await connect(object);
    const client = state.sockets[0] as FakeSocket;
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(() =>
        Promise.resolve(NativeResponse.json(validPayload(-4)))
      )
    );

    await object.alarm();

    expect(readMessage(client, 1)).toMatchObject({
      errorCode: "invalid_payload",
      snapshot: { signatureCount: 12_357 },
    });
    expect(state.sockets).toHaveLength(1);
  });

  it("keeps the last good count when Parliament is unreachable", async () => {
    const { object, state } = makeRuntime();
    await connect(object);
    const client = state.sockets[0] as FakeSocket;
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(() =>
        Promise.reject(new Error("network unavailable"))
      )
    );

    await object.alarm();

    expect(readMessage(client, 1)).toMatchObject({
      errorCode: "upstream_unreachable",
      snapshot: { signatureCount: 12_357 },
    });
  });

  it("reschedules polling when persistence fails during an alarm", async () => {
    const { object, state, DB } = makeRuntime();
    await connect(object);
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(() =>
        Promise.resolve(new Response(null, { status: 503 }))
      )
    );
    vi.spyOn(DB, "prepare").mockImplementation(() => {
      throw new Error("D1 unavailable");
    });

    await expect(object.alarm()).rejects.toThrow("D1 unavailable");

    expect(state.alarms.at(-1)).toBeGreaterThan(Date.now());
  });

  it("re-arms a missing alarm from cron while clients remain connected", async () => {
    const { object, state } = makeRuntime();
    await connect(object);
    state.alarms.length = 0;

    const response = await object.fetch(new Request("https://realtime/cron"));

    expect(response.status).toBe(200);
    expect(state.alarms).toHaveLength(1);
    expect(state.alarms[0]).toBeLessThanOrEqual(Date.now());
  });

  it("recovers state for a reconnect and stops alarms after the last disconnect", async () => {
    const { DB, object, state } = makeRuntime();
    await connect(object);
    const socket = state.sockets[0] as FakeSocket;
    state.sockets.splice(0, 1);
    await object.webSocketClose(socket as unknown as WebSocket);
    const fetch = vi.fn<() => Promise<Response>>(() =>
      Promise.resolve(NativeResponse.json(validPayload(12_357)))
    );
    vi.stubGlobal("fetch", fetch);

    await object.alarm();
    expect(fetch).not.toHaveBeenCalled();
    expect(state.deletedAlarms).toBe(1);

    const restartedObject = new PetitionRealtime(
      state as unknown as DurableObjectState,
      { DB } as unknown as Env
    );
    await connect(restartedObject);
    expect(
      readMessage(state.sockets[0] as FakeSocket).snapshot?.signatureCount
    ).toBe(12_357);
  });
});
