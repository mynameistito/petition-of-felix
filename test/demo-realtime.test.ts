/* eslint-disable max-classes-per-file -- focused fake Worker runtime */
/* eslint-disable promise/prefer-await-to-callbacks -- mirrors storage.transaction API */
/* eslint-disable no-await-in-loop -- the test asserts ordered counter increments */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PetitionDemoRealtime } from "../src/demo-realtime";

class FakeSocket {
  readonly messages: string[] = [];
  close = vi.fn<() => void>();
  send = (message: string) => this.messages.push(message);
}

class FakeResponse {
  readonly status: number;
  readonly webSocket: FakeSocket | undefined;

  constructor(
    _body: BodyInit | null,
    init?: ResponseInit & { webSocket?: FakeSocket }
  ) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  }

  static json(body: unknown, init?: ResponseInit): FakeResponse {
    return new FakeResponse(
      JSON.stringify(body),
      init as ResponseInit & { webSocket?: FakeSocket }
    );
  }
}

class FakeState {
  readonly values = new Map<string, unknown>();
  readonly sockets: FakeSocket[] = [];
  storage = {
    get: <T>(key: string) =>
      Promise.resolve(this.values.get(key) as T | undefined),
    transaction: <T>(
      callback: (transaction: DurableObjectTransaction) => Promise<T>
    ) =>
      callback({
        get: <V>(key: string) =>
          Promise.resolve(this.values.get(key) as V | undefined),
        put: (key: string, value: unknown) => {
          this.values.set(key, value);
          return Promise.resolve();
        },
      } as unknown as DurableObjectTransaction),
  };

  acceptWebSocket(socket: FakeSocket) {
    this.sockets.push(socket);
  }

  getWebSockets() {
    return this.sockets;
  }
}

const connect = async (object: PetitionDemoRealtime) =>
  (await object.fetch(
    new Request("https://petition.test/connect", {
      headers: { Upgrade: "websocket" },
    })
  )) as unknown as FakeResponse;

const messageCount = (socket: FakeSocket, index: number): number => {
  const message = JSON.parse(socket.messages[index] ?? "{}") as {
    count: number;
    type: string;
  };
  expect(message.type).toBe("demo");
  return message.count;
};

describe("shared demo Durable Object", () => {
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

  it("sends the same demo count to browsers and broadcasts additions", async () => {
    const state = new FakeState();
    const object = new PetitionDemoRealtime(
      state as unknown as DurableObjectState
    );
    await connect(object);
    await connect(object);
    const [first, second] = state.sockets;

    await object.webSocketMessage(
      first as unknown as WebSocket,
      JSON.stringify({ amount: 10, type: "add" })
    );

    expect(messageCount(first as FakeSocket, 0)).toBe(0);
    expect(messageCount(first as FakeSocket, 1)).toBe(10);
    expect(messageCount(second as FakeSocket, 0)).toBe(0);
    expect(messageCount(second as FakeSocket, 1)).toBe(10);
  });

  it("shares reset and recovers the current value for a newly connected browser", async () => {
    const state = new FakeState();
    const object = new PetitionDemoRealtime(
      state as unknown as DurableObjectState
    );
    await connect(object);
    const [first] = state.sockets;
    await object.webSocketMessage(
      first as unknown as WebSocket,
      JSON.stringify({ amount: 1, type: "add" })
    );

    await object.webSocketMessage(
      first as unknown as WebSocket,
      JSON.stringify({ type: "reset" })
    );
    const response = await connect(object);

    expect(response.status).toBe(101);
    expect(messageCount(state.sockets[0] as FakeSocket, 2)).toBe(0);
    expect(messageCount(state.sockets[1] as FakeSocket, 0)).toBe(0);
  });

  it("accepts preset and custom positive whole-number increments", async () => {
    const state = new FakeState();
    const object = new PetitionDemoRealtime(
      state as unknown as DurableObjectState
    );
    await connect(object);
    const socket = state.sockets[0] as FakeSocket;

    for (const amount of [100, 1000, 37]) {
      await object.webSocketMessage(
        socket as unknown as WebSocket,
        JSON.stringify({ amount, type: "add" })
      );
    }

    expect(messageCount(socket, 3)).toBe(1137);
  });

  it("rejects non-positive, fractional, and unsafe demo increments", async () => {
    const state = new FakeState();
    const object = new PetitionDemoRealtime(
      state as unknown as DurableObjectState
    );
    await connect(object);
    const socket = state.sockets[0] as FakeSocket;

    await Promise.all(
      [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((amount) =>
        object.webSocketMessage(
          socket as unknown as WebSocket,
          JSON.stringify({ amount, type: "add" })
        )
      )
    );

    expect(socket.close).toHaveBeenCalledWith(1003, "Invalid demo command");
  });
});
