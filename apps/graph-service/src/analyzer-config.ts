import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createAnalyzerConfigSnapshot,
  createAnalyzerInputDigest,
  AnalyzerFailureError,
  buildGraphEntityId,
  isSupportedSourceFile,
  normalizeHostPathIdentity,
  normalizeRelativeGraphPath,
  type AnalyzerByteFileV1,
  type AnalyzerConfigSnapshotV1,
  type AnalyzerHostPathIdentitySidecarV1,
  type AnalyzerPort,
  type AnalyzerSourceFileV1,
} from "@codegraph/application";
import { sha256CanonicalJson } from "@codegraph/contracts";
import type { EffectiveIgnoreSnapshotV1 } from "./ignore-bootstrap.js";
import {
  isFileSystemCaseSensitive,
  MAX_SOURCE_FILE_BYTES,
  type WorkspaceScanResult,
} from "./workspace-scanner.js";
import type {
  HostPathCandidateResolutionV1,
  HostPathIdentityCandidateV1,
} from "./host-path-identity.js";

/** 单个受控 Analyzer 元数据文件的最大字节数。 */
export const MAX_ANALYZER_METADATA_FILE_BYTES = 2 * 1024 * 1024;

/** 单轮配置封口允许读取的元数据总字节数。 */
export const MAX_ANALYZER_METADATA_TOTAL_BYTES = 16 * 1024 * 1024;

/** 配置/解析元数据图允许的最大显式深度。 */
export const MAX_ANALYZER_METADATA_GRAPH_DEPTH = 128;

/** 单轮 Job 最多接受的唯一解析文件候选数。 */
export const MAX_ANALYZER_RESOLUTION_CANDIDATES = 4_096;

/** 主进程在插入候选时限制规范路径 UTF-8 总字节数。 */
export const MAX_ANALYZER_RESOLUTION_CANDIDATE_PATH_BYTES = 512 * 1024;
/** 根级 Analyzer 元数据无论存在或缺失都必须进入同一配置 read-set。 */
export const ANALYZER_ROOT_METADATA_PATHS = Object.freeze([
  "jsconfig.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "yarn.lock",
] as const);

/** 实际回送 Worker 的解析元数据文件数上限。 */
export const MAX_ANALYZER_RESOLUTION_FILES = 1_024;

/** 文件句柄读取使用固定小块，并只额外读取一个 sentinel 字节判定增长超限。 */
const ANALYZER_BOUNDED_READ_CHUNK_BYTES = 64 * 1024;

const analyzerCaptureMetrics = {
  blockedBytesHashed: 0,
  blockedFilePeakCount: 0,
  blockedPeakBufferedBytes: 0,
  blockedStatPreRejected: 0,
  blockedTotalBytesPeak: 0,
  synchronousFenceBytesHashed: 0,
};

/** CR5 预算回归只读观测，不暴露文件内容或物理路径。 */
export function readAnalyzerCaptureMetricsForTests(): Readonly<Record<string, number>> {
  return Object.freeze({ ...analyzerCaptureMetrics });
}

/** 单测之间清空进程内计数；生产流程不会调用。 */
export function resetAnalyzerCaptureMetricsForTests(): void {
  for (const key of Object.keys(analyzerCaptureMetrics) as Array<keyof typeof analyzerCaptureMetrics>) {
    analyzerCaptureMetrics[key] = 0;
  }
}

/** Analyzer 文件身份由事务外完整 hash 准备，事务内仅执行低成本复核。 */
export interface AnalyzerFileIdentityProofV1 {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  maximumBytes: number;
  mtimeNs: bigint;
  path: string;
  size: bigint;
}

/** AnalyzerConfigSnapshot 的事务外同步准备证明。 */
export interface PreparedAnalyzerConfigFenceV1 {
  absentPaths: readonly string[];
  files: readonly AnalyzerFileIdentityProofV1[];
}

/** read-set capture 与后续 analyze 共享的不可变上下文。 */
export interface PreparedAnalyzerContextV1 {
  caseSensitiveFileNames?: boolean;
  configDigest: string;
  configSnapshot: AnalyzerConfigSnapshotV1;
  configurationEntryPaths: readonly string[];
  configurationFiles: readonly AnalyzerByteFileV1[];
  /** 请求级 proof sidecar 只随 capture 进入 Worker，不进入 read-set 或任何持久化摘要。 */
  hostPathIdentitySidecar?: AnalyzerHostPathIdentitySidecarV1;
  inputDigest: string;
  resolutionFiles: readonly AnalyzerByteFileV1[];
  sourceFiles: readonly AnalyzerSourceFileV1[];
}

/** blocked 源码的预检结果；预算判断完成后才允许开始流式 hash。 */
export interface AnalyzerBlockedResolutionInspectionV1 {
  byteLength: number;
  capture(signal?: AbortSignal): Promise<{ byteLength: number; contentHash: string }>;
}

/** Analyzer 配置捕获的可替换 I/O 边界，生产默认实现仍执行完整文件身份校验。 */
export interface AnalyzerConfigCaptureDependencies {
  /** 测试可固定 host 语义；生产省略时仍只读探测真实 indexing root。 */
  caseSensitiveFileNames?: boolean;
  inspectBlockedResolutionFile?: (
    indexingRoot: string,
    logicalPath: string,
    signal?: AbortSignal,
  ) => Promise<AnalyzerBlockedResolutionInspectionV1 | null>;
  readMetadataFile?: (
    indexingRoot: string,
    logicalPath: string,
    signal?: AbortSignal,
  ) => Promise<AnalyzerByteFileV1 | null>;
}

