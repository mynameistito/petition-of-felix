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
    expect(unreachable).toHaveBeenCalledTimes(3);
    await expect(fetchPetitionSnapshot(httpError)).resolves.toStrictEqual({
      errorCode: "upstream_http_error",
      ok: false,
    });
    await expect(fetchPetitionSnapshot(invalidJson)).resolves.toStrictEqual({
      errorCode: "invalid_payload",
      ok: false,
    });
  });

  it("retries transient upstream failures before returning a snapshot", async () => {
    const cancelBody = vi.fn<() => void>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: cancelBody }), {
          status: 503,
        })
      )
      .mockResolvedValueOnce(Response.json(validPayload));

    await expect(fetchPetitionSnapshot(fetcher)).resolves.toStrictEqual({
      ok: true,
      snapshot: {
        closingAt: "2027-01-15T00:00:00+13:00",
        isClosed: false,
        signatureCount: 12_357,
        status: "Open",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it.each([429, 503])(
    "makes exactly three attempts for persistent HTTP %i responses",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status }));

      await expect(fetchPetitionSnapshot(fetcher)).resolves.toStrictEqual({
        errorCode: "upstream_http_error",
        ok: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
    }
  );

  it("does not retry permanent client errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(fetchPetitionSnapshot(fetcher)).resolves.toStrictEqual({
      errorCode: "upstream_http_error",
      ok: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
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
});
