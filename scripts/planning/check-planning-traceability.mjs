import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";

/** 当前规划追踪唯一允许读取的规范输入集合。 */
export const PLANNING_TRACE_SOURCE_SET_V1 = Object.freeze({
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

const definitionProfiles = Object.freeze({
  AD: { maximum: 30, role: "architecture", rule: "definition-ad" },
  AR: { maximum: 32, role: "epics", rule: "definition-ar" },
  FR: { maximum: 23, role: "prd", rule: "definition-fr" },
  NFR: { maximum: 27, role: "prd", rule: "definition-nfr" },
  SM: { maximum: 8, role: "prd", rule: "definition-sm" },
  UJ: { maximum: 5, role: "prd", rule: "definition-uj" },
  "UX-DR": { maximum: 37, role: "epics", rule: "definition-ux-dr" },
});
const symbolicAdBinds = new Set(["all", "deployment", "traceability"]);
const authoritativeAdBindsV1 = new Map([
  ["AD-1", "all"],
  ["AD-2", "FR-1 至 FR-5, FR-20 至 FR-22, NFR-9 至 NFR-11, NFR-27"],
  ["AD-3", "FR-2, FR-3, FR-5, FR-11 至 FR-15, SM-2, SM-3"],
  ["AD-4", "FR-2, FR-5, FR-14, FR-17, FR-23"],
  ["AD-5", "FR-1 至 FR-3, FR-11, SM-3, SM-4"],
  ["AD-6", "FR-4, FR-5, FR-12, FR-19, FR-22, NFR-12 至 NFR-16"],
  ["AD-7", "FR-6 至 FR-10, FR-17, FR-21, FR-23, SM-1, SM-2"],
  ["AD-8", "FR-1, FR-3, FR-15 至 FR-18, FR-20 至 FR-22, NFR-9 至 NFR-11, NFR-27"],
  ["AD-9", "FR-12 至 FR-15, FR-18"],
  ["AD-10", "FR-6 至 FR-10, FR-13, FR-22, UJ-1 至 UJ-4"],
  ["AD-11", "all, NFR-12 至 NFR-16"],
  ["AD-12", "FR-20 至 FR-22, NFR-9 至 NFR-11, NFR-24 至 NFR-27, deployment"],
  ["AD-13", "FR-15 至 FR-18, FR-20, FR-23, UJ-4, UJ-5"],
  ["AD-14", "FR-4, FR-12, FR-20 至 FR-23"],
  ["AD-15", "FR-10, NFR-17 至 NFR-20, UX-DR1 至 UX-DR37"],
  ["AD-16", "FR-19, FR-22, SM-1 至 SM-6, NFR-12 至 NFR-16"],
  ["AD-17", "FR-11 至 FR-18, UJ-3, UJ-4"],
  ["AD-18", "FR-17 至 FR-19, FR-23, UJ-4, UJ-5, SM-7, SM-8"],
  ["AD-19", "SM-1 至 SM-8, NFR-1 至 NFR-11, NFR-26, NFR-27"],
  ["AD-20", "FR-5, FR-12, FR-20 至 FR-23, deployment"],
  ["AD-21", "FR-2, FR-5, FR-14, SM-4"],
  ["AD-22", "FR-3, FR-7, FR-19 至 FR-22, NFR-13, NFR-27"],
  ["AD-23", "FR-1, FR-20 至 FR-22, deployment, NFR-9 至 NFR-11, NFR-27"],
  ["AD-24", "FR-2, FR-5, FR-11 至 FR-14, SM-4"],
  ["AD-25", "FR-6, FR-7, FR-11, FR-14, FR-21, SM-1, SM-2, SM-6"],
  ["AD-26", "FR-16 至 FR-18, FR-20, UJ-4, SM-8"],
  ["AD-27", "FR-2, FR-9, FR-23, NFR-21 至 NFR-23"],
  ["AD-28", "all, deployment, traceability"],
  ["AD-29", "deployment, NFR-9 至 NFR-16, NFR-27"],
  ["AD-30", "SM-1, SM-6, SM-7, SM-8, UJ-5, FR-6, FR-7, FR-11, FR-12, FR-17, FR-18, FR-23, deployment, traceability"],
]);
const storyStatuses = new Set(["backlog", "done", "in-progress", "ready-for-dev", "review"]);
const stableStoryIdsV1 = new Set([
  "1.1", "1.2", "1.3", "1.4", "1.19", "1.5", "1.6", "1.7", "1.8", "1.9",
  "1.10", "1.11", "1.12", "1.13", "1.14", "1.15", "1.16", "1.17", "1.18",
  "2.1", "2.10", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.11",
  "2.9", "3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9",
  "3.10", "4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "4.8", "4.9",
  "5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.9", "5.10",
  "5.11", "5.12",
]);
const reverseTraceStoryIdsV1 = new Set([
  "1.4", "1.19", "2.1", "2.10", "2.8", "2.11", "4.8", "4.9", "5.11", "5.12",
]);
const keyContractStoryMapV1 = new Map([
  ["最小真实 CI", ["1.1", "AD-28、Guide §3/§13", "epics AR-28"]],
  ["provider + 规划追踪", ["1.3", "AD-28、Guide §13", "epics AR-28"]],
  ["BuiltinIgnoreV1 / generation 0", ["1.4", "AD-14、AD-23、Guide §3/§4/§7", "FR-4、Addendum §4"]],
  ["确定性 rebuild / CAS", ["1.19", "AD-3、AD-8、Guide §6/§7", "FR-1、FR-5"]],
  ["BasicSymbolV1", ["1.6", "AD-27、Guide §8", "FR-2、Addendum §5.4"]],
  ["BaseCycleProjectionV1", ["1.14", "AD-25、Guide §9", "FR-11"]],
  ["Getting Started / Index Status", ["2.10", "AD-10、AD-15", "UX-DR15/16/19/21/22/24"]],
  ["增量 mutation", ["2.8", "AD-3、AD-8、AD-23", "FR-3、NFR-5/9/10"]],
  ["原子视图 patch", ["2.11", "AD-7、AD-22", "UX-DR6/23/27/30/32"]],
  ["ImpactVerdictV1 / ImpactRankV1", ["4.4", "AD-26、Guide §12", "FR-17、UX-DR17"]],
  ["CLI impact", ["4.8", "AD-13、AD-26", "FR-16/17/20"]],
  ["CLI export", ["4.9", "AD-13、AD-18", "FR-20/23、UX-DR18"]],
  ["ProductValidationPlanV1", ["5.11", "AD-30、Guide §13", "SM-1/6/7/8、UJ-5"]],
  ["Beta+ Go/No-Go", ["5.12", "AD-29、AD-30", "PRD §8/§9、ReadinessGateManifestV1"]],
]);

/** 从固定 source set 读取完整规范文本，不递归扫描其他 planning Markdown。 */
export async function loadPlanningTraceSources(repositoryRoot) {
  const sources = {};
  for (const [role, relativePath] of Object.entries(PLANNING_TRACE_SOURCE_SET_V1)) {
    sources[role] = await readFile(resolveRelative(repositoryRoot, relativePath), "utf8");
  }
  return sources;
}

/** 从仓库加载并执行完整规划双向追踪检查。 */
export async function checkPlanningTraceability(repositoryRoot) {
  try {
    const sources = await loadPlanningTraceSources(repositoryRoot);
    return checkPlanningTraceabilitySources(sources, {
      existingRelativePaths: await collectExistingRelativeLinkPaths(repositoryRoot, sources),
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [
        violation(
          "_bmad-output/planning-artifacts",
          "source-set",
          "Planning Trace Source Set 中的规范输入缺失。",
          "恢复缺失文件，或在同一 PR 更新 PLANNING_TRACE_SOURCE_SET_V1 和合同测试",
        ),
      ];
    }
    throw error;
  }
}

/** 对已加载的八个规范输入执行确定性、无文件系统副作用的语义检查。 */
export function checkPlanningTraceabilitySources(sources, options = {}) {
  const violations = [];
  const definitions = collectDefinitions(sources, violations);
  const stories = collectStories(sources.epics ?? "", definitions, violations);
  const dag = validateStoryDag(sources.epics ?? "", stories, violations);
  validateAdBinds(sources.architecture ?? "", definitions, violations);
  validateReverseTraceTable(sources.epics ?? "", stories, violations);
  validateKeyContractStoryMap(sources.epics ?? "", stories, violations);
  validateRelativeLinks(sources, violations, options.existingRelativePaths);
  validateProductValidationReferences(sources, violations);
  validateSprintDependencies(sources.sprintStatus ?? "", dag, stories, violations);
  return violations.sort((left, right) =>
    `${left.relativePath}:${left.line ?? 0}:${left.rule}:${left.message}`.localeCompare(
      `${right.relativePath}:${right.line ?? 0}:${right.rule}:${right.message}`,
    ),
  );
}

/** 提取并验证 FR/NFR/SM/UJ/AR/UX-DR/AD 连续、唯一的定义集合。 */
function collectDefinitions(sources, violations) {
  const patterns = {
    AD: /^### AD-(\d+)\s/mgu,
    AR: /^- AR-(\d+):/mgu,
    FR: /^#### FR-(\d+)：/mgu,
    NFR: /^- \*\*NFR-(\d+)：/mgu,
    SM: /^- \*\*SM-(\d+):/mgu,
    UJ: /^- \*\*UJ-(\d+)\./mgu,
    "UX-DR": /^UX-DR(\d+):/mgu,
  };
  const definitions = new Map();
  for (const [prefix, profile] of Object.entries(definitionProfiles)) {
    const source = sources[profile.role] ?? "";
    const matches = [...maskNonSemanticMarkdown(source).matchAll(patterns[prefix])];
    const ids = matches.map((match) => Number(match[1]));
    const expected = Array.from({ length: profile.maximum }, (_value, index) => index + 1);
    if (
      ids.length !== expected.length ||
      ids.some((identifier, index) => identifier !== expected[index])
    ) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1[profile.role],
          profile.rule,
          `${prefix}-1..${prefix}-${profile.maximum} 定义缺失、重复或乱序。`,
          `恢复连续且唯一的 ${prefix}-1..${prefix}-${profile.maximum} 定义`,
        ),
      );
    }
    definitions.set(
      prefix,
      new Set(ids.map((identifier) => formatReference(prefix, identifier))),
    );
  }
  return definitions;
}