/** Analyzer 语义上下文捕获函数。 */
export type CaptureAnalyzerSemanticContext = (
  scanResult: WorkspaceScanResult,
  signal?: AbortSignal,
) => Promise<PreparedAnalyzerContextV1>;

/**
 * 最终同步提交栅栏逐文件复核 AnalyzerConfigSnapshot 的身份与原始字节 hash。
 *
 * 任一缺失、替换、符号链接、root 逃逸或内容变化都返回 false；合法 pnpm hardlink 不被拒绝。
 */
export function verifyAnalyzerConfigSnapshotSynchronously(
  indexingRoot: string,
  snapshot: AnalyzerConfigSnapshotV1,
): boolean {
  return prepareAnalyzerConfigFenceSynchronously(indexingRoot, snapshot) !== null;
}

/** 事务外流式复核全部 Analyzer 文件字节并保存有界身份。 */
export function prepareAnalyzerConfigFenceSynchronously(
  indexingRoot: string,
  snapshot: AnalyzerConfigSnapshotV1,
): PreparedAnalyzerConfigFenceV1 | null {
  try {
    const files: AnalyzerFileIdentityProofV1[] = [];
    for (const [entry, maximumBytes] of [
      ...snapshot.consultedFiles.map((file) =>
        [file, MAX_ANALYZER_METADATA_FILE_BYTES] as const),
      ...(snapshot.blockedResolutionFiles ?? []).map((file) =>
        [file, MAX_SOURCE_FILE_BYTES] as const),
    ]) {
      const logicalPath = normalizeRelativeGraphPath(entry.path);
      if (logicalPath !== entry.path) {return null;}
      const absolutePath = path.join(indexingRoot, ...logicalPath.split("/"));
      const pathBefore = lstatSync(absolutePath, { bigint: true });
      if (
        !pathBefore.isFile() || pathBefore.isSymbolicLink() ||
        pathBefore.size > BigInt(maximumBytes)
      ) {
        return null;
      }
      const descriptor = openSync(
        absolutePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const before = fstatSync(descriptor, { bigint: true });
        if (!sameFileIdentity(pathBefore, before)) {return null;}
        const resolved = realpathSync(absolutePath);
        if (!isContainedPhysicalPath(indexingRoot, resolved)) {return null;}
        const hashed = hashDescriptorBoundedSync(descriptor, maximumBytes);
        const after = fstatSync(descriptor, { bigint: true });
        const pathAfter = lstatSync(absolutePath, { bigint: true });
        if (
          pathAfter.isSymbolicLink() || !sameFileIdentity(before, after) ||
          !sameFileIdentity(before, pathAfter) || hashed.byteLength !== Number(before.size) ||
          hashed.contentHash !== entry.contentHash
        ) {
          return null;
        }
        files.push(Object.freeze({
          ctimeNs: before.ctimeNs,
          dev: before.dev,
          ino: before.ino,
          maximumBytes,
          mtimeNs: before.mtimeNs,
          path: logicalPath,
          size: before.size,
        }));
      } finally {
        closeSync(descriptor);
      }
    }
    for (const absentPath of [
      ...(snapshot.absentFiles ?? []),
      ...(snapshot.absentResolutionFiles ?? []),
    ]) {
      const logicalPath = normalizeRelativeGraphPath(absentPath);
      if (logicalPath !== absentPath) {return null;}
      const absolutePath = path.join(indexingRoot, ...logicalPath.split("/"));
      try {
        lstatSync(absolutePath);
        return null;
      } catch (error) {
        if (!isMissingPathError(error)) {return null;}
      }
    }
    return Object.freeze({
      absentPaths: Object.freeze([
        ...(snapshot.absentFiles ?? []),
        ...(snapshot.absentResolutionFiles ?? []),
      ]),
      files: Object.freeze(files),
    });
  } catch {
    return null;
  }
}

