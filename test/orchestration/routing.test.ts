import { describe, expect, it, vi } from "vitest";
import { parseRouteConfig, resolveRoute, resolveSpecialistRoute } from "../../src/orchestration/routing.js";

describe.each(["game-asset", "video"])("specialist routing: %s", role => {
  it("always honours an explicit route without checking model availability", () => {
    const config = parseRouteConfig({ routes: { [role]: { model: "explicit/custom", thinking: "low", extendedContext: false } }, default: { model: "anthropic/x", thinking: "high", extendedContext: true } });
    const hasModel = vi.fn(() => true);
    expect(resolveSpecialistRoute(config, role, hasModel)).toEqual({ role, model: "explicit/custom", thinking: "low", extendedContext: false });
    expect(hasModel).not.toHaveBeenCalled();
    expect(resolveSpecialistRoute(parseRouteConfig({ routes: { [role]: { model: "explicit/custom" } } }), role, hasModel).model).toBe("explicit/custom");
  });

  it.each(["anthropic/x", "cliproxyapi/claude-opus-5-5", "custom/family/model"])("uses %s's provider and retains default settings when available", model => {
    const config = parseRouteConfig({ routes: {}, default: { model, thinking: "max", extendedContext: false }, extendedContext: true });
    const hasModel = vi.fn(() => true);
    const provider = model.split("/")[0]!;
    expect(resolveSpecialistRoute(config, role, hasModel)).toEqual({ role, model: `${provider}/claude-opus-5-5`, thinking: "max", extendedContext: false });
    expect(hasModel).toHaveBeenCalledExactlyOnceWith(provider, "claude-opus-5-5");
    expect(config.default?.model).toBe(model);
  });

  it("keeps config-level extendedContext when the default does not specify it", () => {
    const config = parseRouteConfig({ routes: {}, default: { model: "p/base", thinking: "high" }, extendedContext: true });
    expect(resolveSpecialistRoute(config, role, () => true)).toEqual({ role, model: "p/claude-opus-5-5", thinking: "high", extendedContext: true });
  });

  it("falls back to the normal default when the specialist model is unavailable", () => {
    const config = parseRouteConfig({ routes: {}, default: { model: "p/base", thinking: "medium", extendedContext: true } });
    expect(resolveSpecialistRoute(config, role, () => false)).toEqual(resolveRoute(config, role));
  });

  it("preserves the usual no-route error when no default exists", () => {
    const hasModel = vi.fn(() => true);
    expect(() => resolveSpecialistRoute(parseRouteConfig({ routes: {} }), role, hasModel)).toThrow(`No route for role ${role} and no default route`);
    expect(hasModel).not.toHaveBeenCalled();
  });
});

it("leaves other roles and inherited object keys on their normal routes", () => {
  const config = parseRouteConfig({ routes: {}, default: { model: "p/base" } });
  const hasModel = vi.fn(() => true);
  for (const role of ["implementer", "analyst", "verifier", "explorer-path", "toString", "constructor"])
    expect(resolveSpecialistRoute(config, role, hasModel)).toEqual(resolveRoute(config, role));
  expect(hasModel).not.toHaveBeenCalled();
});
