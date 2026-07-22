import { describe, expect, it } from "vitest";
import { agentActionSchema, routeActionSchema } from "./contracts.js";

describe("PSEAgent contracts", () => {
  it("accepts only professional, general, and normal routes", () => {
    for (const scope of ["professional", "general", "normal"] as const) {
      expect(routeActionSchema.parse({ action: "route", scope })).toEqual({ action: "route", scope });
    }
    for (const scope of ["both", "mixed", "ambiguous"]) {
      expect(() => routeActionSchema.parse({ action: "route", scope })).toThrow();
    }
  });

  it("rejects project and revision in model-visible tool inputs", () => {
    expect(() => agentActionSchema.parse({
      action: "tool",
      tool: "kb.search",
      input: { query: "Coremail AI", topK: 5, project: "coremail-professional" },
    })).toThrow();
  });
});