/** SQLite 同步事务内只复核准备证明中的身份、范围与缺失事实。 */
export function verifyPreparedAnalyzerConfigFenceSynchronously(
  indexingRoot: string,
  snapshot: AnalyzerConfigSnapshotV1,
  prepared: PreparedAnalyzerConfigFenceV1,
): boolean {
  try {
    const expectedFiles = [
      ...snapshot.consultedFiles.map((file) =>
        [file.path, MAX_ANALYZER_METADATA_FILE_BYTES] as const),
      ...(snapshot.blockedResolutionFiles ?? []).map((file) =>
        [file.path, MAX_SOURCE_FILE_BYTES] as const),
    ];
    if (prepared.files.length !== expectedFiles.length) {return false;}
    const proofByPath = new Map(prepared.files.map((proof) => [proof.path, proof]));
    for (const [logicalPath, maximumBytes] of expectedFiles) {
      const proof = proofByPath.get(logicalPath);
      if (proof === undefined || proof.maximumBytes !== maximumBytes) {return false;}
      const absolutePath = path.join(indexingRoot, ...logicalPath.split("/"));
      const current = lstatSync(absolutePath, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() ||
        current.size > BigInt(maximumBytes) || !sameFileIdentity(proof, current) ||
        !isContainedPhysicalPath(indexingRoot, realpathSync(absolutePath))) {
        return false;
      }
    }
    const expectedAbsent = [
      ...(snapshot.absentFiles ?? []),
      ...(snapshot.absentResolutionFiles ?? []),
    ];
    if (prepared.absentPaths.length !== expectedAbsent.length ||
      prepared.absentPaths.some((entry, index) => entry !== expectedAbsent[index])) {
      return false;
    }
    for (const logicalPath of expectedAbsent) {
      try {
        lstatSync(path.join(indexingRoot, ...logicalPath.split("/")));
        return false;
      } catch (error) {
        if (!isMissingPathError(error)) {return false;}
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** 创建 graph-service 唯一的配置快照与 canonical digest 生产者。 */
export function createAnalyzerSemanticContextCapture(options: {
  analyzer: AnalyzerPort;
  effectiveIgnoreSnapshot: EffectiveIgnoreSnapshotV1;
  hostPathIdentityBroker?: AnalyzerHostPathIdentityBrokerPort;
  indexingRoot: string;
  workspaceKey: string;
}, dependencies: AnalyzerConfigCaptureDependencies = {}): CaptureAnalyzerSemanticContext {
  return async (scanResult, signal) => {
    try {
    const inspectBlockedResolutionFile = dependencies.inspectBlockedResolutionFile ??
      inspectTrustedBlockedResolutionFile;
    const readMetadataFile = dependencies.readMetadataFile ?? readTrustedMetadataFile;
    const configurationFiles = await collectAnalyzerMetadataFiles(
      options.indexingRoot,
      signal,
      readMetadataFile,
    );
    const configuredRootPaths = new Set(configurationFiles.map((file) => file.path));
    const absentRootMetadataPaths = ANALYZER_ROOT_METADATA_PATHS.filter(
      (logicalPath) => !configuredRootPaths.has(logicalPath),
    );
    const configurationEntryPaths = chooseAuthoritativeConfigurationEntries(configurationFiles);
    const caseSensitiveFileNames = dependencies.caseSensitiveFileNames ??
      isFileSystemCaseSensitive(options.indexingRoot);
    const sourceSnapshots = scanResult.sourceFiles ?? [];
    if (sourceSnapshots.length !== scanResult.manifest.length) {
      throw new Error("Analyzer 缺少与 manifest 同次可信读取绑定的源码字节快照。");
    }
    const sourceFiles = Object.freeze(sourceSnapshots.map<AnalyzerSourceFileV1>((file) => ({
      bytes: file.bytes,
      contentHash: file.contentHash,
      fileId: buildGraphEntityId(options.workspaceKey, "file", file.path),
      language: languageFromPath(file.path),
      path: file.path,
    })));
    const presentHostCandidates = new Map<string, AnalyzerHostPathCandidateState>();
    const scannerCandidates = new Map(
      (scanResult.sourceHostPathCandidates ?? []).map((candidate) => [
        candidate.logicalPath,
        candidate,
      ]),
    );
    for (const file of sourceFiles) {
      const scannerCandidate = scannerCandidates.get(file.path);
      if (!caseSensitiveFileNames && scannerCandidate === undefined) {
        throw new Error("Analyzer 缺少 scanner 同次读取产生的宿主路径断言。");
      }
      presentHostCandidates.set(file.path, {
        absolutePath: scannerCandidate?.absolutePath ??
          path.join(options.indexingRoot, ...file.path.split("/")),
        logicalPath: file.path,
        role: "source",
      });
    }
    for (const file of configurationFiles) {
      presentHostCandidates.set(file.path, {
        absolutePath: path.join(options.indexingRoot, ...file.path.split("/")),
        logicalPath: file.path,
        role: "configuration",
      });
    }
    const resolutionByPath = new Map<string, AnalyzerByteFileV1>();
    const blockedResolutionByPath = new Map<string, { contentHash: string; path: string }>();
    const absentResolutionPaths = new Map<string, string>();
    const attemptedCandidates = new Set<string>();
    let attemptedCandidatePathBytes = 0;
    const manifestPaths = new Set(sourceFiles.map((file) => file.path));
    const configurationPaths = new Set(configurationFiles.map((file) => file.path));
    let totalBytes = configurationFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    let observation: Awaited<ReturnType<AnalyzerPort["observeConfiguration"]>> | undefined;
    let graphDepth = 0;
    let hostPathIdentitySidecar: AnalyzerHostPathIdentitySidecarV1 | undefined;
    while (true) {
      hostPathIdentitySidecar = await captureAnalyzerHostPathIdentitySidecar(
        caseSensitiveFileNames,
        options.hostPathIdentityBroker,
        presentHostCandidates,
      );
      if (hostPathIdentitySidecar !== undefined) {
        const canonicalByPath = new Map(hostPathIdentitySidecar.entries.map((entry) => [
          entry.logicalPath,
          entry.canonicalLogicalPath,
        ]));
        for (const [logicalPath, file] of [...resolutionByPath]) {
          if (canonicalByPath.get(logicalPath) !== logicalPath) {
            resolutionByPath.delete(logicalPath);
            totalBytes -= file.bytes.byteLength;
            const candidate = presentHostCandidates.get(logicalPath);
            if (candidate !== undefined) {candidate.role = "alias";}
          }
        }
        for (const logicalPath of [...blockedResolutionByPath.keys()]) {
          if (canonicalByPath.get(logicalPath) !== logicalPath) {
            blockedResolutionByPath.delete(logicalPath);
            const candidate = presentHostCandidates.get(logicalPath);
            if (candidate !== undefined) {candidate.role = "alias";}
          }
        }
      }
      const resolutionFiles = [...resolutionByPath.values()]
        .sort((left, right) => compareText(left.path, right.path));
      observation = await options.analyzer.observeConfiguration({
        blockedResolutionLogicalPaths: Object.freeze([...blockedResolutionByPath.values()]
          .map((entry) => entry.path)
          .sort(compareText)),
        caseSensitiveFileNames,
        configurationEntryPaths,
        configurationFiles,
        ...(hostPathIdentitySidecar === undefined ? {} : { hostPathIdentitySidecar }),
        resolutionFiles,
        sourceFiles,
      }, signal);
      let addedFiles = 0;
      for (const candidate of observation.resolutionCandidateLogicalPaths) {
        const logicalPath = normalizeRelativeGraphPath(candidate);
        if (
          attemptedCandidates.has(logicalPath) || manifestPaths.has(logicalPath) ||
          configurationPaths.has(logicalPath)
        ) {continue;}
        if (attemptedCandidates.size >= MAX_ANALYZER_RESOLUTION_CANDIDATES) {
          throw new AnalyzerFailureError(
            "ANALYZER_RESOURCE_LIMIT",
            "Analyzer 模块解析候选数超过安全预算。",
          );
        }
        const candidateBytes = new TextEncoder().encode(logicalPath).byteLength;
        if (attemptedCandidatePathBytes + candidateBytes >
          MAX_ANALYZER_RESOLUTION_CANDIDATE_PATH_BYTES) {
          throw new AnalyzerFailureError(
            "ANALYZER_RESOURCE_LIMIT",
            "Analyzer 模块解析候选路径字节数超过安全预算。",
          );
        }
        attemptedCandidates.add(logicalPath);
        attemptedCandidatePathBytes += candidateBytes;
        /** root 内受支持源码必须来自 scanner manifest，不能通过 metadata broker 旁路进入。 */
        if (isSupportedSourceFile(logicalPath) &&
          !hasNodeModulesSegment(logicalPath, caseSensitiveFileNames)) {
          const blocked = await probeTrustedBlockedResolutionFile(
            options.indexingRoot,
            logicalPath,
            MAX_ANALYZER_METADATA_TOTAL_BYTES - totalBytes,
            MAX_ANALYZER_RESOLUTION_FILES - resolutionByPath.size -
              blockedResolutionByPath.size,
            signal,
            inspectBlockedResolutionFile,
          );
          if (blocked === null) {
            absentResolutionPaths.set(logicalPath, logicalPath);
          } else {
            absentResolutionPaths.delete(logicalPath);
            totalBytes += blocked.byteLength;
            blockedResolutionByPath.set(logicalPath, {
              contentHash: blocked.contentHash,
              path: blocked.path,
            });
            presentHostCandidates.set(logicalPath, {
              absolutePath: path.join(options.indexingRoot, ...logicalPath.split("/")),
              logicalPath,
              role: "blocked",
            });
            analyzerCaptureMetrics.blockedFilePeakCount = Math.max(
              analyzerCaptureMetrics.blockedFilePeakCount,
              blockedResolutionByPath.size,
            );
            analyzerCaptureMetrics.blockedTotalBytesPeak = Math.max(
              analyzerCaptureMetrics.blockedTotalBytesPeak,
              totalBytes,
            );
            addedFiles += 1;
          }
          continue;
        }
        let file: AnalyzerByteFileV1 | null;
        try {
          file = await readMetadataFile(options.indexingRoot, logicalPath, signal);
        } catch (error) {
          if (!isMissingPathError(error)) {throw error;}
          file = null;
        }
        if (file === null) {
          absentResolutionPaths.set(logicalPath, logicalPath);
          continue;
        }
        absentResolutionPaths.delete(logicalPath);
        totalBytes += file.bytes.byteLength;
        if (totalBytes > MAX_ANALYZER_METADATA_TOTAL_BYTES) {
          throw new AnalyzerFailureError(
            "ANALYZER_RESOURCE_LIMIT",
            "Analyzer 配置与解析元数据总字节数超过安全预算。",
          );
        }
        resolutionByPath.set(file.path, file);
        presentHostCandidates.set(file.path, {
          absolutePath: path.join(options.indexingRoot, ...file.path.split("/")),
          logicalPath: file.path,
          role: "resolution",
        });
        addedFiles += 1;
        if (resolutionByPath.size + blockedResolutionByPath.size >
          MAX_ANALYZER_RESOLUTION_FILES) {
          throw new AnalyzerFailureError(
            "ANALYZER_RESOURCE_LIMIT",
            "Analyzer 解析元数据文件数超过安全预算。",
          );
        }
      }
      if (addedFiles === 0) {
        break;
      }
      graphDepth += 1;
      if (graphDepth > MAX_ANALYZER_METADATA_GRAPH_DEPTH) {
        throw new AnalyzerFailureError(
          "ANALYZER_RESOURCE_LIMIT",
          "Analyzer 配置/解析元数据图深度超过安全预算。",
        );
      }
    }
    if (observation === undefined) {
      throw new AnalyzerFailureError(
        "ANALYZER_METADATA_UNSTABLE",
        "Analyzer 解析元数据 broker 未产生稳定观察。",
      );
    }
    const resolutionFiles = Object.freeze([...resolutionByPath.values()]
      .sort((left, right) => compareText(left.path, right.path)));
    const configuredByPath = new Map(
      [...configurationFiles, ...resolutionFiles].map((file) => [file.path, file]),
    );
    for (const consultedPath of observation.consultedLogicalPaths) {
      const canonicalPath = hostPathIdentitySidecar?.entries.find(
        (entry) => entry.logicalPath === consultedPath,
      )?.canonicalLogicalPath ?? consultedPath;
      if (!configuredByPath.has(canonicalPath)) {
        throw new Error("Worker 报告了尚未进入两阶段封口的配置路径。");
      }
    }
    /** root manifest/lockfile 即使未被 TypeScript parser 主动读取，也属于分析配置元数据。 */
    const consultedFiles = [...configurationFiles, ...resolutionFiles].map((file) => ({
      contentHash: file.contentHash,
      path: file.path,
    }));
    const requiredMissingFiles = observation.requiredMissingLogicalPaths ?? [];
    const requiredMissingSet = new Set(requiredMissingFiles);
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      absentFiles: requiredMissingFiles,
      absentResolutionFiles: [
        ...absentRootMetadataPaths,
        ...[...absentResolutionPaths]
          .filter(([logicalPath]) => !requiredMissingSet.has(logicalPath))
          .map(([, logicalPath]) => logicalPath),
      ],
      blockedResolutionFiles: [...blockedResolutionByPath.values()],
      consultedFiles,
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: {
        effectiveDigest: options.effectiveIgnoreSnapshot.effectiveDigest,
        version: 1,
      },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const inputDigest = createAnalyzerInputDigest({
      analyzerKind: "typescript",
      configDigest: created.configDigest,
      inputs: scanResult.manifest,
    }, { digest: sha256CanonicalJson });
    return Object.freeze({
      caseSensitiveFileNames,
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      configurationEntryPaths,
      configurationFiles,
      ...(hostPathIdentitySidecar === undefined ? {} : { hostPathIdentitySidecar }),
      inputDigest,
      resolutionFiles,
      sourceFiles,
    });
    } catch (error) {
      if (error instanceof AnalyzerFailureError ||
        (error instanceof Error && error.name === "AbortError")) {
        throw error;
      }
      throw new AnalyzerFailureError(
        error instanceof RangeError ? "ANALYZER_RESOURCE_LIMIT" : "ANALYZER_CONFIG_INVALID",
        "Analyzer 配置或解析元数据无法安全封口。",
        { cause: error },
      );
    }
  };
}

/**
 * 把 producer 的完整句柄批次投影为 Worker 可消费的瞬态 sidecar。
 *
 * 只有同一 `snapshotIdentity` 内的 opaque identity 可以比较；proof 缺失、整批失败、条目缺失或
 * 一个对象对应多个 manifest source 时全部 fail-closed。sidecar 不参与任何 canonical digest。
 */
async function captureAnalyzerHostPathIdentitySidecar(
  caseSensitiveFileNames: boolean,
  broker: AnalyzerHostPathIdentityBrokerPort | undefined,
  candidatesByPath: ReadonlyMap<string, AnalyzerHostPathCandidateState>,
): Promise<AnalyzerHostPathIdentitySidecarV1 | undefined> {
  if (caseSensitiveFileNames) {return undefined;}
  if (broker === undefined) {
    throw new AnalyzerFailureError(
      "ANALYZER_CONFIG_INVALID",
      "大小写不敏感宿主缺少 HostPathIdentityBroker 请求证明。",
    );
  }
  const candidates = [...candidatesByPath.values()]
    .map(({ absolutePath, logicalPath }) => ({ absolutePath, logicalPath }))
    .sort((left, right) => compareText(left.logicalPath, right.logicalPath));
  const proof = await broker.resolveCandidates(candidates);
  if (proof.status !== "complete" || proof.snapshotIdentity === null ||
    proof.entries.length !== candidatesByPath.size) {
    throw new AnalyzerFailureError(
      proof.status === "rejected" && /LIMIT_EXCEEDED$/u.test(proof.code)
        ? "ANALYZER_RESOURCE_LIMIT"
        : "ANALYZER_CONFIG_INVALID",
      "HostPathIdentityBroker 未能为 Analyzer 现存路径建立完整同批证明。",
    );
  }
  const identityByPath = new Map<string, string>();
  for (const entry of proof.entries) {
    const candidate = candidatesByPath.get(entry.logicalPath);
    const observation = entry.observation;
    if (candidate === undefined || observation.status !== "present" ||
      observation.identityLifetime !== "snapshot" ||
      observation.snapshotIdentity !== proof.snapshotIdentity ||
      identityByPath.has(entry.logicalPath)) {
      throw new AnalyzerFailureError(
        "ANALYZER_CONFIG_INVALID",
        "HostPathIdentityBroker proof 条目缺失、变化或不属于同一请求快照。",
      );
    }
    identityByPath.set(entry.logicalPath, observation.identity);
  }
  if (identityByPath.size !== candidatesByPath.size) {
    throw new AnalyzerFailureError(
      "ANALYZER_CONFIG_INVALID",
      "HostPathIdentityBroker proof 未覆盖全部 Analyzer 现存路径。",
    );
  }

  const pathsByIdentity = new Map<string, AnalyzerHostPathCandidateState[]>();
  for (const candidate of candidatesByPath.values()) {
    const identity = identityByPath.get(candidate.logicalPath)!;
    const group = pathsByIdentity.get(identity) ?? [];
    group.push(candidate);
    pathsByIdentity.set(identity, group);
  }
  const canonicalByIdentity = new Map<string, string>();
  const roleRank: Readonly<Record<AnalyzerHostPathCandidateRole, number>> = {
    source: 0,
    configuration: 1,
    resolution: 2,
    blocked: 3,
    alias: 4,
  };
  for (const [identity, group] of pathsByIdentity) {
    const sourcePaths = group.filter((candidate) => candidate.role === "source");
    if (sourcePaths.length > 1) {
      throw new AnalyzerFailureError(
        "ANALYZER_CONFIG_INVALID",
        "同一宿主对象不能作为多个 manifest source 进入单次 Analyzer 请求。",
      );
    }
    const canonical = [...group].sort((left, right) =>
      roleRank[left.role] - roleRank[right.role] ||
      compareText(left.logicalPath, right.logicalPath))[0];
    if (canonical === undefined) {
      throw new AnalyzerFailureError(
        "ANALYZER_CONFIG_INVALID",
        "HostPathIdentityBroker proof 包含空对象分组。",
      );
    }
    canonicalByIdentity.set(identity, canonical.logicalPath);
  }
  return Object.freeze({
    entries: Object.freeze([...identityByPath]
      .sort(([left], [right]) => compareText(left, right))
      .map(([logicalPath, identity]) => Object.freeze({
        canonicalLogicalPath: canonicalByIdentity.get(identity)!,
        identity,
        logicalPath,
      }))),
    proofDigest: proof.proofDigest,
    snapshotIdentity: proof.snapshotIdentity,
    version: 1,
  });
}

/**
 * 安全读取根配置、manifest 与 lockfile；extends/references 由 Worker 公共 API 发现后回送。
 *
 * 不读取 rules.yaml，不枚举 workspace package，也不把物理绝对路径交给 Worker。
 */
export async function collectAnalyzerMetadataFiles(
  indexingRoot: string,
  signal?: AbortSignal,
  readMetadataFile: NonNullable<AnalyzerConfigCaptureDependencies["readMetadataFile"]> =
    readTrustedMetadataFile,
): Promise<readonly AnalyzerByteFileV1[]> {
  const queue = [...ANALYZER_ROOT_METADATA_PATHS];
  const seen = new Set<string>();
  const files: AnalyzerByteFileV1[] = [];
  let totalBytes = 0;
  while (queue.length > 0) {
    throwIfAborted(signal);
    const candidate = normalizeRelativeGraphPath(queue.shift()!);
    if (seen.has(candidate) || candidate.split("/").at(-1)?.toLowerCase() === "rules.yaml") {
      continue;
    }
    seen.add(candidate);
    const file = await readMetadataFile(indexingRoot, candidate, signal);
    if (file === null) {continue;}
    totalBytes += file.bytes.byteLength;
    if (totalBytes > MAX_ANALYZER_METADATA_TOTAL_BYTES) {
      throw new Error("Analyzer 配置元数据总字节数超过安全预算。");
    }
    files.push(file);
  }
  return Object.freeze(files.sort((left, right) => compareText(left.path, right.path)));
}

/** 使用只读身份前后复核读取单个配置元数据文件。 */
async function readTrustedMetadataFile(
  indexingRoot: string,
  logicalPath: string,
  signal?: AbortSignal,
): Promise<AnalyzerByteFileV1 | null> {
  const absolutePath = path.join(indexingRoot, ...logicalPath.split("/"));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    throwIfAborted(signal);
    const pathBefore = await lstat(absolutePath, { bigint: true });
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() ||
      pathBefore.size > BigInt(MAX_ANALYZER_METADATA_FILE_BYTES)) {
      throw new Error("Analyzer 配置元数据不是受支持的普通文件。");
    }
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!sameFileIdentity(pathBefore, before)) {
      throw new Error("Analyzer 配置元数据打开前身份发生变化。");
    }
    const resolved = await realpath(absolutePath);
    if (!isContainedPhysicalPath(indexingRoot, resolved)) {
      throw new Error("Analyzer 配置元数据真实路径逃逸 indexing root。");
    }
    const buffer = await readHandleBounded(
      handle,
      MAX_ANALYZER_METADATA_FILE_BYTES,
      signal,
    );
    throwIfAborted(signal);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absolutePath, { bigint: true });
    if (
      pathAfter.isSymbolicLink() || !sameFileIdentity(before, after) ||
      !sameFileIdentity(before, pathAfter) || buffer.byteLength !== Number(before.size)
    ) {
      throw new Error("Analyzer 配置元数据在读取期间发生变化。");
    }
    return Object.freeze({
      bytes: new Uint8Array(buffer),
      contentHash: createHash("sha256").update(buffer).digest("hex"),
      path: logicalPath,
    });
  } catch (error) {
    if (isMissingPathError(error)) {return null;}
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** 安全探测 manifest 外源码，只返回受界限保护的内容 hash，不向 Worker 交付源码字节。 */
async function probeTrustedBlockedResolutionFile(
  indexingRoot: string,
  logicalPath: string,
  remainingTotalBytes: number,
  remainingFileSlots: number,
  signal?: AbortSignal,
  inspectBlockedResolutionFile: NonNullable<
    AnalyzerConfigCaptureDependencies["inspectBlockedResolutionFile"]
  > = inspectTrustedBlockedResolutionFile,
): Promise<{ byteLength: number; contentHash: string; path: string } | null> {
  try {
    throwIfAborted(signal);
    const inspection = await inspectBlockedResolutionFile(indexingRoot, logicalPath, signal);
    if (inspection === null) {return null;}
    if (remainingFileSlots <= 0) {
      analyzerCaptureMetrics.blockedStatPreRejected += 1;
      throw new AnalyzerFailureError(
        "ANALYZER_RESOURCE_LIMIT",
        "Analyzer blocked 源码候选文件数超过安全预算。",
      );
    }
    if (inspection.byteLength > MAX_SOURCE_FILE_BYTES) {
      throw new AnalyzerFailureError(
        "ANALYZER_RESOURCE_LIMIT",
        "Analyzer blocked 源码候选超过单文件字节预算。",
      );
    }
    if (inspection.byteLength > Math.max(0, remainingTotalBytes)) {
      analyzerCaptureMetrics.blockedStatPreRejected += 1;
      throw new AnalyzerFailureError(
        "ANALYZER_RESOURCE_LIMIT",
        "Analyzer blocked 源码候选总字节数超过安全预算。",
      );
    }
    const hashed = await inspection.capture(signal);
    if (hashed.byteLength !== inspection.byteLength) {
      throw new Error("Analyzer blocked 源码候选在探测期间发生变化。");
    }
    return Object.freeze({
      byteLength: hashed.byteLength,
      contentHash: hashed.contentHash,
      path: logicalPath,
    });
  } catch (error) {
    if (isMissingPathError(error)) {return null;}
    throw error;
  }
}

/** 使用完整文件身份复核建立 blocked 源码的延迟流式捕获。 */
async function inspectTrustedBlockedResolutionFile(
  indexingRoot: string,
  logicalPath: string,
  signal?: AbortSignal,
): Promise<AnalyzerBlockedResolutionInspectionV1 | null> {
  const absolutePath = path.join(indexingRoot, ...logicalPath.split("/"));
  try {
    throwIfAborted(signal);
    const pathBefore = await lstat(absolutePath, { bigint: true });
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw new Error("Analyzer blocked 源码候选不是受支持的普通文件。");
    }
    return Object.freeze({
      byteLength: Number(pathBefore.size),
      capture: async (captureSignal?: AbortSignal) => {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          throwIfAborted(captureSignal);
          handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const before = await handle.stat({ bigint: true });
          if (!sameFileIdentity(pathBefore, before)) {
            throw new Error("Analyzer blocked 源码候选打开前身份发生变化。");
          }
          const resolved = await realpath(absolutePath);
          if (!isContainedPhysicalPath(indexingRoot, resolved)) {
            throw new Error("Analyzer blocked 源码候选真实路径逃逸 indexing root。");
          }
          const hashed = await hashAnalyzerSourceStreamBounded(async (chunk) => {
            const result = await handle!.read(chunk, 0, chunk.byteLength, null);
            return result.bytesRead;
          }, MAX_SOURCE_FILE_BYTES, captureSignal);
          const after = await handle.stat({ bigint: true });
          const pathAfter = await lstat(absolutePath, { bigint: true });
          if (
            pathAfter.isSymbolicLink() || !sameFileIdentity(before, after) ||
            !sameFileIdentity(before, pathAfter) || hashed.byteLength !== Number(before.size)
          ) {
            throw new Error("Analyzer blocked 源码候选在探测期间发生变化。");
          }
          return hashed;
        } finally {
          await handle?.close().catch(() => undefined);
        }
      },
    });
  } catch (error) {
    if (isMissingPathError(error)) {return null;}
    throw error;
  }
}

