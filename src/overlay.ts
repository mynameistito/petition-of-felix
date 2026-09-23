/**
 * Renders the dependency-free broadcast overlay served at the Worker root.
 * The document canvas remains transparent for OBS/browser-source compositing.
 */
export const renderOverlayHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Felix petition signatures</title>
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
        min-width: 4ch;
        color: #fff;
        font-size: clamp(32px, 8vw, 54px);
        font-variant-numeric: tabular-nums;
        font-weight: 900;
        letter-spacing: -0.045em;
        line-height: 0.9;
        text-shadow:
          0 2px 3px rgb(0 0 0 / 0.9),
          0 5px 18px rgb(0 0 0 / 0.72);
      }
      .overlay[data-state="loading"] .count { opacity: 0.55; }
      .overlay[data-state="error"] .status {
        background: #ff6b5e;
        color: #310805;
      }
      @media (prefers-reduced-motion: no-preference) {
        .count { transition: opacity 180ms ease; }
      }
    </style>
  </head>
  <body>
    <main class="overlay" data-state="loading" aria-label="Petition signature count">
      <span class="status" id="status">Checking</span>
      <strong class="count" id="count" aria-live="polite">--</strong>
    </main>
    <script>
      const overlay = document.querySelector(".overlay");
      const status = document.querySelector("#status");
      const count = document.querySelector("#count");
      const formatter = new Intl.NumberFormat("en-NZ");
      let hasValue = false;

      async function refresh() {
        try {
          const response = await fetch("/api/current", { cache: "no-store" });
          if (!response.ok) throw new Error("count unavailable");
          const payload = await response.json();
          if (!Number.isSafeInteger(payload.signatureCount) || payload.signatureCount < 0) {
            throw new Error("invalid count");
          }
          count.textContent = formatter.format(payload.signatureCount);
          status.textContent = "Signed";
          overlay.dataset.state = "ready";
          hasValue = true;
        } catch {
          status.textContent = hasValue ? "Stale" : "Offline";
          overlay.dataset.state = "error";
        }
      }

      void refresh();
      setInterval(() => void refresh(), 15000);
    </script>
  </body>
  </html>`;
