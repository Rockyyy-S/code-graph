import { beforeAll, describe, expect, it } from "vitest";
import {
  checkPlanningTraceabilitySources,
  loadPlanningTraceSources,
  PLANNING_TRACE_SOURCE_SET_V1,
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

  it("检测 AD Binds 合法编号集合相对权威基线的静默收窄", () => {
    expectRule(
      mutateSource("architecture", (source) =>
        source.replace(
          "- **Binds:** FR-1 至 FR-5, FR-20 至 FR-22, NFR-9 至 NFR-11, NFR-27",
          "- **Binds:** FR-2 至 FR-5, FR-20 至 FR-22, NFR-9 至 NFR-11, NFR-27",
        ),
      ),
      "ad-binds",
    );
  });

  it("检测 Story 关联需求中的未知、越界和裸数字", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          "**关联需求：** FR-21、NFR-23、AR-1、AR-2、AR-28",
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

  it("拒绝 HTML 注释中的唯一 DAG 或追加的第二个冲突 DAG block", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          /(### StoryDependencyDagV1[\s\S]*?```yaml[\s\S]*?```)/u,
          "<!-- $1 -->",
        ),
      ),
      "dag-parse",
    );
    expectRule(
      mutateSource("epics", (source) => {
        const block = /(### StoryDependencyDagV1[^\r\n]*[\s\S]*?```yaml\s*[\s\S]*?```)/u.exec(source)?.[1];
        return block === undefined ? source : `${source}\n${block}\n`;
      }),
      "dag-parse",
    );
  });

  it("未闭合 HTML 注释中的 fence 不得恢复隐藏规划语义", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          /(### StoryDependencyDagV1[\s\S]*?```yaml[\s\S]*?```)/u,
          "<!--\n```\n```\n$1\n-->",
        ),
      ),
      "dag-parse",
    );
    expectRule(
      mutateSource("prd", (source) =>
        source.replace("#### FR-1：", "<!--\n```\n```\n#### FR-1：\n-->"),
      ),
      "definition-fr",
    );
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

  it("拒绝用 HTML 注释或 fenced code 伪造 ProductValidation 合同引用", () => {
    expectRule(
      mutateSource("prdAddendum", (source) =>
        source.replaceAll(
          "ProductValidationPlanV1",
          "<!-- ProductValidationPlanV1 -->",
        ),
      ),
      "product-validation-reference",
    );
    expectRule(
      mutateSource("prdAddendum", (source) =>
        source.replaceAll(
          "ReadinessGatePolicyV1",
          "```text\nReadinessGatePolicyV1\n```",
        ),
      ),
      "product-validation-reference",
    );
    for (const fencedReference of [
      "> ```text\n> ProductValidationPlanV1\n> ```",
      "- ```text\n  ProductValidationPlanV1\n  ```",
    ]) {
      expectRule(
        mutateSource("prdAddendum", (source) =>
          source.replaceAll("ProductValidationPlanV1", fencedReference),
        ),
        "product-validation-reference",
      );
    }
  });

  it("拒绝 inline/缩进代码或文末 glossary 伪造 ProductValidation 权威映射", () => {
    expectRule(
      mutateSource("implementationGuide", (source) =>
        source.replaceAll("ProductValidationPlanV1", "`ProductValidationPlanV1`"),
      ),
      "product-validation-reference",
    );
    expectRule(
      mutateSource("implementationGuide", (source) =>
        source
          .replaceAll("ProductValidationPlanV1", "ProductValidationPlanV2")
          .replace(
            "### 版本化产品验证与发布适用性",
            "### 版本化产品验证与发布适用性\n\n    ProductValidationPlanV1",
          ),
      ),
      "product-validation-reference",
    );
    expectRule(
      mutateSource(
        "prdAddendum",
        (source) =>
          `${source.replaceAll("ReadinessGatePolicyV1", "ReadinessGatePolicyV2")}\n` +
          "Glossary: ReadinessGatePolicyV1\n",
      ),
      "product-validation-reference",
    );
  });

  it("HTML 注释状态必须跨 fence 文本保持到显式关闭", () => {
    const sources = mutateSource("prdAddendum", (source) =>
      source.replaceAll("ProductValidationPlanV1", "ProductValidationPlanV2").replace(
        "### 5.7 产品验证与发布适用性合同",
        `### 5.7 产品验证与发布适用性合同
<!--
\`\`\`text
comment boundary
\`\`\`
ProductValidationPlanV1
-->
`,
      ),
    );

    expectRule(sources, "product-validation-reference");
  });

  it("检测关键合同与 Story 映射漂移或整段缺失", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          "| 最小真实 CI | 1.1 | AD-28、Guide §3/§13 | epics AR-28 |",
          "| 最小真实 CI | 1.1 | 任意文本 | 另一任意文本 |",
        ),
      ),
      "contract-story-map",
    );
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          "| ProductValidationPlanV1 | 5.11 |",
          "| ProductValidationPlanV1 | 1.1 |",
        ),
      ),
      "contract-story-map",
    );
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          /### 关键合同与 Story 双向映射[\s\S]*$/u,
          "",
        ),
      ),
      "contract-story-map",
    );
  });

  it("检测 Story 1.3 未完成时 Story 1.4 越权推进", () => {
    expectRule(
      mutateSource("sprintStatus", (source) => {
        // 当前真实基线已完成 Story 1.3，负向 fixture 必须显式恢复未完成前置条件。
        return source
          .replace(
            "1-3-强化-provider-阻断与规划双向追踪门禁: done",
            "1-3-强化-provider-阻断与规划双向追踪门禁: in-progress",
          )
          .replace(
            "1-4-安全初始化首次图谱与最小存储: backlog",
            "1-4-安全初始化首次图谱与最小存储: in-progress",
          );
      }),
      "story-dependency",
    );
  });

  it("拒绝未声明的 Story 状态", () => {
    expectRule(
      mutateSource("sprintStatus", (source) =>
        source.replace(
          /1-3-([^:\r\n]+): (?:backlog|ready-for-dev|in-progress|review|done)/u,
          "1-3-$1: typo-status",
        ),
      ),
      "sprint-status",
    );
  });

  it("检测所有来源协同重编号后的稳定 Story ID 漂移", () => {
    const sources = {
      ...baselineSources,
      epics: baselineSources.epics!.replaceAll("5.12", "9.9"),
      sprintStatus: baselineSources.sprintStatus!.replaceAll("5-12-", "9-9-"),
    };

    expectRule(sources, "story-coverage");
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

  it("检测人工反向追踪表整段或单行缺失", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          /### 本次调整的需求追踪[\s\S]*?### 关键合同与 Story 双向映射/u,
          "### 关键合同与 Story 双向映射",
        ),
      ),
      "reverse-trace",
    );
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(/^\| 1\.4 \| FR-1.*\r?\n/mu, ""),
      ),
      "reverse-trace",
    );
  });

  it("拒绝 fenced code 或 HTML 注释伪造两张人工追踪表", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          /(### 本次调整的需求追踪[\s\S]*?)(### 关键合同与 Story 双向映射)/u,
          "```md\n$1\n```\n$2",
        ),
      ),
      "reverse-trace",
    );
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          /(### 关键合同与 Story 双向映射[\s\S]*)$/u,
          "<!-- $1 -->",
        ),
      ),
      "contract-story-map",
    );
  });

  it("允许指向仓库内其他现有文件的相对链接", () => {
    const sources = mutateSource(
      "epics",
      (source) => `${source}\n[仓库布局](../../docs/repository-layout.md)\n`,
    );

    expect(
      checkPlanningTraceabilitySources(sources, {
        existingRelativePaths: new Set([
          ...Object.values(PLANNING_TRACE_SOURCE_SET_V1),
          "docs/repository-layout.md",
        ]),
      }),
    ).toEqual([]);
  });

  it("将非法百分号编码报告为稳定链接诊断而不是抛异常", () => {
    const sources = mutateSource("epics", (source) => `${source}\n[bad](%ZZ)\n`);

    expect(() => checkPlanningTraceabilitySources(sources)).not.toThrow();
    expectRule(sources, "relative-link");
  });

  it("拒绝分号、括号引用和重复绑定行", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace("FR-1、FR-4、FR-5、FR-22", "FR-1；FR-4、FR-5、FR-22"),
      ),
      "story-requirement",
    );
    expectRule(
      mutateSource("epics", (source) =>
        source.replace("FR-1、FR-4、FR-5、FR-22", "FR-1、FR-4、FR-5、FR-22（UJ-99）"),
      ),
      "story-requirement",
    );
    expectRule(
      mutateSource("architecture", (source) =>
        source.replace("- **Binds:** all", "- **Binds:** all\n- **Binds:** FR-999"),
      ),
      "ad-binds",
    );
  });

  it("拒绝 fenced/注释伪造定义、尾随分隔符和失效引用式链接", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          "**关联需求：** FR-7、FR-10、NFR-4、NFR-6、NFR-17、UX-DR10、UX-DR23、UX-DR25、UX-DR27、UX-DR32、UX-DR33",
          "```md\n**关联需求：** FR-7、FR-10、NFR-4、NFR-6、NFR-17、UX-DR10、UX-DR23、UX-DR25、UX-DR27、UX-DR32、UX-DR33\n```",
        ),
      ),
      "story-requirement",
    );
    expectRule(
      mutateSource("prd", (source) =>
        source.replace("#### FR-1：", "<!-- #### FR-1： -->\n#### FR-X："),
      ),
      "definition-fr",
    );
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          "**关联需求：** FR-7、FR-10、NFR-4、NFR-6、NFR-17、UX-DR10、UX-DR23、UX-DR25、UX-DR27、UX-DR32、UX-DR33",
          "**关联需求：** FR-7、FR-10、NFR-4、NFR-6、NFR-17、UX-DR10、UX-DR23、UX-DR25、UX-DR27、UX-DR32、UX-DR33、",
        ),
      ),
      "story-requirement",
    );
    expectRule(
      mutateSource("uxDesign", (source) => `${source}\n[broken-ref]: ../missing-design.md\n`),
      "relative-link",
    );
  });

  it("遮蔽波浪线 fence，并接受平衡括号、尖括号与 title 的合法 Markdown 链接", () => {
    expectRule(
      mutateSource("epics", (source) =>
        source.replace(
          "**关联需求：** FR-7、FR-10、NFR-4、NFR-6、NFR-17、UX-DR10、UX-DR23、UX-DR25、UX-DR27、UX-DR32、UX-DR33",
          "~~~md\n**关联需求：** FR-7、FR-10、NFR-4、NFR-6、NFR-17、UX-DR10、UX-DR23、UX-DR25、UX-DR27、UX-DR32、UX-DR33\n~~~",
        ),
      ),
      "story-requirement",
    );

    const sources = mutateSource(
      "epics",
      (source) =>
        `${source}\n[布局](../../docs/(arch)/../repository-layout.md "标题")\n` +
        `[尖括号](<../../docs/repository-layout.md> '标题')\n`,
    );
    expect(
      checkPlanningTraceabilitySources(sources, {
        existingRelativePaths: new Set([
          ...Object.values(PLANNING_TRACE_SOURCE_SET_V1),
          "docs/repository-layout.md",
        ]),
      }),
    ).toEqual([]);
  });

  it("忽略 inline/缩进代码中的示例链接，并接受大写或扩展 URI scheme", () => {
    const sources = mutateSource(
      "epics",
      (source) =>
        `${source}\n\`[示例](../missing-inline.md)\`\n` +
        `    [示例](../missing-indented.md)\n` +
        `[网页](HTTPS://example.invalid/path)\n` +
        `[邮件](MAILTO:owner@example.invalid)\n` +
        `[仓库](GIT+SSH://example.invalid/repository)\n`,
    );

    expect(checkPlanningTraceabilitySources(sources)).toEqual([]);
  });

  it("按 CommonMark 转义、嵌套 label 与列表容器语义识别相对链接", () => {
    expectRule(
      mutateSource(
        "epics",
        (source) => `${source}\n\\\`[真实链接](../missing-escaped-code.md)\\\`\n`,
      ),
      "relative-link",
    );
    expectRule(
      mutateSource(
        "epics",
        (source) => `${source}\n[outer [inner]](../missing-nested-label.md)\n`,
      ),
      "relative-link",
    );
    expectRule(
      mutateSource(
        "epics",
        (source) => `${source}\n- 条目\n    [列表链接](../missing-list-link.md)\n`,
      ),
      "relative-link",
    );

    const ignoredSources = mutateSource(
      "epics",
      (source) =>
        `${source}\n\\[不是链接](../missing-escaped-bracket.md)\n` +
        `    [缩进代码](../missing-indented-code.md)\n`,
    );
    expect(checkPlanningTraceabilitySources(ignoredSources)).toEqual([]);
  });

  it("只反转义 CommonMark ASCII 标点，不把普通字母前反斜杠折叠成现有路径", () => {
    const sources = mutateSource(
      "architecture",
      (source) => `${source}\n[伪路径](IMPLEMEN\\TATION-GUIDE.md)\n`,
    );

    expectRule(sources, "relative-link");
  });
});