/** blocked 源码只保留流式 SHA-256 与字节数，固定单块内存且不执行 Buffer.concat。 */
export async function hashAnalyzerSourceStreamBounded(
  readChunk: (chunk: Buffer) => Promise<number>,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ byteLength: number; contentHash: string }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("Analyzer 流式 hash 预算必须是非负安全整数。");
  }
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(ANALYZER_BOUNDED_READ_CHUNK_BYTES);
  analyzerCaptureMetrics.blockedPeakBufferedBytes = Math.max(
    analyzerCaptureMetrics.blockedPeakBufferedBytes,
    chunk.byteLength,
  );
  let byteLength = 0;
  while (byteLength <= maximumBytes) {
    throwIfAborted(signal);
    const remainingWithSentinel = maximumBytes - byteLength + 1;
    const requestedChunk = chunk.subarray(0, Math.min(chunk.byteLength, remainingWithSentinel));
    const bytesRead = await readChunk(requestedChunk);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > requestedChunk.byteLength) {
      throw new AnalyzerFailureError(
        "ANALYZER_PROTOCOL_INVALID",
        "Analyzer 流式 hash 读取器返回了非法字节数。",
      );
    }
    if (bytesRead === 0) {break;}
    byteLength += bytesRead;
    if (byteLength > maximumBytes) {
      throw new AnalyzerFailureError(
        "ANALYZER_RESOURCE_LIMIT",
        "Analyzer blocked 源码候选在读取期间增长并超过预算。",
      );
    }
    hash.update(chunk.subarray(0, bytesRead));
    analyzerCaptureMetrics.blockedBytesHashed += bytesRead;
  }
  return { byteLength, contentHash: hash.digest("hex") };
}

