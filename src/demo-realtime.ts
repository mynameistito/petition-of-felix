type DemoMessage = Readonly<{ count: number; type: "demo" }>;

type DemoCommand =
  | Readonly<{ amount: number; type: "add" }>
  | Readonly<{ type: "reset" }>;

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { headers: { "cache-control": "no-store" }, status });

/** Shared demo counter; it has no access to petition polling or D1. */
export class PetitionDemoRealtime {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    if (
      new URL(request.url).pathname !== "/connect" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return json({ error: "websocket_required" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const count = (await this.ctx.storage.get<number>("demoCount")) ?? 0;
    server.send(JSON.stringify(PetitionDemoRealtime.message(count)));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (message === "resync") {
      const count = (await this.ctx.storage.get<number>("demoCount")) ?? 0;
      socket.send(JSON.stringify(PetitionDemoRealtime.message(count)));
      return;
    }
    if (typeof message !== "string") {
      socket.close(1003, "Expected a text command");
      return;
    }

    const command = PetitionDemoRealtime.parseCommand(message);
    if (command === null) {
      socket.close(1003, "Invalid demo command");
      return;
    }

    const count = await this.ctx.storage.transaction(async (transaction) => {
      const current = (await transaction.get<number>("demoCount")) ?? 0;
      const next = command.type === "reset" ? 0 : current + command.amount;
      if (!Number.isSafeInteger(next)) {
        return current;
      }
      await transaction.put("demoCount", next);
      return next;
    });
    this.broadcast(count);
  }

  private static parseCommand(message: string): DemoCommand | null {
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const command = value as Record<string, unknown>;
    if (command["type"] === "reset") {
      return { type: "reset" };
    }
    return command["type"] === "add" &&
      (command["amount"] === 1 || command["amount"] === 10)
      ? { amount: command["amount"], type: "add" }
      : null;
  }

  private static message(count: number): DemoMessage {
    return { count, type: "demo" };
  }

  private broadcast(count: number): void {
    const message = JSON.stringify(PetitionDemoRealtime.message(count));
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "Unable to send demo state");
      }
    }
  }
}
