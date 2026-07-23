import { describe, expect, it } from "vitest";
import {
  checkPlanningTraceability,
  PLANNING_TRACE_SOURCE_SET_V1,
} from "../../scripts/planning/check-planning-traceability.mjs";

const repositoryRoot = new URL("../../", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) =>
  value.slice(1),
);

describe("planning trace source contract", () => {
  it("固定且只固定 Story 声明的八个规范输入", () => {
    expect(PLANNING_TRACE_SOURCE_SET_V1).toEqual({
      architecture:
        "_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md",
      epics: "_bmad-output/planning-artifacts/epics.md",
      implementationGuide:
        "_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md",
      prd: "_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md",
      prdAddendum:
        "_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md",
      sprintStatus: "_bmad-output/implementation-artifacts/sprint-status.yaml",
      uxDesign: "_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/DESIGN.md",
      uxExperience:
        "_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md",
    });
  });

  it("当前仓库规划文档不存在追踪漂移", async () => {
    await expect(checkPlanningTraceability(repositoryRoot)).resolves.toEqual([]);
  });
});