/** 异步读取至 max+1 sentinel；命中首个超限字节后立即停止。 */
async function readHandleBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return readAnalyzerBytesBounded(async (chunk) => {
    const result = await handle.read(chunk, 0, chunk.byteLength, null);
    return result.bytesRead;
  }, maximumBytes, signal);
}

/**
 * 使用 max+1 sentinel 执行有界读取；导出只为量化测试同一生产读取核心。
 *
 * @param readChunk 每次最多填充传入缓冲区并返回实际字节数。
 * @param maximumBytes 允许读取的最大字节数。
 * @param signal 可选取消信号。
 */
export async function readAnalyzerBytesBounded(
  readChunk: (chunk: Buffer) => Promise<number>,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("Analyzer 有界读取预算必须是非负安全整数。");
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  while (byteLength <= maximumBytes) {
    throwIfAborted(signal);
    const remainingWithSentinel = maximumBytes - byteLength + 1;
    const chunk = Buffer.allocUnsafe(Math.min(
      ANALYZER_BOUNDED_READ_CHUNK_BYTES,
      remainingWithSentinel,
    ));
    const bytesRead = await readChunk(chunk);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > chunk.byteLength) {
      throw new AnalyzerFailureError(
        "ANALYZER_PROTOCOL_INVALID",
        "Analyzer 有界读取器返回了非法字节数。",
      );
    }
    if (bytesRead === 0) {break;}
    chunks.push(chunk.subarray(0, bytesRead));
    byteLength += bytesRead;
    if (byteLength > maximumBytes) {
      throw new AnalyzerFailureError(
        "ANALYZER_RESOURCE_LIMIT",
        "Analyzer 元数据在读取期间增长并超过单文件字节预算。",
      );
    }
  }
  return Buffer.concat(chunks, byteLength);
}

