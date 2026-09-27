import { describe, expect, it } from "vitest";
import {
  CONTROL_CAPABILITIES,
  CONTROL_SOURCES,
  buildControlCenterStatus,
  selectControlSources,
} from "./control-center.js";

describe("Pythia control center", () => {
  it("exposes the three official upstream roles", () => {
    expect(CONTROL_SOURCES.map((source) => source.id)).toEqual([
      "lilith",
      "run2database",
      "smodels",
    ]);
    expect(CONTROL_SOURCES.find((source) => source.id === "lilith")?.runtimeIntegrated).toBe(true);
    expect(CONTROL_SOURCES.find((source) => source.id === "smodels")?.runtimeIntegrated).toBe(false);
  });

  it("selects one source or the complete catalog", () => {
    expect(selectControlSources("lilith")).toHaveLength(1);
    expect(selectControlSources("all")).toHaveLength(3);
    expect(() => selectControlSources("unknown")).toThrow("Unknown source");
  });

  it("reports degraded state when a local health check fails", () => {
    const status = buildControlCenterStatus({
      lilithDirectory: "/tmp/lilith",
      dataDirectory: "/tmp/lilith/data",
      userDataDirectory: "/tmp/lilith/data/user",
      pythonCommand: "python3",
      lilithVersion: "2.1",
      databaseVersion: "22.01-beta.1",
      datasetCount: 100,
      activeListCount: 10,
      workerCount: 2,
      workerMode: "persistent-pooled",
      checks: [{ name: "python", ok: false, detail: "not found" }],
    });
    expect(status.controlCenter.codename).toBe("Lilith Immaculate");
    expect(status.controlCenter.status).toBe("degraded");
    expect(status.capabilities).toContain("compute_likelihood");
    expect(CONTROL_CAPABILITIES.length).toBeGreaterThan(5);
  });
});