/** 提取 61 个 Story 及其关联需求，严格执行 Planning Reference Grammar。 */
function collectStories(epicsSource, definitions, violations) {
  const headingPattern = /^### Story (\d+\.\d+)：[^\r\n]+/mgu;
  const semanticSource = maskNonSemanticMarkdown(epicsSource);
  const headings = [...semanticSource.matchAll(headingPattern)];
  const stories = new Map();
  for (const [index, heading] of headings.entries()) {
    const storyId = heading[1];
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? epicsSource.length;
    const section = semanticSource.slice(start, end);
    const associations = [...section.matchAll(/^\*\*关联需求：\*\*\s*(.+)$/mgu)];
    const association = associations[0];
    if (associations.length !== 1) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "story-requirement",
          `Story ${storyId} 必须且只能包含一条关联需求，实际为 ${associations.length} 条。`,
          `在 Story ${storyId} 中保留唯一一条使用完整前缀的 **关联需求：** 行`,
          lineForIndex(epicsSource, start),
        ),
      );
    }
    if (association === undefined) {
      continue;
    }
    const parsed = parseReferenceList(association[1], {
      allowedPrefixes: new Set(["AR", "FR", "NFR", "SM", "UJ", "UX-DR"]),
      definitions,
    });
    for (const issue of parsed.issues) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "story-requirement",
          `Story ${storyId} 关联需求无效：${issue}`,
          "使用已定义、带完整前缀、无前导零且范围升序的规范 ID",
          lineForIndex(epicsSource, start + (association.index ?? 0)),
        ),
      );
    }
    if (stories.has(storyId)) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "story-coverage",
          `Story ${storyId} 重复定义。`,
          `保留唯一的 Story ${storyId} 标题和关联需求`,
          lineForIndex(epicsSource, start),
        ),
      );
    }
    stories.set(storyId, {
      references: parsed.references,
      section,
    });
  }
  if (!sameStringSet(new Set(stories.keys()), stableStoryIdsV1)) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "story-coverage",
        `Story 定义必须与稳定 Story ID 集合完全一致，当前识别 ${stories.size} 个。`,
        "恢复版本化的 61 个稳定 Story ID；新增、删除或重编号必须显式升级追踪合同",
      ),
    );
  }
  return stories;
}

