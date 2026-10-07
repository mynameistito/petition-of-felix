import { fetchPetitionSnapshot } from "./petition";
import type { PetitionFetchErrorCode, PetitionSnapshot } from "./petition";
import {
  getLatestCheck,
  getLatestSuccess,
  recordFailure,
  recordSuccess,
} from "./storage";
import type { PulseRow } from "./storage";

declare global {
  interface Env {
    PETITION_REALTIME: DurableObjectNamespace;
    PETITION_DEMO_REALTIME: DurableObjectNamespace;
  }
}

const POLL_INTERVAL_MS = 2000;
const PERSIST_INTERVAL_MS = 5 * 60_000;

type RealtimeState = Readonly<{
  errorCode: PetitionFetchErrorCode | null;
  lastCheckedAt: number | null;
  lastFailureAt: number | null;
  lastPersistedAt: number | null;
  snapshot: PetitionSnapshot | null;
}>;

type StateMessage = Readonly<{
  checkedAt: string | null;
  errorCode: PetitionFetchErrorCode | null;
  snapshot: PetitionSnapshot | null;
  type: "state";
}>;

const EMPTY_STATE: RealtimeState = {
  errorCode: null,
  lastCheckedAt: null,
  lastFailureAt: null,
  lastPersistedAt: null,
  snapshot: null,
};

const responseJson = (value: unknown, status = 200): Response =>
  Response.json(value, {
    headers: { "cache-control": "no-store" },
    status,
  });

const snapshotFromRow = (row: PulseRow): PetitionSnapshot => ({
  closingAt: row.closing_at ?? "",
  isClosed: row.is_closed === 1,
  signatureCount: row.signature_count ?? 0,
  status: row.petition_status ?? "Unknown",
});

/** One hibernating, singleton coordinator for the Felix petition. */
export class PetitionRealtime {
  private pollInFlight = false;
  private state: RealtimeState | null = null;
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return responseJson({ error: "websocket_required" }, 426);
      }

      await this.loadState();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.stateMessage()));
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now());
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state") {
      await this.loadState();
      return responseJson(this.stateMessage());
    }

    if (url.pathname === "/cron") {
      await this.loadState();
      const clients = this.ctx.getWebSockets().length;
      if (clients === 0) {
        await this.poll();
      }
      return responseJson({ clients, ok: true });
    }

    return responseJson({ error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      return;
    }
    await this.poll();
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (message !== "resync") {
      return;
    }
    try {
      await this.loadState();
      socket.send(JSON.stringify(this.stateMessage()));
    } catch {
      socket.close(1011, "Unable to load state");
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    socket.close();
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "WebSocket error");
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async loadState(): Promise<RealtimeState> {
    if (this.state !== null) {
      return this.state;
    }
    const stored = await this.ctx.storage.get<RealtimeState>("state");
    if (stored !== undefined) {
      this.state = stored;
      return stored;
    }

    const [success, latestCheck] = await Promise.all([
      getLatestSuccess(this.env.DB),
      getLatestCheck(this.env.DB),
    ]);
    this.state = {
      ...EMPTY_STATE,
      errorCode:
        latestCheck?.outcome === "error" ? latestCheck.error_code : null,
      lastCheckedAt: latestCheck?.checked_at ?? null,
      lastFailureAt:
        latestCheck?.outcome === "error" ? latestCheck.checked_at : null,
      lastPersistedAt: success?.checked_at ?? null,
      snapshot: success === null ? null : snapshotFromRow(success),
    };
    await this.ctx.storage.put("state", this.state);
    return this.state;
  }

  private stateMessage(): StateMessage {
    const state = this.state ?? EMPTY_STATE;
    return {
      checkedAt:
        state.lastCheckedAt === null
          ? null
          : new Date(state.lastCheckedAt).toISOString(),
      errorCode: state.errorCode,
      snapshot: state.snapshot,
      type: "state",
    };
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const previous = await this.loadState();
      const checkedAt = Date.now();
      const result = await fetchPetitionSnapshot();
      if (!result.ok) {
        await this.handleFailure(previous, checkedAt, result.errorCode);
        return;
      }
      await this.handleSuccess(previous, checkedAt, result.snapshot);
    } finally {
      this.pollInFlight = false;
    }
  }

  private async handleFailure(
    previous: RealtimeState,
    checkedAt: number,
    errorCode: PetitionFetchErrorCode
  ): Promise<void> {
    const shouldPersist =
      previous.errorCode !== errorCode ||
      previous.lastFailureAt === null ||
      checkedAt - previous.lastFailureAt >= PERSIST_INTERVAL_MS;
    const next: RealtimeState = {
      ...previous,
      errorCode,
      lastCheckedAt: checkedAt,
      lastFailureAt: shouldPersist ? checkedAt : previous.lastFailureAt,
    };
    if (shouldPersist) {
      await recordFailure(this.env.DB, checkedAt, errorCode);
      await this.ctx.storage.put("state", next);
    }
    this.state = next;
    if (previous.errorCode !== errorCode) {
      this.broadcast();
    }
  }

  private async handleSuccess(
    previous: RealtimeState,
    checkedAt: number,
    snapshot: PetitionSnapshot
  ): Promise<void> {
    const changed =
      previous.snapshot?.signatureCount !== snapshot.signatureCount;
    const heartbeatDue =
      previous.lastPersistedAt === null ||
      checkedAt - previous.lastPersistedAt >= PERSIST_INTERVAL_MS;
    const recovered = previous.errorCode !== null;
    const shouldPersist = changed || heartbeatDue || recovered;
    if (shouldPersist) {
      await recordSuccess(this.env.DB, checkedAt, snapshot);
    }
    const next: RealtimeState = {
      errorCode: null,
      lastCheckedAt: checkedAt,
      lastFailureAt: null,
      lastPersistedAt: shouldPersist ? checkedAt : previous.lastPersistedAt,
      snapshot,
    };
    if (shouldPersist) {
      await this.ctx.storage.put("state", next);
    }
    this.state = next;
    if (changed || recovered) {
      this.broadcast();
    }
  }

  private broadcast(): void {
    const message = JSON.stringify(this.stateMessage());
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "Unable to send state");
      }
    }
  }
}

/** Returns the stable singleton stub used by every route and cron event. */
export const getPetitionRealtime = (env: Env): DurableObjectStub => {
  const id = env.PETITION_REALTIME.idFromName("felix-petition");
  return env.PETITION_REALTIME.get(id);
};

/** Returns the independent demo-only singleton, separate from live petition state. */
export const getPetitionDemoRealtime = (env: Env): DurableObjectStub => {
  const id = env.PETITION_DEMO_REALTIME.idFromName("felix-petition-demo");
  return env.PETITION_DEMO_REALTIME.get(id);
};
