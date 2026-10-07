/**
 * Renders the broadcast overlay served at the Worker root.
 * The document canvas remains transparent for OBS/browser-source compositing.
 */
export const renderOverlayHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Felix petition signatures</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@kitlangton/rolling-number@0.4.1/dist/styles.css">
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }
      body {
        display: flex;
        align-items: flex-start;
        justify-content: flex-start;
        padding: 10px;
        font-family: "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif;
      }
      .overlay {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
        white-space: nowrap;
      }
      .status {
        border: 1px solid rgb(255 255 255 / 0.38);
        border-radius: 999px;
        padding: 7px 11px 6px;
        background: #38e0ae;
        color: #07281e;
        font-size: 13px;
        font-weight: 900;
        letter-spacing: 0.1em;
        line-height: 1;
        text-transform: uppercase;
        box-shadow:
          inset 0 1px 0 rgb(255 255 255 / 0.5),
          0 2px 12px rgb(0 0 0 / 0.28);
      }
      .count {
        min-width: 0;
        color: #fff;
        font-size: clamp(40px, 8vw, 60px);
        font-variant-numeric: tabular-nums;
        font-weight: 900;
        letter-spacing: -0.045em;
        line-height: 0.9;
      }
      .count .rn-value,
      .count .rn-visual,
      .count .rn-token {
        color: #fff;
        font: inherit;
      }
      .overlay[data-state="loading"] .count { opacity: 0.55; }
      .overlay[data-state="error"] .status {
        background: #ff6b5e;
        color: #310805;
      }
      .demo-controls {
        display: none;
        align-items: center;
        gap: 6px;
        margin-left: 4px;
      }
      .overlay[data-demo="true"] .demo-controls { display: inline-flex; }
      .demo-controls button {
        border: 1px solid rgb(255 255 255 / 0.38);
        border-radius: 999px;
        padding: 7px 10px;
        background: rgb(0 0 0 / 0.65);
        color: #fff;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      }
      .demo-controls button:focus-visible { outline: 2px solid #38e0ae; outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) {
        .rn-digit, .rn-digit * { animation-duration: 0.01ms !important; }
      }
    </style>
  </head>
  <body>
    <main class="overlay" data-state="loading" aria-label="Petition signature count">
      <span class="status" id="status">Checking</span>
      <strong class="count" id="count" aria-label="--" aria-live="polite">--</strong>
      <span class="demo-controls" aria-label="Demo controls">
        <button type="button" data-add="1">+1</button>
        <button type="button" data-add="10">+10</button>
        <button type="button" id="reset">Reset</button>
      </span>
    </main>
    <script>
      import('https://esm.sh/@kitlangton/rolling-number@0.4.1').then(({ createRollingNumber }) => {
        const count = document.querySelector('#count');
        const counter = createRollingNumber(count, {
          value: Number(count.dataset.value ?? 0),
          locales: 'en-NZ',
          duration: 650,
        });
        count.dataset.rollingReady = 'true';
        window.rollingCounter = counter;
      });
    </script>
    <script>
      const overlay = document.querySelector(".overlay");
      const status = document.querySelector("#status");
      const count = document.querySelector("#count");
      const formatter = new Intl.NumberFormat("en-NZ");
      let hasValue = false;
      const demo = new URLSearchParams(location.search).has("demo");
      const demoQueue = [];
      if (demo) {
        overlay.dataset.demo = "true";
        status.textContent = "Demo";
        overlay.dataset.state = "ready";
        hasValue = true;
      }

      function setCount(value) {
        count.dataset.value = String(value);
        count.setAttribute("aria-label", formatter.format(value));
        if (window.rollingCounter) {
          window.rollingCounter.update({ value });
        } else {
          count.textContent = formatter.format(value);
        }
      }

      if (demo) setCount(0);

      function sendDemo(command) {
        const message = JSON.stringify(command);
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(message);
        } else {
          demoQueue.push(message);
        }
      }

      document.querySelectorAll("[data-add]").forEach((button) => {
        button.addEventListener("click", () => {
          if (demo) {
            sendDemo({ amount: Number(button.dataset.add), type: "add" });
          }
        });
      });
      document.querySelector("#reset").addEventListener("click", () => {
        if (demo) sendDemo({ type: "reset" });
      });

      async function refresh() {
        if (demo || hasValue) return;
        try {
          const response = await fetch("/api/current", { cache: "no-store" });
          if (!response.ok) throw new Error("count unavailable");
          const payload = await response.json();
          if (!Number.isSafeInteger(payload.signatureCount) || payload.signatureCount < 0) {
            throw new Error("invalid count");
          }
          if (!hasValue) applyCount(payload.signatureCount);
        } catch {
          if (!hasValue) {
            status.textContent = "Offline";
            overlay.dataset.state = "error";
          }
        }
      }

      function applyCount(value) {
        if (!Number.isSafeInteger(value) || value < 0) return;
        if (Number(count.dataset.value) !== value) setCount(value);
        status.textContent = demo ? "Demo" : "Signed";
        overlay.dataset.state = "ready";
        hasValue = true;
      }

      let socket = null;
      let reconnectTimer = null;
      let reconnectAttempts = 0;
      let stopped = false;
      function scheduleReconnect() {
        if (stopped || reconnectTimer !== null) return;
        const base = Math.min(30000, 500 * (2 ** Math.min(reconnectAttempts, 6)));
        const delay = Math.round(base * (0.8 + Math.random() * 0.4));
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      }

      function connect() {
        if (stopped || socket !== null || !navigator.onLine) {
          if (!navigator.onLine && !hasValue) {
            status.textContent = "Offline";
            overlay.dataset.state = "error";
          }
          return;
        }
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const endpoint = demo ? "/demo-ws" : "/ws";
        const nextSocket = new WebSocket(protocol + "//" + location.host + endpoint);
        socket = nextSocket;
        nextSocket.addEventListener("open", () => {
          reconnectAttempts = 0;
          if (demo) {
            for (const message of demoQueue.splice(0)) nextSocket.send(message);
          } else {
            nextSocket.send("resync");
          }
        });
        nextSocket.addEventListener("message", (event) => {
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (demo && message.type === "demo") {
            applyCount(message.count);
            return;
          }
          if (message.type !== "state") return;
          if (message.snapshot) applyCount(message.snapshot.signatureCount);
          if (message.errorCode && !hasValue) {
            status.textContent = "Offline";
            overlay.dataset.state = "error";
          } else if (message.errorCode && hasValue) {
            status.textContent = "Stale";
            overlay.dataset.state = "error";
          }
        });
        nextSocket.addEventListener("close", () => {
          if (socket === nextSocket) socket = null;
          if (!hasValue) {
            status.textContent = "Offline";
            overlay.dataset.state = "error";
          }
          scheduleReconnect();
        });
        nextSocket.addEventListener("error", () => nextSocket.close());
      }

      if (!demo) void refresh();
      connect();
      window.addEventListener("online", connect);
      window.addEventListener("offline", () => {
        if (!hasValue) {
          status.textContent = "Offline";
          overlay.dataset.state = "error";
        }
      });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && socket?.readyState === WebSocket.OPEN) {
          socket.send("resync");
        } else if (!document.hidden) {
          connect();
        }
      });
      window.addEventListener("pagehide", () => {
        stopped = true;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        socket?.close();
        socket = null;
      }, { once: true });
    </script>
  </body>
  </html>`;
