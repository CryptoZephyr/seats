import { describe, expect, it } from "vitest";
import { isAllowedSeatArtworkMedia } from "./SeatArtwork";

describe("isAllowedSeatArtworkMedia", () => {
  it("allows SVG data URIs and HTTPS media", () => {
    expect(isAllowedSeatArtworkMedia("data:image/svg+xml;base64,PHN2Zy8+")).toBe(true);
    expect(isAllowedSeatArtworkMedia("https://example.test/seat.svg")).toBe(true);
  });

  it("rejects other data types and non-HTTPS URLs", () => {
    expect(isAllowedSeatArtworkMedia("data:image/png;base64,AAAA")).toBe(false);
    expect(isAllowedSeatArtworkMedia("http://example.test/seat.svg")).toBe(false);
    expect(isAllowedSeatArtworkMedia("javascript:alert(1)")).toBe(false);
    expect(isAllowedSeatArtworkMedia(null)).toBe(false);
  });
});
