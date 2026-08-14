import {
  assertSourceRange,
  buildGraphEdgeId,
  buildModuleEvidenceId,
  createExternalPackageNode,
  createUnresolvedExternalPackageNode,
  createNodeBuiltinNode,
  isCanonicalUtcTimestamp,
  serializeModuleQualifier,
  type AnalysisDiagnosticV1,
  type LocalExportBindingSeedV1,
  type ModuleConfidenceV1,
  type ModuleLanguageV1,
  type ModuleQualifierV1,
  type ModuleRelationTypeV1,
  type ModuleSourceFactBatchV1,
  type ModuleTargetV1,
  type SourceRangeV1,
} from "@codegraph/domain";
import { compareCanonicalGraphText } from "./hierarchy-builder.js";

/** Adapter 交付、application 规范化为模块事实的单条关系 seed。 */
export interface ModuleRelationSeedV1 {
  confidence: ModuleConfidenceV1;
  language: ModuleLanguageV1;
  normalizedRange: SourceRangeV1;
  provenance: "typescript-compiler-api";
  qualifier: ModuleQualifierV1;
  relationType: ModuleRelationTypeV1;
  target: ModuleTargetV1;
}

/** 构造 source module FactBatch 的完整输入。 */
export interface BuildModuleSourceFactBatchOptions {
  analyzerKind: "typescript";
  analyzerVersion: string;
  configDigest: string;
  coverage: "complete" | "failed" | "partial";
  detectedAt: string;
  diagnostics: readonly AnalysisDiagnosticV1[];
  inputDigest: string;
  localExportBindings: readonly LocalExportBindingSeedV1[];
  relations: readonly ModuleRelationSeedV1[];
  sourceFileId: string;
  workspaceKey: string;
}

/**
 * 将 Analyzer seed 规范化为稳定 module edge 与 AD-21 Evidence。
 *
 * source slice 只拥有 Evidence；共享模块节点和 edge 由 composite patch 统一维持。
 */
export function buildModuleSourceFactBatch(
  options: BuildModuleSourceFactBatchOptions,
): ModuleSourceFactBatchV1 {
  assertDigest(options.configDigest, "configDigest");
  assertDigest(options.inputDigest, "inputDigest");
  if (options.analyzerVersion.length === 0 || !isCanonicalUtcTimestamp(options.detectedAt)) {
    throw new TypeError("Analyzer 版本或 detectedAt 不合法。");
  }
  const nodes = new Map<string, ReturnType<typeof createExternalPackageNode> |
    ReturnType<typeof createUnresolvedExternalPackageNode> |
    ReturnType<typeof createNodeBuiltinNode>>();
  const edges = new Map<string, ModuleSourceFactBatchV1["edges"][number]>();
  const evidence = new Map<string, ModuleSourceFactBatchV1["evidence"][number]>();
  for (const relation of options.relations) {
    assertSourceRange(relation.normalizedRange);
    const qualifier = serializeModuleQualifier(relation.qualifier);
    let targetId: string;
    if (relation.target.kind === "internal-file") {
      targetId = relation.target.id;
    } else if (relation.target.kind === "external-package") {
      const node = relation.target.versionState === "unresolved"
        ? createUnresolvedExternalPackageNode(relation.target.packageName)
        : createExternalPackageNode(
            relation.target.packageName,
            relation.target.packageVersion ?? "",
          );
      if (node.id !== relation.target.id) {
        throw new TypeError("外部包目标 ID 与标准 npm purl 不一致。");
      }
      nodes.set(node.id, node);
      targetId = node.id;
    } else {
      const node = createNodeBuiltinNode(relation.target.moduleName);
      if (node.id !== relation.target.id) {
        throw new TypeError("Node built-in 目标 ID 不一致。");
      }
      nodes.set(node.id, node);
      targetId = node.id;
    }
    const edge = Object.freeze({
      fromId: options.sourceFileId,
      id: buildGraphEdgeId(
        options.workspaceKey,
        options.sourceFileId,
        relation.relationType,
        targetId,
        qualifier,
      ),
      qualifier,
      relationType: relation.relationType,
      toId: targetId,
    });
    const existingEdge = edges.get(edge.id);
    if (existingEdge !== undefined && JSON.stringify(existingEdge) !== JSON.stringify(edge)) {
      throw new TypeError("模块关系包含相同 ID 的冲突定义。");
    }
    edges.set(edge.id, edge);
    const evidenceId = buildModuleEvidenceId({
      analyzerVersion: options.analyzerVersion,
      edgeId: edge.id,
      evidenceKind: "module-dependency",
      normalizedRange: relation.normalizedRange,
      provenance: relation.provenance,
      sourceFileId: options.sourceFileId,
    });
    const item = Object.freeze({
      analyzerVersion: options.analyzerVersion,
      confidence: relation.confidence,
      detectedAt: options.detectedAt,
      edgeId: edge.id,
      evidenceKind: "module-dependency" as const,
      id: evidenceId,
      language: relation.language,
      normalizedRange: Object.freeze({ ...relation.normalizedRange }),
      provenance: relation.provenance,
      sourceFileId: options.sourceFileId,
    });
    const existingEvidence = evidence.get(evidenceId);
    if (existingEvidence !== undefined && semanticEvidence(existingEvidence) !== semanticEvidence(item)) {
      throw new TypeError("模块 Evidence 包含相同 ID 的冲突定义。");
    }
    evidence.set(evidenceId, item);
  }
  return Object.freeze({
    analyzerKind: options.analyzerKind,
    analyzerVersion: options.analyzerVersion,
    configDigest: options.configDigest,
    coverage: options.coverage,
    diagnostics: Object.freeze([...options.diagnostics].sort(compareDiagnostics)),
    edges: Object.freeze([...edges.values()].sort(compareById)),
    evidence: Object.freeze([...evidence.values()].sort(compareById)),
    inputDigest: options.inputDigest,
    localExportBindings: Object.freeze(
      [...options.localExportBindings].sort((left, right) =>
        compareCanonicalGraphText(left.stableSortKey, right.stableSortKey)),
    ),
    nodes: Object.freeze([...nodes.values()].sort(compareById)),
    ownershipSliceId: `source:${options.analyzerKind}:${options.sourceFileId}`,
    sourceFileId: options.sourceFileId,
  });
}

/** 稳定事实排序只依赖公共 ID。 */
function compareById(left: { id: string }, right: { id: string }): number {
  return compareCanonicalGraphText(left.id, right.id);
}

/** 诊断排序不依赖区域设置或 Worker 完成顺序。 */
function compareDiagnostics(left: AnalysisDiagnosticV1, right: AnalysisDiagnosticV1): number {
  return compareCanonicalGraphText(left.path, right.path) ||
    left.normalizedRange.start - right.normalizedRange.start ||
    compareCanonicalGraphText(left.code, right.code);
}

/** detectedAt 是观察元数据，不参与 Evidence 语义相等判断。 */
function semanticEvidence(value: ModuleSourceFactBatchV1["evidence"][number]): string {
  const { detectedAt: _detectedAt, ...semantic } = value;
  void _detectedAt;
  return JSON.stringify(semantic);
}

/** 所有语义 digest 使用 SHA-256 小写十六进制。 */
function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} 必须是 SHA-256 小写十六进制。`);
  }
}