/** 同步准备阶段流式 hash，固定单块内存且不拼接完整 Analyzer 文件。 */
function hashDescriptorBoundedSync(
  descriptor: number,
  maximumBytes: number,
): { byteLength: number; contentHash: string } {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(ANALYZER_BOUNDED_READ_CHUNK_BYTES);
  let byteLength = 0;
  while (byteLength <= maximumBytes) {
    const remainingWithSentinel = maximumBytes - byteLength + 1;
    const bytesRead = readSync(
      descriptor,
      chunk,
      0,
      Math.min(chunk.byteLength, remainingWithSentinel),
      null,
    );
    if (bytesRead === 0) {break;}
    byteLength += bytesRead;
    if (byteLength > maximumBytes) {
      throw new RangeError("Analyzer COMMIT fence 元数据超过单文件字节预算。");
    }
    hash.update(chunk.subarray(0, bytesRead));
    analyzerCaptureMetrics.synchronousFenceBytesHashed += bytesRead;
  }
  return { byteLength, contentHash: hash.digest("hex") };
}

/** 由规范文件后缀确定 Analyzer 语言。 */
function languageFromPath(relativePath: string): AnalyzerSourceFileV1["language"] {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".tsx")) {return "typescriptreact";}
  if (lower.endsWith(".jsx")) {return "javascriptreact";}
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  return "typescript";
}

