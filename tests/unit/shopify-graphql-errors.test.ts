import { describe, expect, it } from "vitest";
import { httpErrorDetail } from "../../app/lib/shopify-graphql.server";

// A refused Admin API call used to surface as a bare "Shopify returned 401",
// which told the merchant nothing and left the cause only in the logs.
describe("httpErrorDetail", () => {
  it("reads Shopify's string form", () => {
    expect(httpErrorDetail('{"errors":"[API] Invalid API key or access token (unrecognized login or wrong password)"}')).toBe(
      "[API] Invalid API key or access token (unrecognized login or wrong password)",
    );
  });

  it("reads the list form", () => {
    expect(httpErrorDetail('{"errors":[{"message":"Access denied"},{"message":"Try later"}]}')).toBe(
      "Access denied; Try later",
    );
  });

  it("yields nothing for a body that is not Shopify's error JSON", () => {
    expect(httpErrorDetail("<html>Bad gateway</html>")).toBeNull();
    expect(httpErrorDetail("")).toBeNull();
    expect(httpErrorDetail('{"errors":""}')).toBeNull();
    expect(httpErrorDetail("null")).toBeNull();
  });

  it("caps the detail so a long body cannot flood the page", () => {
    expect(httpErrorDetail(JSON.stringify({ errors: "x".repeat(1000) }))?.length).toBe(200);
  });
});
