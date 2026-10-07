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
      .live-count {
        border: 1px solid rgb(255 255 255 / 0.38);
        border-radius: 999px;
        padding: 7px 11px 6px;
        background: #1c3240;
        color: #fff;
        font-size: 13px;
        font-weight: 700;
        line-height: 1;
      }
      .demo-controls form { display: inline-flex; align-items: center; gap: 6px; }
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
      .demo-controls input {
        width: 88px;
        border: 1px solid rgb(255 255 255 / 0.38);
        border-radius: 999px;
        padding: 7px 10px;
        background: rgb(0 0 0 / 0.65);
        color: #fff;
        font: inherit;
        font-size: 13px;
      }
      .demo-controls input:focus-visible { outline: 2px solid #38e0ae; outline-offset: 2px; }
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
      <span class="live-count" id="live-count" hidden aria-label="Latest recorded live petition count"></span>
      <div class="demo-controls" aria-label="Demo controls">
        <button type="button" data-add="100">+100</button>
        <button type="button" data-add="1000">+1000</button>
        <form id="custom-form">
          <input id="custom-amount" type="number" min="1" step="1" inputmode="numeric" placeholder="Custom" aria-label="Custom demo increment">
          <button type="submit" aria-label="Add custom amount">+</button>
        </form>
        <button type="button" id="reset">Reset</button>
      </div>
    </main>
    <script>
      import('https://esm.sh/@kitlangton/rolling-number@0.4.1').then(({ createRollingNumber }) => {
        const count = document.querySelector('#count');
        const counter = createRollingNumber(count, {
          value: Number(count.dataset.value ?? 0),
          locales: 'en-NZ',
          duration: 100,
          stagger: 'none',
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
      const countStepIntervalMs = 1000 / 30;
      let hasValue = false;
      const demo = new URLSearchParams(location.search).has("demo");
      const demoQueue = [];
      if (demo) {
        overlay.dataset.demo = "true";
        status.textContent = "Demo";
        overlay.dataset.state = "ready";
        void refreshLiveCount();
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

      let countFrame = null;
      let animationTarget = null;

      function animateCountTo(value) {
        const current = Number(count.dataset.value);
        if (!Number.isSafeInteger(current)) {
          setCount(value);
          return;
        }
        if (animationTarget === value && countFrame !== null) return;
        if (countFrame !== null) cancelAnimationFrame(countFrame);
        if (current === value) {
          animationTarget = value;
          countFrame = null;
          return;
        }

        animationTarget = value;
        const step = current < value ? 1 : -1;
        let nextStepAt = 0;
        function advance(timestamp) {
          if (timestamp >= nextStepAt) {
            const next = Number(count.dataset.value) + step;
            setCount(next);
            if (next === value) {
              countFrame = null;
              animationTarget = null;
              return;
            }
            nextStepAt = timestamp + countStepIntervalMs;
          }
          countFrame = requestAnimationFrame(advance);
        }
        countFrame = requestAnimationFrame(advance);
      }

      async function refreshLiveCount() {
        const liveCount = document.querySelector("#live-count");
        try {
          const response = await fetch("/api/current", { cache: "no-store" });
          if (!response.ok) return;
          const payload = await response.json();
          if (!Number.isSafeInteger(payload.signatureCount) || payload.signatureCount < 0) return;
          liveCount.textContent = "Live: " + formatter.format(payload.signatureCount);
          liveCount.hidden = false;
        } catch {
          // The demo counter remains usable when the live count is unavailable.
        }
      }

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
      document.querySelector("#custom-form").addEventListener("submit", (event) => {
        event.preventDefault();
        if (!demo) return;
        const input = document.querySelector("#custom-amount");
        const amount = Number(input.value);
        if (!Number.isSafeInteger(amount) || amount < 1) {
          input.reportValidity();
          return;
        }
        sendDemo({ amount, type: "add" });
        input.value = "";
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
        const current = Number(count.dataset.value);
        if (current !== value) {
          if (hasValue) {
            animateCountTo(value);
          } else {
            setCount(value);
          }
        }
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
        if (countFrame !== null) cancelAnimationFrame(countFrame);
        countFrame = null;
        animationTarget = null;
        socket?.close();
        socket = null;
      }, { once: true });
    </script>
  </body>
  </html>`;