/** 只使用各 AD 的 Binds 解析直接需求边，忽略 Capability Map 导航。 */
function validateAdBinds(architectureSource, definitions, violations) {
  const semanticSource = maskNonSemanticMarkdown(architectureSource);
  const headings = [...semanticSource.matchAll(/^### AD-(\d+)\s/mgu)];
  for (const [index, heading] of headings.entries()) {
    const adId = `AD-${heading[1]}`;
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? architectureSource.length;
    const section = semanticSource.slice(start, end);
    const bindLines = [...section.matchAll(/^- \*\*Binds:\*\*\s*(.+)$/mgu)];
    const binds = bindLines[0];
    if (bindLines.length !== 1) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.architecture,
          "ad-binds",
          `${adId} 必须且只能包含一条 Binds，实际为 ${bindLines.length} 条。`,
          `为 ${adId} 保留唯一一条只含规范 ID 或 all|deployment|traceability 的 Binds`,
          lineForIndex(architectureSource, start),
        ),
      );
    }
    if (binds === undefined) {
      continue;
    }
    const actualBindings = new Set();
    let hasInvalidToken = false;
    const tokens = splitReferenceTokens(binds[1]);
    for (const token of tokens) {
      if (symbolicAdBinds.has(token)) {
        actualBindings.add(`symbolic:${token}`);
        continue;
      }
      const parsed = parseReferenceList(token, {
        allowedPrefixes: new Set(["FR", "NFR", "SM", "UJ", "UX-DR"]),
        definitions,
      });
      if (parsed.issues.length > 0 || parsed.references.size === 0) {
        hasInvalidToken = true;
        violations.push(
          violation(
            PLANNING_TRACE_SOURCE_SET_V1.architecture,
            "ad-binds",
            `${adId} Binds token '${token}' 未遵循 Planning Reference Grammar。`,
            "展开未声明缩写，并使用 PREFIX-a 至 PREFIX-b、PREFIX-a–PREFIX-b 或 PREFIX-a–b",
            lineForIndex(architectureSource, start + (binds.index ?? 0)),
          ),
        );
      } else {
        for (const reference of parsed.references) {
          actualBindings.add(reference);
        }
      }
    }
    const expectedSource = authoritativeAdBindsV1.get(adId);
    const expectedBindings = expectedSource === undefined
      ? null
      : parseAdBindSet(expectedSource, definitions);
    if (
      !hasInvalidToken &&
      (expectedBindings === null || !sameStringSet(actualBindings, expectedBindings))
    ) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.architecture,
          "ad-binds",
          `${adId} Binds 与版本化双向追踪权威集合不一致。`,
          `恢复 ${adId} 的完整直接绑定；合法编号的静默删除或新增必须升级追踪合同`,
          lineForIndex(architectureSource, start + (binds.index ?? 0)),
        ),
      );
    }
  }
}

/** 把版本化 AD Binds 文本展开为规范引用与 symbolic token 集合。 */
function parseAdBindSet(source, definitions) {
  const references = new Set();
  for (const token of splitReferenceTokens(source)) {
    if (symbolicAdBinds.has(token)) {
      references.add(`symbolic:${token}`);
      continue;
    }
    const parsed = parseReferenceList(token, {
      allowedPrefixes: new Set(["FR", "NFR", "SM", "UJ", "UX-DR"]),
      definitions,
    });
    if (parsed.issues.length > 0 || parsed.references.size === 0) {
      return null;
    }
    for (const reference of parsed.references) {
      references.add(reference);
    }
  }
  return references;
}

/** 解析并验证覆盖全部 Story 的 StoryDependencyDagV1。 */
function validateStoryDag(epicsSource, stories, violations) {
  const blocks = collectStoryDagBlocks(epicsSource);
  if (blocks.length !== 1) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "dag-parse",
        blocks.length === 0
          ? "缺少可见的 StoryDependencyDagV1 YAML block。"
          : `StoryDependencyDagV1 必须且只能包含一个可见 YAML block，实际为 ${blocks.length} 个。`,
        "恢复覆盖全部 61 个 Story 的唯一、非注释 StoryDependencyDagV1 block",
      ),
    );
    return new Map();
  }
  const block = blocks[0];
  let document;
  try {
    document = parse(block.source, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "dag-parse",
        "StoryDependencyDagV1 YAML 无法解析或包含重复 key。",
        "修复 YAML，并确保每个 Story 只出现一次",
        lineForIndex(epicsSource, block.index),
      ),
    );
    return new Map();
  }
  const dag = document?.storyDependencyDagV1;
  if (
    !isClosedObject(dag, ["dependencyKind", "documentOrder", "nodes", "version"]) ||
    dag.version !== 1 ||
    dag.dependencyKind !== "direct-completion-prerequisite" ||
    dag.documentOrder !== "display-only" ||
    typeof dag.nodes !== "object" ||
    dag.nodes === null ||
    Array.isArray(dag.nodes)
  ) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "dag-parse",
        "StoryDependencyDagV1 根合同无效。",
        "恢复 version=1、direct-completion-prerequisite、display-only 和封闭 nodes",
      ),
    );
    return new Map();
  }
  const nodes = new Map();
  for (const [storyId, node] of Object.entries(dag.nodes)) {
    if (
      !isClosedObject(node, ["dependsOn"]) ||
      !Array.isArray(node.dependsOn) ||
      node.dependsOn.some((dependency) => typeof dependency !== "string") ||
      new Set(node.dependsOn).size !== node.dependsOn.length
    ) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "dag-parse",
          `Story ${storyId} 的 dependsOn 不是唯一字符串数组。`,
          `将 Story ${storyId}.dependsOn 恢复为唯一直接前置 Story ID 数组`,
        ),
      );
      continue;
    }
    nodes.set(storyId, [...node.dependsOn]);
  }
  const storyIds = [...stories.keys()].sort();
  const nodeIds = [...nodes.keys()].sort();
  if (
    storyIds.length !== nodeIds.length ||
    storyIds.some((storyId, index) => storyId !== nodeIds[index])
  ) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "dag-coverage",
        "StoryDependencyDagV1 未恰好覆盖全部 61 个 Story。",
        "为每个已定义 Story 添加且只添加一个 DAG node，并删除未知 node",
      ),
    );
  }
  for (const [storyId, dependencies] of nodes) {
    for (const dependency of dependencies) {
      if (!nodes.has(dependency) || dependency === storyId) {
        violations.push(
          violation(
            PLANNING_TRACE_SOURCE_SET_V1.epics,
            "dag-reference",
            `Story ${storyId} 引用不存在或自引用的前置 ${dependency}。`,
            `将 ${storyId}.dependsOn 改为现有的其他 Story 直接前置`,
          ),
        );
      }
    }
  }
  const roots = [...nodes].filter(([, dependencies]) => dependencies.length === 0);
  if (roots.length !== 1) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "dag-root",
        `StoryDependencyDagV1 必须有唯一根，实际为 ${roots.length} 个。`,
        "保留一个且仅一个 dependsOn: [] 的 Story 根节点",
      ),
    );
  }
  if (hasDirectedCycle(nodes)) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "dag-cycle",
        "StoryDependencyDagV1 包含依赖环。",
        "删除或改写直接前置边，使所有 Story 可从唯一根拓扑到达",
      ),
    );
  }
  return nodes;
}