/** 根 tsconfig 优先于 jsconfig，且不允许 base/config 变体冒充权威入口。 */
function chooseAuthoritativeConfigurationEntries(
  files: readonly AnalyzerByteFileV1[],
): readonly string[] {
  const paths = new Set(files.map((file) => file.path));
  if (paths.has("tsconfig.json")) {return Object.freeze(["tsconfig.json"]);}
  if (paths.has("jsconfig.json")) {return Object.freeze(["jsconfig.json"]);}
  return Object.freeze([]);
}

/** 任意层级 node_modules 都属于外部解析元数据，不得按根目录特例判断。 */
function hasNodeModulesSegment(logicalPath: string, caseSensitiveFileNames: boolean): boolean {
  const boundaryKey = normalizeHostPathIdentity("node_modules", caseSensitiveFileNames);
  return logicalPath.split("/").some((segment) =>
    normalizeHostPathIdentity(segment, caseSensitiveFileNames) === boundaryKey);
}

/** realpath 必须仍位于 indexing root 内。 */
function isContainedPhysicalPath(indexingRoot: string, resolvedPath: string): boolean {
  const relative = path.relative(indexingRoot, resolvedPath);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 打开前、句柄读取前后与逻辑路径读取后必须绑定同一文件身份和元数据。 */
function sameFileIdentity(
  left: { ctimeNs: bigint; dev: bigint; ino: bigint; mtimeNs: bigint; size: bigint },
  right: { ctimeNs: bigint; dev: bigint; ino: bigint; mtimeNs: bigint; size: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** ENOENT 与祖先普通文件产生的 ENOTDIR 都表示该逻辑候选当前不存在。 */
function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR");
}

/** graph-service 组合根注入的既有宿主对象身份 broker 最小端口。 */
export interface AnalyzerHostPathIdentityBrokerPort {
  resolveCandidates(
    candidates: readonly HostPathIdentityCandidateV1[],
  ): Promise<HostPathCandidateResolutionV1>;
}

type AnalyzerHostPathCandidateRole =
  | "alias"
  | "blocked"
  | "configuration"
  | "resolution"
  | "source";

interface AnalyzerHostPathCandidateState extends HostPathIdentityCandidateV1 {
  role: AnalyzerHostPathCandidateRole;
}

/** 在每个异步边界传播 Job 取消。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    const error = new Error("Analyzer 配置采集已取消。");
    error.name = "AbortError";
    throw error;
  }
}

/** 配置集合使用 UTF-16 码元序。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
