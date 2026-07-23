import { beforeAll, describe, expect, it } from "vitest";
import {
  checkPlanningTraceabilitySources,
  loadPlanningTraceSources,
} from "../../scripts/planning/check-planning-traceability.mjs";

const repositoryRoot = new URL("../../", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) =>
  value.slice(1),
);
let baselineSources: Record<string, string>;

beforeAll(async () => {
  baselineSources = (await loadPlanningTraceSources(repositoryRoot)) as Record<
    string,
    string
  >;
});

/** 复制基线 source set 并对指定角色应用单次漂移。 */
function mutateSource(
  role: string,
  mutate: (source: string) => string,
): Record<string, string> {
  return { ...baselineSources, [role]: mutate(baselineSources[role]!) };
}

/** 要求指定规则失败且诊断保持可移植、可执行。 */
function expectRule(
  sources: Record<string, string>,
  rule: string,
): void {
  const violations = checkPlanningTraceabilitySources(sources);
  const matches = violations.filter((violation) => violation.rule === rule);
  expect(matches.length).toBeGreaterThan(0);
  for (const violation of matches) {
    expect(violation.relativePath).not.toMatch(/^[A-Za-z]:|^\//u);
    expect(violation.suggestion.length).toBeGreaterThan(10);
  }
}

describe("planning traceability", () => {
  it("当前规范 source set 通过完整追踪检查", () => {
    expect(checkPlanningTraceabilitySources(baselineSources)).toEqual([]);
  });

  it.each([
    ["FR", "prd", "#### FR-23：", "definition-fr"],
    ["NFR", "prd", "- **NFR-27：", "definition-nfr"],
    ["SM", "prd", "- **SM-8:", "definition-sm"],
    ["UJ", "prd", "- **UJ-5.", "definition-uj"],
    ["AR", "epics", "- AR-32:", "definition-ar"],
    ["UX-DR", "epics", "UX-DR37:", "definition-ux-dr"],
  ])("检测 %s 定义缺失", (_label, role, marker, rule) => {
    expectRule(mutateSource(role, (source) => source.replace(marker, `REMOVED ${marker}`)), rule);
  });

  it("检测 AD Binds 的未知符号和非法 range grammar", () => {
    expectRule(
      mutateSource("architecture", (source) =>
        source.replace("- **Binds:** all", "- **Binds:** NFR-reliability, FR-3..FR-1"),
      ),
      "ad-binds",
    );
  });

  it("检测 Story 关联需求中的未知、越界和裸数字", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          "**关联需求：** FR-21；NFR-23；AR-1、AR-2、AR-28",
          "**关联需求：** 21；NFR-99；UNKNOWN-1",
        ),
      ),
      "story-requirement",
    );
  });

  it.each([
    [
      "missing",
      (source: string) => source.replace(/    "5\.12": \{ dependsOn: \["5\.11"\] \}\r?\n/u, ""),
      "dag-coverage",
    ],
    [
      "duplicate",
      (source: string) =>
        source.replace(
          '    "5.12": { dependsOn: ["5.11"] }',
          '    "5.12": { dependsOn: ["5.11"] }\n    "5.12": { dependsOn: ["5.11"] }',
        ),
      "dag-parse",
    ],
    [
      "cycle",
      (source: string) =>
        source.replace('    "1.1": { dependsOn: [] }', '    "1.1": { dependsOn: ["5.12"] }'),
      "dag-cycle",
    ],
  ])("检测 DAG %s", (_label, mutate, rule) => {
    expectRule(mutateSource("epics", mutate), rule);
  });

  it("检测仓库内相对 Markdown 链接失效", () => {
    expectRule(
      mutateSource("uxDesign", (source) => `${source}\n[broken](../missing-design.md)\n`),
      "relative-link",
    );
  });

  it("检测 ProductValidation 合同引用漂移", () => {
    expectRule(
      mutateSource("prdAddendum", (source) =>
        source.replaceAll("ProductValidationPlanV1", "ProductValidationPlanV2"),
      ),
      "product-validation-reference",
    );
  });

  it("检测 Story 1.3 未完成时 Story 1.4 越权推进", () => {
    expectRule(
      mutateSource("sprintStatus", (source) =>
        source.replace(
          "1-4-安全初始化首次图谱与最小存储: backlog",
          "1-4-安全初始化首次图谱与最小存储: in-progress",
        ),
      ),
      "story-dependency",
    );
  });

  it("检测人工反向追踪表与 Story 关联需求不一致", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          "| 1.4 | FR-1、FR-4、FR-5、FR-22 |",
          "| 1.4 | FR-1、FR-4 |",
        ),
      ),
      "reverse-trace",
    );
  });
});