/** 单遍提取可见 StoryDependencyDagV1 section 内的 YAML fence，并保留原始行偏移。 */
function collectStoryDagBlocks(source) {
  const blocks = [];
  const lines = source.match(/.*(?:\r\n|\n|\r|$)/gu) ?? [];
  let offset = 0;
  let fence = null;
  let inComment = false;
  let inDagSection = false;
  let capturedLines = null;
  let capturedIndex = 0;
  for (const line of lines) {
    const content = line.replace(/[\r\n]+$/u, "");
    const lineEnding = line.slice(content.length);
    if (fence !== null) {
      const semanticContent = stripMarkdownContainerPrefix(content);
      const closing = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/u.exec(semanticContent);
      if (
        closing !== null &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      ) {
        if (capturedLines !== null) {
          blocks.push({ index: capturedIndex, source: capturedLines.join("") });
        }
        fence = null;
        capturedLines = null;
      } else if (capturedLines !== null) {
        capturedLines.push(`${stripMarkdownContainerPrefix(content)}${lineEnding}`);
      }
      offset += line.length;
      continue;
    }
    const masked = maskHtmlCommentsInLine(line, inComment);
    inComment = masked.inComment;
    const semanticContent = stripMarkdownContainerPrefix(
      masked.line.replace(/[\r\n]+$/u, ""),
    );
    const heading = /^(#{1,3})\s+([^\r\n]+)$/u.exec(semanticContent);
    if (heading !== null) {
      inDagSection =
        heading[1].length === 3 && /^StoryDependencyDagV1(?![A-Za-z0-9_])/u.test(heading[2]);
    }
    const opening = /^(?: {0,3})(`{3,}|~{3,})[ \t]*([^\s]*)[^\r\n]*$/u.exec(
      semanticContent,
    );
    if (opening !== null && !inComment) {
      fence = { character: opening[1][0], length: opening[1].length };
      capturedLines = inDagSection && opening[2].toLowerCase() === "yaml" ? [] : null;
      capturedIndex = offset;
    }
    offset += line.length;
  }
  return blocks;
}

/** 对“本次调整的需求追踪”人工反向表与 Story 关联需求逐列比较。 */
function validateReverseTraceTable(epicsSource, stories, violations) {
  const semanticSource = maskNonSemanticMarkdown(epicsSource);
  const section = /### 本次调整的需求追踪\s*([\s\S]*?)### 关键合同与 Story 双向映射/u.exec(
    semanticSource,
  );
  if (section === null) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "reverse-trace",
        "缺少本次调整的需求追踪表或关键合同映射边界。",
        "恢复覆盖版本化 Story 集合的五列表格，并保留关键合同映射标题",
      ),
    );
    return;
  }
  const rows = section[1]
    .split(/\r?\n/u)
    .filter((line) => /^\|\s*\d+\.\d+\s*\|/u.test(line));
  const seenStoryIds = new Set();
  for (const row of rows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 5) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "reverse-trace",
          `反向追踪行列数必须为 5，当前行为 '${row.trim()}'。`,
          "恢复 Story、FR/SM/UJ、NFR、AR、UX-DR 五列",
        ),
      );
      continue;
    }
    if (seenStoryIds.has(cells[0])) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "reverse-trace",
          `反向追踪表重复包含 Story ${cells[0]}。`,
          `只保留一行 Story ${cells[0]} 的反向追踪记录`,
        ),
      );
      continue;
    }
    seenStoryIds.add(cells[0]);
    const story = stories.get(cells[0]);
    if (story === undefined) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "reverse-trace",
          `反向追踪表引用未知 Story ${cells[0]}。`,
          "删除未知 Story 行，或恢复对应 Story 定义",
        ),
      );
      continue;
    }
    const groups = [
      new Set(["FR", "SM", "UJ"]),
      new Set(["NFR"]),
      new Set(["AR"]),
      new Set(["UX-DR"]),
    ];
    for (let index = 0; index < groups.length; index += 1) {
      const parsed = parseReferenceList(cells[index + 1], {
        allowedPrefixes: groups[index],
        allowNotApplicable: true,
        definitions: null,
      });
      const expected = [...story.references].filter((reference) =>
        groups[index].has(prefixOf(reference)),
      );
      if (
        parsed.issues.length > 0 ||
        !sameStringSet(parsed.references, new Set(expected))
      ) {
        violations.push(
          violation(
            PLANNING_TRACE_SOURCE_SET_V1.epics,
            "reverse-trace",
            `Story ${cells[0]} 的人工反向追踪表与关联需求不一致。`,
            `按 Story ${cells[0]} 的关联需求逐项回填完整前缀，空集合使用 N/A`,
          ),
        );
      }
    }
  }
  if (!sameStringSet(seenStoryIds, reverseTraceStoryIdsV1)) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "reverse-trace",
        "本次调整的需求追踪表未完整覆盖版本化 Story 集合。",
        "恢复 1.4、1.19、2.1、2.10、2.8、2.11、4.8、4.9、5.11、5.12 的唯一行",
      ),
    );
  }
}

/** 验证关键合同表的完整覆盖、唯一性和稳定最终 Story。 */
function validateKeyContractStoryMap(epicsSource, stories, violations) {
  const semanticSource = maskNonSemanticMarkdown(epicsSource);
  const section = /### 关键合同与 Story 双向映射\s*([\s\S]*?)$/u.exec(semanticSource);
  if (section === null) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "contract-story-map",
        "缺少关键合同与 Story 双向映射表。",
        "恢复版本化关键合同、最终 Story、Architecture/Guide 与 PRD/UX 四列表格",
      ),
    );
    return;
  }
  const rows = section[1]
    .split(/\r?\n/u)
    .filter((line) => /^\|\s*[^|-][^|]*\|/u.test(line));
  const seenContracts = new Set();
  for (const row of rows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells[0] === "合同" || cells[0] === "---") {
      continue;
    }
    if (cells.length !== 4) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "contract-story-map",
          `关键合同映射行列数必须为 4，当前行为 '${row.trim()}'。`,
          "恢复合同、最终 Story、Architecture/Guide、PRD/UX 四列",
        ),
      );
      continue;
    }
    const [contractName, storyId, architectureGuide, prdUx] = cells;
    const expectedMapping = keyContractStoryMapV1.get(contractName);
    if (
      expectedMapping === undefined ||
      seenContracts.has(contractName) ||
      storyId !== expectedMapping[0] ||
      architectureGuide !== expectedMapping[1] ||
      prdUx !== expectedMapping[2] ||
      !stories.has(storyId)
    ) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "contract-story-map",
          `关键合同 '${contractName}' 的最终 Story 或规范文档映射缺失、重复或漂移。`,
          "按版本化四列合同映射恢复合同名、最终 Story、Architecture/Guide 与 PRD/UX",
        ),
      );
      continue;
    }
    seenContracts.add(contractName);
  }
  if (!sameStringSet(seenContracts, new Set(keyContractStoryMapV1.keys()))) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "contract-story-map",
        "关键合同映射表未完整覆盖版本化合同集合。",
        "恢复全部 14 个关键合同映射行，禁止删除或添加未声明合同",
      ),
    );
  }
}

/** 验证相对 Markdown 链接解析到仓库内实际存在的路径。 */
function validateRelativeLinks(sources, violations, existingRelativePaths) {
  const availablePaths =
    existingRelativePaths ?? new Set(Object.values(PLANNING_TRACE_SOURCE_SET_V1));
  for (const [role, source] of Object.entries(sources)) {
    const sourcePath = PLANNING_TRACE_SOURCE_SET_V1[role];
    if (sourcePath === undefined || role === "sprintStatus") {
      continue;
    }
    const semanticSource = maskMarkdownLinkCode(source);
    for (const match of collectMarkdownLinkTargets(semanticSource)) {
      const rawTarget = match.target.trim();
      if (isExternalMarkdownTarget(rawTarget)) {
        continue;
      }
      const resolved = resolveRelativeLinkPath(sourcePath, rawTarget);
      if (resolved === null || !availablePaths.has(resolved)) {
        violations.push(relativeLinkViolation(sourcePath, source, match, rawTarget));
      }
    }
  }
}

/** 只探测文档实际引用的仓库路径，不把其他文件内容纳入规划语义。 */
async function collectExistingRelativeLinkPaths(repositoryRoot, sources) {
  const existingPaths = new Set(Object.values(PLANNING_TRACE_SOURCE_SET_V1));
  for (const [role, source] of Object.entries(sources)) {
    const sourcePath = PLANNING_TRACE_SOURCE_SET_V1[role];
    if (sourcePath === undefined || role === "sprintStatus") {
      continue;
    }
    const semanticSource = maskMarkdownLinkCode(source);
    for (const match of collectMarkdownLinkTargets(semanticSource)) {
      const rawTarget = match.target.trim();
      if (isExternalMarkdownTarget(rawTarget)) {
        continue;
      }
      const resolved = resolveRelativeLinkPath(sourcePath, rawTarget);
      if (resolved === null) {
        continue;
      }
      try {
        await access(resolveRelative(repositoryRoot, resolved));
        existingPaths.add(resolved);
      } catch {
        // 缺失路径由同步语义检查生成稳定、可移植的诊断。
      }
    }
  }
  return existingPaths;
}

/** 解码并规范化仓库内相对 Markdown 链接；非法编码直接返回 null。 */
function resolveRelativeLinkPath(sourcePath, rawTarget) {
  let targetPath;
  try {
    targetPath = decodeURIComponent(rawTarget.split("#")[0]);
  } catch {
    return null;
  }
  if (
    targetPath.length === 0 ||
    targetPath.includes("\\") ||
    path.posix.isAbsolute(targetPath)
  ) {
    return null;
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePath), targetPath),
  );
  return resolved === ".." || resolved.startsWith("../") ? null : resolved;
}

/** 创建相对链接失败诊断。 */
function relativeLinkViolation(sourcePath, source, match, rawTarget) {
  return violation(
    sourcePath,
    "relative-link",
    `相对 Markdown 链接 '${rawTarget}' 未解析到仓库内现有路径。`,
    "修复百分号编码或改为仓库内存在的相对路径，并保留可选 #anchor",
    lineForIndex(source, match.index ?? 0),
  );
}

/** 验证 ProductValidation/Readiness 合同在声明责任文档中名称一致。 */
function validateProductValidationReferences(sources, violations) {
  const requiredRoles = {
    ProductValidationPlanV1: ["architecture", "epics", "implementationGuide", "prd", "prdAddendum"],
    ReadinessGateManifestV1: ["architecture", "epics", "implementationGuide", "prd", "prdAddendum"],
    ReadinessGatePolicyV1: ["architecture", "implementationGuide", "prdAddendum"],
  };
  for (const [contractName, roles] of Object.entries(requiredRoles)) {
    const contractPattern = new RegExp(
      `(?<![A-Za-z0-9_])${contractName}(?![A-Za-z0-9_])`,
      "u",
    );
    for (const role of roles) {
      const semanticSource = authoritativeProductValidationSource(
        role,
        maskMarkdownLinkCode(sources[role] ?? ""),
      );
      if (!contractPattern.test(semanticSource)) {
        violations.push(
          violation(
            PLANNING_TRACE_SOURCE_SET_V1[role],
            "product-validation-reference",
            `${contractName} 在责任文档中缺失或名称漂移。`,
            `恢复 ${contractName} 的精确合同名及 Story/Architecture/PRD 映射`,
          ),
        );
      }
    }
  }
}

/**
 * 只返回各责任文档中声明产品验证合同的权威段落，避免文末术语表补位。
 * @param {string} role Planning Trace Source Set 中的文档角色。
 * @param {string} source 已遮蔽非语义 Markdown 的文档文本。
 * @returns {string} 允许承载版本化产品验证合同名的权威文本。
 */
function authoritativeProductValidationSource(role, source) {
  if (role === "architecture") {
    return extractMarkdownSection(source, /^### AD-30(?![A-Za-z0-9_])/mu, 3);
  }
  if (role === "implementationGuide") {
    return extractMarkdownSection(source, /^### 版本化产品验证与发布适用性\s*$/mu, 3);
  }
  if (role === "epics") {
    const ar32 = /^- AR-32:[^\r\n]*(?:\r\n|\n|\r|$)/mu.exec(source)?.[0] ?? "";
    const contractMap = extractMarkdownSection(
      source,
      /^### 关键合同与 Story 双向映射\s*$/mu,
      3,
    );
    return `${ar32}\n${contractMap}`;
  }
  if (role === "prd") {
    return extractMarkdownSection(source, /^## 8\. 成功指标\s*$/mu, 2);
  }
  if (role === "prdAddendum") {
    return extractMarkdownSection(source, /^### 5\.7 产品验证与发布适用性合同\s*$/mu, 3);
  }
  return "";
}

/**
 * 从指定可见标题开始提取到下一个同级或更高标题，并保持原始文本内容。
 * @param {string} source 已遮蔽非语义 Markdown 的文档文本。
 * @param {RegExp} headingPattern 权威段落起始标题。
 * @param {number} headingLevel 起始标题层级。
 * @returns {string} 段落文本；标题缺失时返回空字符串。
 */
function extractMarkdownSection(source, headingPattern, headingLevel) {
  const heading = headingPattern.exec(source);
  if (heading === null || heading.index === undefined) {
    return "";
  }
  const contentStart = heading.index + heading[0].length;
  const following = source.slice(contentStart);
  const nextHeading = new RegExp(`^#{1,${headingLevel}}\\s+`, "mu").exec(following);
  return source.slice(
    heading.index,
    nextHeading === null || nextHeading.index === undefined
      ? source.length
      : contentStart + nextHeading.index,
  );
}

/** 使用权威 DAG 验证任何离开 backlog 的 Story 都已满足直接前置。 */
function validateSprintDependencies(sprintSource, dag, stories, violations) {
  let sprint;
  try {
    sprint = parse(sprintSource, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.sprintStatus,
        "sprint-status",
        "sprint-status.yaml 无法解析或包含重复 key。",
        "修复 YAML 并保留唯一 development_status",
      ),
    );
    return;
  }
  const developmentStatus = sprint?.development_status;
  if (
    typeof developmentStatus !== "object" ||
    developmentStatus === null ||
    Array.isArray(developmentStatus)
  ) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.sprintStatus,
        "sprint-status",
        "development_status 缺失或不是映射。",
        "恢复覆盖全部 Story 的 development_status 映射",
      ),
    );
    return;
  }
  const statusByStory = new Map();
  for (const storyId of stories.keys()) {
    const prefix = storyId.replace(".", "-");
    const matchingKeys = Object.keys(developmentStatus).filter((key) =>
      key.startsWith(`${prefix}-`),
    );
    if (matchingKeys.length !== 1) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.sprintStatus,
          "sprint-status",
          `Story ${storyId} 在 development_status 中缺失或重复。`,
          `保留一个且仅一个以 ${prefix}- 开头的 Story 状态 key`,
        ),
      );
      continue;
    }
    const status = developmentStatus[matchingKeys[0]];
    if (!storyStatuses.has(status)) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.sprintStatus,
          "sprint-status",
          `Story ${storyId} 使用未声明状态 '${String(status)}'。`,
          "改为 backlog、ready-for-dev、in-progress、review 或 done",
        ),
      );
      continue;
    }
    statusByStory.set(storyId, status);
  }
  for (const key of Object.keys(developmentStatus)) {
    const match = /^(\d+)-(\d+)-/u.exec(key);
    if (match !== null && !stableStoryIdsV1.has(`${match[1]}.${match[2]}`)) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.sprintStatus,
          "sprint-status",
          `development_status 包含未知 Story key '${key}'。`,
          "删除未知 Story key，或先显式升级稳定 Story ID 合同",
        ),
      );
    }
  }
  for (const [storyId, dependencies] of dag) {
    const status = statusByStory.get(storyId);
    if (status === undefined || status === "backlog") {
      continue;
    }
    for (const dependency of dependencies) {
      if (statusByStory.get(dependency) !== "done") {
        violations.push(
          violation(
            PLANNING_TRACE_SOURCE_SET_V1.sprintStatus,
            "story-dependency",
            `Story ${storyId}=${status}，但直接前置 Story ${dependency} 尚未 done。`,
            `将 Story ${storyId} 恢复为 backlog，或先完成 Story ${dependency}`,
          ),
        );
      }
    }
  }
}

