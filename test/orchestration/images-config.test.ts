import { describe, expect, it } from "vitest";
import { parseRouteConfig, RouteConfigError } from "../../src/orchestration/routing.js";

describe("image model configuration", () => {
  it("accepts an optional image model and positive timeout", () => {
    expect(parseRouteConfig({ routes: {}, images: { model: "cliproxyapi-images/gpt-image-2.5" } }).images).toEqual({ model: "cliproxyapi-images/gpt-image-2.5" });
    expect(parseRouteConfig({ routes: {}, images: { model: "p/nested/model", timeoutMs: 180000 } }).images).toEqual({ model: "p/nested/model", timeoutMs: 180000 });
    expect(parseRouteConfig({ routes: {} }).images).toBeUndefined();
  });
  it.each([null, [], "p/image", {}, { model: "image" }, { model: "/image" }, { model: "p/" }, { model: "p/image " }, { model: "p/image:high" }, { model: 1 }, { model: "p/image", quality: "low" }])("rejects invalid images object %#", images => {
    expect(() => parseRouteConfig({ routes: {}, images })).toThrow(RouteConfigError);
    expect(() => parseRouteConfig({ routes: {}, images })).toThrow("config.images");
  });
  it.each([0, -1, NaN, Infinity, "180000", null, true])("rejects invalid timeout %#", timeoutMs => {
    expect(() => parseRouteConfig({ routes: {}, images: { model: "p/image", timeoutMs } })).toThrow("config.images.timeoutMs");
  });
});
