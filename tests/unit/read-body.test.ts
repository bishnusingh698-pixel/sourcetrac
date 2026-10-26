import { data } from "react-router";
import { describe, expect, it } from "vitest";

import { readBodyText, toResponse } from "../../app/lib/http.server";

/** A body with no Content-Length, the way a chunked upload arrives. */
function streamed(text: string): Request {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.slice(i, i + 1024));
      controller.close();
    },
  });
  return new Request("https://example.com", { method: "POST", body, duplex: "half" } as RequestInit);
}

describe("readBodyText", () => {
  it("returns a small body intact", async () => {
    expect(await readBodyText(streamed('{"a":"ü"}'), 4096)).toBe('{"a":"ü"}');
  });

  it("refuses an oversized body that declares no length", async () => {
    expect(await readBodyText(streamed("x".repeat(10_000)), 4096)).toBeNull();
  });

  it("refuses an oversized declared length without reading it", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "x",
      headers: { "content-length": "999999" },
    });
    expect(await readBodyText(request, 4096)).toBeNull();
  });
});

describe("toResponse", () => {
  // Every extension response once went out as {"type":"DataWithResponseInit",...},
  // so the block read `enabled` as undefined and hid the survey on every order.
  it("unwraps data() and keeps its status and headers", async () => {
    const res = toResponse(data({ a: 1 }, { status: 201, headers: { "X-Test": "1" } }));
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Test")).toBe("1");
    expect(await res.json()).toEqual({ a: 1 });
  });
});