/** 解析单个列表或范围，并返回展开后的规范引用。 */
function parseReferenceList(source, options) {
  const references = new Set();
  const issues = [];
  const normalized = source.trim();
  if (options.allowNotApplicable && normalized === "N/A") {
    return { issues, references };
  }
  if (/[；;]/u.test(normalized)) {
    issues.push("列表分隔符只允许顿号、中文逗号或英文逗号");
  }
  if (/[（）()]/u.test(normalized)) {
    issues.push("引用列表不得使用括号隐藏说明或引用");
  }
  for (const token of splitReferenceTokens(normalized)) {
    const rangeSeparator = token.includes("至") ? "至" : token.includes("–") ? "–" : null;
    if (rangeSeparator !== null) {
      const parts = token.split(rangeSeparator).map((part) => part.trim());
      if (parts.length !== 2) {
        issues.push(`无法解析范围 '${token}'`);
        continue;
      }
      const left = parseReference(parts[0]);
      const right = /^\d+$/u.test(parts[1])
        ? left === null
          ? null
          : parseReference(`${left.prefix === "UX-DR" ? "UX-DR" : `${left.prefix}-`}${parts[1]}`)
        : parseReference(parts[1]);
      if (
        left === null ||
        right === null ||
        left.prefix !== right.prefix ||
        left.number >= right.number ||
        !options.allowedPrefixes.has(left.prefix)
      ) {
        issues.push(`非法、反向或跨前缀范围 '${token}'`);
        continue;
      }
      const maximum = definitionProfiles[left.prefix]?.maximum;
      if (maximum === undefined || right.number > maximum) {
        issues.push(`范围越界 '${token}'`);
        continue;
      }
      for (let number = left.number; number <= right.number; number += 1) {
        addReference(references, issues, left.prefix, number, options);
      }
      continue;
    }
    const reference = parseReference(token);
    if (reference === null || !options.allowedPrefixes.has(reference.prefix)) {
      issues.push(`未知、裸数字或非法引用 '${token}'`);
      continue;
    }
    addReference(references, issues, reference.prefix, reference.number, options);
  }
  return { issues, references };
}

