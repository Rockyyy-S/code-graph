import { readFile } from "node:fs/promises";
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
    return checkPlanningTraceabilitySources(
      await loadPlanningTraceSources(repositoryRoot),
    );
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
export function checkPlanningTraceabilitySources(sources) {
  const violations = [];
  const definitions = collectDefinitions(sources, violations);
  const stories = collectStories(sources.epics ?? "", definitions, violations);
  const dag = validateStoryDag(sources.epics ?? "", stories, violations);
  validateAdBinds(sources.architecture ?? "", definitions, violations);
  validateReverseTraceTable(sources.epics ?? "", stories, violations);
  validateRelativeLinks(sources, violations);
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
    const matches = [...source.matchAll(patterns[prefix])];
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
  const headings = [...epicsSource.matchAll(headingPattern)];
  const stories = new Map();
  for (const [index, heading] of headings.entries()) {
    const storyId = heading[1];
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? epicsSource.length;
    const section = epicsSource.slice(start, end);
    const association = /^\*\*关联需求：\*\*\s*(.+)$/mu.exec(section);
    if (association === null) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.epics,
          "story-requirement",
          `Story ${storyId} 缺少关联需求。`,
          `在 Story ${storyId} 中添加使用完整前缀的 **关联需求：** 行`,
          lineForIndex(epicsSource, start),
        ),
      );
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
  if (stories.size !== 61) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "story-coverage",
        `Story 定义应恰好为 61 个，实际为 ${stories.size} 个。`,
        "恢复 61 个唯一 Story 标题及关联需求，不从正文顺序推断缺失 Story",
      ),
    );
  }
  return stories;
}

/** 只使用各 AD 的 Binds 解析直接需求边，忽略 Capability Map 导航。 */
function validateAdBinds(architectureSource, definitions, violations) {
  const headings = [...architectureSource.matchAll(/^### AD-(\d+)\s/mgu)];
  for (const [index, heading] of headings.entries()) {
    const adId = `AD-${heading[1]}`;
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? architectureSource.length;
    const section = architectureSource.slice(start, end);
    const binds = /^- \*\*Binds:\*\*\s*(.+)$/mu.exec(section);
    if (binds === null) {
      violations.push(
        violation(
          PLANNING_TRACE_SOURCE_SET_V1.architecture,
          "ad-binds",
          `${adId} 缺少唯一 Binds。`,
          `为 ${adId} 添加只含规范 ID 或 all|deployment|traceability 的 Binds`,
          lineForIndex(architectureSource, start),
        ),
      );
      continue;
    }
    const tokens = splitReferenceTokens(binds[1]);
    for (const token of tokens) {
      if (symbolicAdBinds.has(token)) {
        continue;
      }
      const parsed = parseReferenceList(token, {
        allowedPrefixes: new Set(["FR", "NFR", "SM", "UJ", "UX-DR"]),
        definitions,
      });
      if (parsed.issues.length > 0 || parsed.references.size === 0) {
        violations.push(
          violation(
            PLANNING_TRACE_SOURCE_SET_V1.architecture,
            "ad-binds",
            `${adId} Binds token '${token}' 未遵循 Planning Reference Grammar。`,
            "展开未声明缩写，并使用 PREFIX-a 至 PREFIX-b、PREFIX-a–PREFIX-b 或 PREFIX-a–b",
            lineForIndex(architectureSource, start + (binds.index ?? 0)),
          ),
        );
      }
    }
  }
}

/** 解析并验证覆盖全部 Story 的 StoryDependencyDagV1。 */
function validateStoryDag(epicsSource, stories, violations) {
  const block = /### StoryDependencyDagV1[^\r\n]*[\s\S]*?```yaml\s*([\s\S]*?)```/u.exec(
    epicsSource,
  );
  if (block === null) {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "dag-parse",
        "缺少 StoryDependencyDagV1 YAML block。",
        "恢复覆盖全部 61 个 Story 的唯一 StoryDependencyDagV1 block",
      ),
    );
    return new Map();
  }
  let document;
  try {
    document = parse(block[1], { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    violations.push(
      violation(
        PLANNING_TRACE_SOURCE_SET_V1.epics,
        "dag-parse",
        "StoryDependencyDagV1 YAML 无法解析或包含重复 key。",
        "修复 YAML，并确保每个 Story 只出现一次",
        lineForIndex(epicsSource, block.index ?? 0),
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

/** 对“本次调整的需求追踪”人工反向表与 Story 关联需求逐列比较。 */
function validateReverseTraceTable(epicsSource, stories, violations) {
  const section = /### 本次调整的需求追踪\s*([\s\S]*?)### 关键合同与 Story 双向映射/u.exec(
    epicsSource,
  );
  if (section === null) {
    return;
  }
  const rows = section[1]
    .split(/\r?\n/u)
    .filter((line) => /^\|\s*\d+\.\d+\s*\|/u.test(line));
  for (const row of rows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 5) {
      continue;
    }
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
}

/** 验证相对 Markdown 链接只解析到 source set 内现有规范路径。 */
function validateRelativeLinks(sources, violations) {
  const availablePaths = new Set(Object.values(PLANNING_TRACE_SOURCE_SET_V1));
  for (const [role, source] of Object.entries(sources)) {
    const sourcePath = PLANNING_TRACE_SOURCE_SET_V1[role];
    if (sourcePath === undefined || role === "sprintStatus") {
      continue;
    }
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const rawTarget = match[1].trim();
      if (/^(?:https?:|mailto:|#)/u.test(rawTarget)) {
        continue;
      }
      const targetPath = decodeURIComponent(rawTarget.split("#")[0]);
      if (
        targetPath.length === 0 ||
        targetPath.includes("\\") ||
        path.posix.isAbsolute(targetPath)
      ) {
        violations.push(relativeLinkViolation(sourcePath, source, match, rawTarget));
        continue;
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(sourcePath), targetPath),
      );
      if (resolved.startsWith("../") || !availablePaths.has(resolved)) {
        violations.push(relativeLinkViolation(sourcePath, source, match, rawTarget));
      }
    }
  }
}

/** 创建相对链接失败诊断。 */
function relativeLinkViolation(sourcePath, source, match, rawTarget) {
  return violation(
    sourcePath,
    "relative-link",
    `相对 Markdown 链接 '${rawTarget}' 未解析到仓库内当前规范文件。`,
    "修复为 Planning Trace Source Set 中存在的相对路径，并保留可选 #anchor",
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
    for (const role of roles) {
      if (!(sources[role] ?? "").includes(contractName)) {
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
    statusByStory.set(storyId, developmentStatus[matchingKeys[0]]);
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
  const normalized = source.trim().replace(/（[^）]*）/gu, "").replace(/\([^)]*\)/gu, "");
  if (options.allowNotApplicable && normalized === "N/A") {
    return { issues, references };
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
    return { number: Number(standard[2]), prefix: standard[1] };
  }
  const ux = /^UX-DR([1-9][0-9]*)$/u.exec(source);
  return ux === null ? null : { number: Number(ux[1]), prefix: "UX-DR" };
}

/** 使用规范允许的中英文列表分隔符切分 token。 */
function splitReferenceTokens(source) {
  return source
    .split(/[、，,；;]/u)
    .map((token) => token.trim())
    .filter(Boolean);
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
