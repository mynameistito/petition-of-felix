import { describe, expect, it, vi } from "vitest";

import { renderOverlayHtml } from "../src/overlay";
import {
  fetchPetitionSnapshot,
  parsePetitionPayload,
  PETITION_API_URL,
  PETITION_ID,
} from "../src/petition";

const validPayload = {
  id: PETITION_ID,
  isClosed: false,
  signatureClosingDate: "2027-01-15T00:00:00+13:00",
  signatureCount: 12_357,
  status: { statusName: "Open" },
};

describe(parsePetitionPayload, () => {
  it("projects a valid Parliament payload", () => {
    expect(parsePetitionPayload(validPayload)).toStrictEqual({
      closingAt: "2027-01-15T00:00:00+13:00",
      isClosed: false,
      signatureCount: 12_357,
      status: "Open",
    });
  });

  it.each([
    null,
    {},
    { ...validPayload, id: "another-petition" },
    { ...validPayload, signatureCount: -1 },
    { ...validPayload, signatureCount: 1.5 },
    { ...validPayload, status: {} },
  ])("rejects malformed boundary input", (payload) => {
    expect(parsePetitionPayload(payload)).toBeNull();
  });
});

describe(fetchPetitionSnapshot, () => {
  it("calls the public JSON endpoint and parses the response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(validPayload));

    await expect(fetchPetitionSnapshot(fetcher)).resolves.toStrictEqual({
      ok: true,
      snapshot: {
        closingAt: "2027-01-15T00:00:00+13:00",
        isClosed: false,
        signatureCount: 12_357,
        status: "Open",
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      PETITION_API_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "application/json" }),
      })
    );
  });

  it("classifies network, HTTP, and JSON failures", async () => {
    const unreachable = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("not persisted"));
    const httpError = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const invalidJson = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 200 }));

    await expect(fetchPetitionSnapshot(unreachable)).resolves.toStrictEqual({
      errorCode: "upstream_unreachable",
      ok: false,
    });
    await expect(fetchPetitionSnapshot(httpError)).resolves.toStrictEqual({
      errorCode: "upstream_http_error",
      ok: false,
    });
    await expect(fetchPetitionSnapshot(invalidJson)).resolves.toStrictEqual({
      errorCode: "invalid_payload",
      ok: false,
    });
  });
});

describe(renderOverlayHtml, () => {
  it("renders a transparent live-count overlay", () => {
    const html = renderOverlayHtml();

    expect(html).toContain("background: transparent");
    expect(html).toContain('fetch("/api/current"');
    expect(html).toContain('class="status"');
    expect(html).toContain('class="count"');
  });

  it("uses separate shared sockets for live and demo counters", () => {
    const html = renderOverlayHtml();

    expect(html).toContain('const endpoint = demo ? "/demo-ws" : "/ws"');
    expect(html).toContain(
      'sendDemo({ amount: Number(button.dataset.add), type: "add" })'
    );
    expect(html).toContain('sendDemo({ type: "reset" })');
    expect(html).toContain("if (!demo)");
    expect(html).toContain(
      "if (stopped || socket !== null || !navigator.onLine)"
    );
  });

  it("renders larger demo increments and a live-count reference", () => {
    const html = renderOverlayHtml();

    expect(html).toContain('data-add="100">+100</button>');
    expect(html).toContain('data-add="1000">+1000</button>');
    expect(html).toContain('id="custom-amount" type="number"');
    expect(html).toContain('id="live-count"');
  });

  it("counts through each intermediate value for multi-count updates", () => {
    const html = renderOverlayHtml();

    expect(html).toContain("stagger: 'none'");
    expect(html).toContain("const countStepIntervalMs = 1000 / 30");
    expect(html).toContain("const step = current < value ? 1 : -1");
    expect(html).toContain("countFrame = requestAnimationFrame(advance)");
  });

  it("uses the first demo snapshot as its initial count", () => {
    const html = renderOverlayHtml();

    expect(html).not.toContain("setCount(0)");
    expect(html).toContain("if (hasValue) {");
  });

  it("reserves count width and settles each rolling step before the next", () => {
    const html = renderOverlayHtml();

    expect(html).toContain("flex: 0 0 max-content");
    expect(html).toContain("duration: 24");
  });
});