/** 添加引用并校验定义存在与重复。 */
function addReference(references, issues, prefix, number, options) {
  const reference = formatReference(prefix, number);
  if (options.definitions !== null && !options.definitions.get(prefix)?.has(reference)) {
    issues.push(`引用未定义或越界 '${reference}'`);
    return;
  }
  if (references.has(reference)) {
    issues.push(`重复引用 '${reference}'`);
    return;
  }
  references.add(reference);
}

/** 解析带完整前缀且无前导零的单个规范 ID。 */
function parseReference(source) {
  const standard = /^(AD|AR|FR|NFR|SM|UJ)-([1-9][0-9]*)$/u.exec(source);
  if (standard !== null) {
    const number = Number(standard[2]);
    return Number.isSafeInteger(number) ? { number, prefix: standard[1] } : null;
  }
  const ux = /^UX-DR([1-9][0-9]*)$/u.exec(source);
  if (ux === null) {
    return null;
  }
  const number = Number(ux[1]);
  return Number.isSafeInteger(number) ? { number, prefix: "UX-DR" } : null;
}

/** 使用规范允许的中英文列表分隔符切分 token。 */
function splitReferenceTokens(source) {
  return source
    .split(/[、，,]/u)
    .map((token) => token.trim());
}

/** 格式化规范 ID，UX-DR 不在编号前增加额外连字符。 */
function formatReference(prefix, number) {
  return prefix === "UX-DR" ? `UX-DR${number}` : `${prefix}-${number}`;
}

/** 从规范引用恢复 prefix。 */
function prefixOf(reference) {
  return reference.startsWith("UX-DR") ? "UX-DR" : reference.slice(0, reference.indexOf("-"));
}

/** 比较两个字符串集合。 */
function sameStringSet(left, right) {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

/** 以单遍 block state 遮蔽 fenced code 与 HTML 注释，HTML 注释状态优先于 fence。 */
function maskNonSemanticMarkdown(source) {
  const lines = source.match(/.*(?:\r\n|\n|\r|$)/gu) ?? [];
  let fence = null;
  let inComment = false;
  return lines
    .map((line) => {
      const content = line.replace(/[\r\n]+$/u, "");
      if (fence === null) {
        const result = maskHtmlCommentsInLine(line, inComment);
        inComment = result.inComment;
        const semanticContent = stripMarkdownContainerPrefix(
          result.line.replace(/[\r\n]+$/u, ""),
        );
        const opening = /^(?: {0,3})(`{3,}|~{3,})[^\r\n]*$/u.exec(semanticContent);
        if (opening !== null && !inComment) {
          fence = { character: opening[1][0], length: opening[1].length };
          return line.replace(/[^\r\n]/gu, " ");
        }
        return result.line;
      } else {
        const semanticContent = stripMarkdownContainerPrefix(content);
        const closing = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/u.exec(semanticContent);
        const masked = line.replace(/[^\r\n]/gu, " ");
        if (
          closing !== null &&
          closing[1][0] === fence.character &&
          closing[1].length >= fence.length
        ) {
          fence = null;
        }
        return masked;
      }
    })
    .join("");
}

/** 链接语义额外遮蔽 inline code span 与缩进代码块，避免示例链接触发门禁。 */
function maskMarkdownLinkCode(source) {
  return maskInlineCodeSpans(maskIndentedCodeBlocks(maskNonSemanticMarkdown(source)));
}

/** 遮蔽四空格或 tab 开头的 CommonMark 缩进代码行，并保持行号。 */
function maskIndentedCodeBlocks(source) {
  const lines = source.match(/.*(?:\r\n|\n|\r|$)/gu) ?? [];
  let listContentIndent = null;
  return lines
    .map((line) => {
      const content = line.replace(/[\r\n]+$/u, "");
      const listMarker = /^( {0,3})(?:[-+*]|[0-9]{1,9}[.)])([ \t]+)/u.exec(content);
      if (listMarker !== null) {
        listContentIndent = listMarker[1].length + listMarker[0].length - listMarker[1].length;
        return line;
      }
      if (/^[ \t]*$/u.test(content)) {
        return line;
      }
      const leadingSpaces = /^( *)/u.exec(content)?.[1].length ?? 0;
      const isIndented = leadingSpaces >= 4 || content.startsWith("\t");
      const belongsToListParagraph =
        listContentIndent !== null &&
        !content.startsWith("\t") &&
        leadingSpaces >= listContentIndent &&
        leadingSpaces < listContentIndent + 4;
      if (isIndented && !belongsToListParagraph) {
        return line.replace(/[^\r\n]/gu, " ");
      }
      if (leadingSpaces < (listContentIndent ?? 0)) {
        listContentIndent = null;
      }
      return line;
    })
    .join("");
}

/** 遮蔽成对反引号 code span；不同长度的反引号 run 不互相闭合。 */
function maskInlineCodeSpans(source) {
  const characters = source.split("");
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== "`" || isEscapedCharacter(characters, index)) {
      continue;
    }
    const openingLength = countCharacterRun(characters, index, "`");
    let closingIndex = index + openingLength;
    while (closingIndex < characters.length) {
      if (
        characters[closingIndex] !== "`" ||
        isEscapedCharacter(characters, closingIndex)
      ) {
        closingIndex += 1;
        continue;
      }
      const closingLength = countCharacterRun(characters, closingIndex, "`");
      if (closingLength === openingLength) {
        for (
          let maskIndex = index;
          maskIndex < closingIndex + closingLength;
          maskIndex += 1
        ) {
          if (characters[maskIndex] !== "\r" && characters[maskIndex] !== "\n") {
            characters[maskIndex] = " ";
          }
        }
        index = closingIndex + closingLength - 1;
        break;
      }
      closingIndex += closingLength;
    }
  }
  return characters.join("");
}

/** 统计指定位置连续出现的同一字符数。 */
function countCharacterRun(characters, startIndex, character) {
  let endIndex = startIndex;
  while (characters[endIndex] === character) {
    endIndex += 1;
  }
  return endIndex - startIndex;
}

/** CommonMark 反斜杠转义以连续反斜杠奇偶决定当前标点是否为字面量。 */
function isEscapedCharacter(characters, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && characters[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** URI scheme 大小写不敏感；任意合法 scheme 与文档内 anchor 均不按相对路径处理。 */
function isExternalMarkdownTarget(rawTarget) {
  return /^(?:[A-Za-z][A-Za-z0-9+.-]*:|#|\/\/)/u.test(rawTarget);
}

/** 移除 blockquote/list 容器前缀，只用于识别容器内 CommonMark fence。 */
function stripMarkdownContainerPrefix(content) {
  let remainder = content;
  while (true) {
    const blockquote = /^ {0,3}>[ \t]?/u.exec(remainder);
    if (blockquote !== null) {
      remainder = remainder.slice(blockquote[0].length);
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+/u.exec(remainder);
    if (list !== null) {
      remainder = remainder.slice(list[0].length);
      continue;
    }
    return remainder;
  }
}

/** 遮蔽单行 HTML comment 片段，同时把状态传给下一非 fence 行。 */
function maskHtmlCommentsInLine(line, initialState) {
  const characters = line.split("");
  let inComment = initialState;
  let cursor = 0;
  while (cursor < line.length) {
    if (inComment) {
      const closing = line.indexOf("-->", cursor);
      const end = closing < 0 ? line.length : closing + 3;
      for (let index = cursor; index < end; index += 1) {
        if (characters[index] !== "\r" && characters[index] !== "\n") {
          characters[index] = " ";
        }
      }
      if (closing < 0) {
        break;
      }
      inComment = false;
      cursor = end;
      continue;
    }
    const opening = line.indexOf("<!--", cursor);
    if (opening < 0) {
      break;
    }
    cursor = opening;
    inComment = true;
  }
  return { inComment, line: characters.join("") };
}

/** 收集 inline 与引用式 Markdown 链接定义中的目标。 */
function collectMarkdownLinkTargets(source) {
  return [
    ...collectInlineMarkdownLinkTargets(source),
    ...collectReferenceMarkdownLinkTargets(source),
  ].sort((left, right) => left.index - right.index);
}

/** 解析允许平衡括号、尖括号目标和可选 title 的 inline Markdown 链接。 */
function collectInlineMarkdownLinkTargets(source) {
  const targets = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "[" || isEscapedCharacter(source, index)) {
      continue;
    }
    const labelEnd = findInlineLinkLabelEnd(source, index + 1);
    if (labelEnd < 0 || source[labelEnd + 1] !== "(") {
      continue;
    }
    const parsed = parseInlineLinkDestination(source, labelEnd + 2);
    if (parsed !== null) {
      targets.push({ index, target: parsed.target });
      index = parsed.endIndex;
    }
  }
  return targets;
}

/** 解析支持转义与嵌套方括号的 inline link label。 */
function findInlineLinkLabelEnd(source, startIndex) {
  let depth = 1;
  for (let index = startIndex; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === "[") {
      depth += 1;
    } else if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** 解析引用式链接目标；title 不属于路径。 */
function collectReferenceMarkdownLinkTargets(source) {
  const targets = [];
  const pattern = /^\s*\[[^\]]+\]:\s*(?:<((?:\\.|[^>])*)>|((?:\\.|[^\s])+))/mgu;
  for (const match of source.matchAll(pattern)) {
    targets.push({
      index: match.index ?? 0,
      target: unescapeMarkdownDestination(match[1] ?? match[2] ?? ""),
    });
  }
  return targets;
}

/** 解析单个 inline destination，裸目标允许转义和平衡括号。 */
function parseInlineLinkDestination(source, startIndex) {
  let cursor = startIndex;
  while (cursor < source.length && /[ \t]/u.test(source[cursor])) {
    cursor += 1;
  }
  if (source[cursor] === "<") {
    const close = findUnescapedCharacter(source, cursor + 1, ">");
    if (close < 0) {
      return null;
    }
    const endIndex = findInlineLinkClose(source, close + 1);
    return endIndex < 0
      ? null
      : {
          endIndex,
          target: unescapeMarkdownDestination(source.slice(cursor + 1, close)),
        };
  }
  const targetStart = cursor;
  let depth = 0;
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) {
        return targetStart === cursor
          ? null
          : {
              endIndex: cursor,
              target: unescapeMarkdownDestination(source.slice(targetStart, cursor)),
            };
      }
      depth -= 1;
      continue;
    }
    if (depth === 0 && /[ \t\r\n]/u.test(character)) {
      const endIndex = findInlineLinkClose(source, cursor);
      return targetStart === cursor || endIndex < 0
        ? null
        : {
            endIndex,
            target: unescapeMarkdownDestination(source.slice(targetStart, cursor)),
          };
    }
  }
  return null;
}

/** 跳过空白和合法 title，返回 inline link 的外层右括号。 */
function findInlineLinkClose(source, startIndex) {
  let cursor = startIndex;
  while (cursor < source.length && /[ \t\r\n]/u.test(source[cursor])) {
    cursor += 1;
  }
  if (source[cursor] === ")") {
    return cursor;
  }
  const opening = source[cursor];
  const closing = opening === '"' ? '"' : opening === "'" ? "'" : opening === "(" ? ")" : null;
  if (closing === null) {
    return -1;
  }
  const titleEnd = findUnescapedCharacter(source, cursor + 1, closing);
  if (titleEnd < 0) {
    return -1;
  }
  cursor = titleEnd + 1;
  while (cursor < source.length && /[ \t\r\n]/u.test(source[cursor])) {
    cursor += 1;
  }
  return source[cursor] === ")" ? cursor : -1;
}

/** 查找未被反斜杠转义的目标字符。 */
function findUnescapedCharacter(source, startIndex, expected) {
  for (let index = startIndex; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === expected) {
      return index;
    }
  }
  return -1;
}

/** Markdown destination 只反转义 CommonMark 定义的 ASCII 标点。 */
function unescapeMarkdownDestination(source) {
  return source.replace(/\\([!-/:-@[-`{-~])/gu, "$1");
}

/** 使用 DFS 检测依赖边中的环。 */
function hasDirectedCycle(nodes) {
  const active = new Set();
  const complete = new Set();
  const visit = (node) => {
    if (active.has(node)) {
      return true;
    }
    if (complete.has(node)) {
      return false;
    }
    active.add(node);
    for (const dependency of nodes.get(node) ?? []) {
      if (nodes.has(dependency) && visit(dependency)) {
        return true;
      }
    }
    active.delete(node);
    complete.add(node);
    return false;
  };
  return [...nodes.keys()].some((node) => visit(node));
}

/** 验证对象精确包含指定字段。 */
function isClosedObject(value, expectedKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** 创建只含相对路径、稳定规则、位置和可执行修复建议的诊断。 */
function violation(relativePath, rule, message, suggestion, line) {
  return {
    ...(line === undefined ? {} : { line }),
    message,
    relativePath,
    rule,
    suggestion,
  };
}

/** 计算字符串索引所在的 1-based 行。 */
function lineForIndex(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** 将固定 POSIX 相对路径解析到给定仓库根目录。 */
function resolveRelative(repositoryRoot, relativePath) {
  return path.join(repositoryRoot, ...relativePath.split("/"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const violations = await checkPlanningTraceability(repositoryRoot);
  for (const finding of violations) {
    console.error(
      `${finding.relativePath}${finding.line === undefined ? "" : `:${finding.line}`}: ${finding.message} Rule: ${finding.rule}. Fix: ${finding.suggestion}.`,
    );
  }
  process.exitCode = violations.length === 0 ? 0 : 1;
}
