import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";
import { createAnalyzerConfigSnapshot } from "../../packages/application/src/index.js";
import { createInitialIgnoreState } from "../../apps/graph-service/src/ignore-bootstrap.js";
import {
  readAnalyzerCaptureMetricsForTests,
  resetAnalyzerCaptureMetricsForTests,
} from "../../apps/graph-service/src/analyzer-config.js";
import {
  createNativeWorkspaceChangeMonitor,
  createIndexReadSetProvider,
  isPotentialSemanticWorkspaceEvent,
  WorkspaceIgnoreConfigChangedError,
} from "../../apps/graph-service/src/index-read-set.js";
import {
  scanWorkspace,
  verifyWorkspaceReadSetSync,
} from "../../apps/graph-service/src/workspace-scanner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建 read-set 测试根并登记清理。 */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-read-set-"));
  roots.push(root);
  return root;
}

/** 在测试中执行与 runtime 相同的事务外准备和事务内 fence 两阶段协议。 */
async function runPreparedCommitFence(
  provider: ReturnType<typeof createIndexReadSetProvider>,
  expected: Parameters<ReturnType<typeof createIndexReadSetProvider>["runCommitFence"]>[0],
  commitMutation: () => void,
): Promise<boolean> {
  const prepared = await provider.prepareCommitFence(expected);
  return prepared !== null && provider.runCommitFence(expected, prepared, commitMutation);
}

describe("index read-set provider", () => {
  it("keeps definite ignored and non-source changes out of the semantic watcher sequence", () => {
    expect(isPotentialSemanticWorkspaceEvent(".git/index", "change")).toBe(false);
    expect(isPotentialSemanticWorkspaceEvent("node_modules/pkg/index.js", "change")).toBe(false);
    expect(isPotentialSemanticWorkspaceEvent("README.md", "change", "file")).toBe(false);
    expect(isPotentialSemanticWorkspaceEvent("src", "change", "directory")).toBe(true);
    expect(isPotentialSemanticWorkspaceEvent("src/index.ts", "change")).toBe(true);
    expect(isPotentialSemanticWorkspaceEvent(".CodeGraphIgnore", "change")).toBe(true);
    expect(isPotentialSemanticWorkspaceEvent("dist/index.js", "rename")).toBe(true);
    expect(isPotentialSemanticWorkspaceEvent(undefined, "change")).toBe(true);
  });

  it("case-folds dynamic analyzer metadata paths on case-insensitive watchers", () => {
    const metadataPaths = new Set(["configs/base.json"]);

    expect(isPotentialSemanticWorkspaceEvent(
      "Configs/Base.json",
      "change",
      "file",
      metadataPaths,
      false,
    )).toBe(true);
    expect(isPotentialSemanticWorkspaceEvent(
      "Configs/Base.json",
      "change",
      "file",
      metadataPaths,
      true,
    )).toBe(false);
  });

  it("CR8-001 uses TypeScript host identity for non-ASCII watcher paths", () => {
    const metadataPaths = new Set([
      "configs/Σ.json",
      "configs/İ.json",
    ]);

    expect(isPotentialSemanticWorkspaceEvent(
      "CONFIGS/σ.JSON",
      "change",
      "file",
      metadataPaths,
      false,
    )).toBe(true);
    expect(isPotentialSemanticWorkspaceEvent(
      "configs/i\u0307.json",
      "change",
      "file",
      metadataPaths,
      false,
    )).toBe(false);
    expect(isPotentialSemanticWorkspaceEvent(
      "CONFIGS/σ.JSON",
      "change",
      "file",
      metadataPaths,
      true,
    )).toBe(false);
  });

  it("CR7-003 treats pnpm-workspace.yaml as a semantic watcher event and COMMIT-fenced root metadata", async () => {
    expect(isPotentialSemanticWorkspaceEvent(
      "pnpm-workspace.yaml",
      "change",
      "file",
    )).toBe(true);

    const root = await createRoot();
    const workspacePath = path.join(root, "pnpm-workspace.yaml");
    const original = "packages:\n  - packages/*\n";
    await writeFile(workspacePath, original);
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {throw new Error("测试前置条件不成立。");}
    const config = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [{
        contentHash: createHash("sha256").update(original).digest("hex"),
        path: "pnpm-workspace.yaml",
      }],
      effectiveCompilerOptions: {},
      effectiveIgnore: { effectiveDigest: ignoreState.snapshot.effectiveDigest, version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const provider = createIndexReadSetProvider({
      captureAnalyzerSemanticContext: async () => ({
        configDigest: config.configDigest,
        configSnapshot: config.snapshot,
        configurationEntryPaths: [],
        configurationFiles: [],
        inputDigest: "3".repeat(64),
        resolutionFiles: [],
        sourceFiles: [],
      }),
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-cr7-003",
    });
    const expected = await provider.capture(null);
    const commitMutation = vi.fn(() => {
      writeFileSync(workspacePath, "packages:\n  - modules/*\n", "utf8");
    });

    expect(await runPreparedCommitFence(provider, expected.readSet, commitMutation)).toBe(false);
    expect(commitMutation).toHaveBeenCalledTimes(1);
    provider.close?.();
  });

  it("CR6-003 case-folds consulted metadata in the main-thread classifier", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "Configs"), { recursive: true });
    await writeFile(path.join(root, "Configs", "Base.json"), "{}\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {throw new Error("测试前置条件不成立。");}
    const config = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [{
        contentHash: createHash("sha256").update("{}\n").digest("hex"),
        path: "configs/base.json",
      }],
      effectiveCompilerOptions: {},
      effectiveIgnore: { effectiveDigest: ignoreState.snapshot.effectiveDigest, version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    const onSemanticChange = vi.fn();
    const provider = createIndexReadSetProvider({
      caseSensitivePaths: false,
      captureAnalyzerSemanticContext: async () => ({
        caseSensitiveFileNames: false,
        configDigest: config.configDigest,
        configSnapshot: config.snapshot,
        configurationEntryPaths: [],
        configurationFiles: [],
        inputDigest: "3".repeat(64),
        resolutionFiles: [],
        sourceFiles: [],
      }),
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-cr6-003",
      watchWorkspaceChanges: true,
      workspaceChangeHandler: onSemanticChange,
    });
    const expected = await provider.capture(null);

    notifyWorkspaceChanged("Configs/Base.json", "change");

    expect(onSemanticChange).toHaveBeenCalledTimes(1);
    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    provider.close?.();
  });

  it("keeps native raw events separate from non-semantic README changes", async () => {
    const root = await createRoot();
    const readmePath = path.join(root, "README.md");
    await writeFile(readmePath, "before\n");
    const errors: unknown[] = [];
    const monitor = createNativeWorkspaceChangeMonitor(
      root,
      () => undefined,
      (error) => errors.push(error),
    );
    try {
      const rawBefore = monitor.readRawSequence?.() ?? 0n;
      const semanticBefore = monitor.readSequence?.() ?? 0n;
      await writeFile(readmePath, "after\n");
      await vi.waitFor(() => {
        expect(monitor.readRawSequence?.()).toBeGreaterThan(rawBefore);
      });

      expect(errors).toEqual([]);
      expect(monitor.readSequence?.()).toBe(semanticBefore);
    } finally {
      monitor.close();
    }
  });

  it("injects consulted and absent metadata paths into the native watcher semantic sequence", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "configs"), { recursive: true });
    const consultedPath = path.join(root, "configs", "base.json");
    const absentPath = path.join(root, "configs", "future.json");
    await writeFile(consultedPath, "{}\n");
    const errors: unknown[] = [];
    const monitor = createNativeWorkspaceChangeMonitor(
      root,
      () => undefined,
      (error) => errors.push(error),
    );
    try {
      await monitor.setAnalyzerMetadataPaths?.(["configs/base.json", "configs/future.json"]);
      const beforeConsulted = monitor.readSequence?.() ?? 0n;
      await writeFile(consultedPath, '{"strict":true}\n');
      await vi.waitFor(() => {
        expect(monitor.readSequence?.()).toBeGreaterThan(beforeConsulted);
      });

      const beforeAbsentCreation = monitor.readSequence?.() ?? 0n;
      await writeFile(absentPath, "{}\n");
      await vi.waitFor(() => {
        expect(monitor.readSequence?.()).toBeGreaterThan(beforeAbsentCreation);
      });
      expect(errors).toEqual([]);
    } finally {
      monitor.close();
    }
  });

  it("rejects a metadata ACK request when close wins the race", async () => {
    const root = await createRoot();
    const monitor = createNativeWorkspaceChangeMonitor(root, () => undefined, () => undefined);
    const pending = monitor.setAnalyzerMetadataPaths?.(["configs/pending.json"]);
    if (pending === undefined) {throw new Error("metadata watcher 测试接口缺失。");}
    monitor.close();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("removes metadata ACK listeners when the request signal aborts", async () => {
    const root = await createRoot();
    const monitor = createNativeWorkspaceChangeMonitor(root, () => undefined, () => undefined);
    const controller = new AbortController();
    const pending = monitor.setAnalyzerMetadataPaths?.(
      ["configs/aborted.json"],
      { signal: controller.signal, timeoutMs: 5_000 },
    );
    if (pending === undefined) {throw new Error("metadata watcher 测试接口缺失。");}
    controller.abort();
    try {
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      monitor.close();
    }
  });

  it("rejects arbitrary consulted metadata changed inside the final commit window", async () => {
    resetAnalyzerCaptureMetricsForTests();
    const root = await createRoot();
    await mkdir(path.join(root, "configs"), { recursive: true });
    const metadataPath = path.join(root, "configs", "base.json");
    const original = "{}\n";
    await writeFile(metadataPath, original);
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {throw new Error("测试前置条件不成立。");}
    const config = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [{
        contentHash: createHash("sha256").update(original).digest("hex"),
        path: "configs/base.json",
      }],
      effectiveCompilerOptions: {},
      effectiveIgnore: {
        effectiveDigest: ignoreState.snapshot.effectiveDigest,
        version: 1,
      },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const provider = createIndexReadSetProvider({
      captureAnalyzerSemanticContext: async () => ({
        configDigest: config.configDigest,
        configSnapshot: config.snapshot,
        configurationEntryPaths: [],
        configurationFiles: [],
        inputDigest: "1".repeat(64),
        resolutionFiles: [],
        sourceFiles: [],
      }),
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-arbitrary-metadata",
      watchWorkspaceChanges: true,
    });
    try {
      let expected = await provider.capture(null);
      let prepared = await provider.prepareCommitFence(expected.readSet);
      for (let attempt = 0; prepared === null && attempt < 4; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expected = await provider.capture(null);
        prepared = await provider.prepareCommitFence(expected.readSet);
      }
      if (prepared === null) {throw new Error("测试前置条件不成立。");}
      const hashedBeforeTransaction = readAnalyzerCaptureMetricsForTests()
        .synchronousFenceBytesHashed;
      const commitMutation = vi.fn(() => {
        writeFileSync(metadataPath, '{"strict":true}\n', "utf8");
      });

      expect(provider.runCommitFence(expected.readSet, prepared, commitMutation)).toBe(false);
      expect(commitMutation).toHaveBeenCalledTimes(1);
      expect(readAnalyzerCaptureMetricsForTests().synchronousFenceBytesHashed)
        .toBe(hashedBeforeTransaction);
    } finally {
      provider.close?.();
    }
  });

  it("separates semantic digests from generation and base revision fences", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set",
    });

    const first = await provider.capture(null);
    provider.advanceBootstrapGeneration();
    const second = await provider.capture(8);

    expect(second.readSet.bootstrapGeneration).toBe(1);
    expect(second.readSet.baseGraphRevision).toBe(8);
    expect(second.readSet.inputDigest).toBe(first.readSet.inputDigest);
    expect(second.readSet.configDigest).toBe(first.readSet.configDigest);
    expect(second.readSet.manifestDigest).toBe(first.readSet.manifestDigest);
    expect(await provider.isCurrent(first.readSet)).toBe(false);
    expect(await provider.isCurrent(second.readSet)).toBe(true);
  });

  it("detects same-path byte changes independently from manifest membership", async () => {
    const root = await createRoot();
    const file = path.join(root, "index.ts");
    await writeFile(file, "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-bytes",
    });
    const before = await provider.capture(null);

    await writeFile(file, "export const value = 2;\n");
    const after = await provider.capture(null);

    expect(after.readSet.manifest.map((entry) => entry.path)).toEqual(
      before.readSet.manifest.map((entry) => entry.path),
    );
    expect(after.readSet.manifest[0]?.contentHash).not.toBe(
      before.readSet.manifest[0]?.contentHash,
    );
    expect(await provider.isCurrent(before.readSet)).toBe(false);
  });

  it("synchronously rejects changed bytes and new source members at the commit fence", async () => {
    const root = await createRoot();
    const sourcePath = path.join(root, "index.ts");
    await writeFile(sourcePath, "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-commit-fence",
    });
    const expected = await provider.capture(null);

    const commitMutation = vi.fn();
    expect(await runPreparedCommitFence(provider, expected.readSet, commitMutation)).toBe(true);
    expect(commitMutation).toHaveBeenCalledTimes(1);
    await writeFile(sourcePath, "export const value = 2;\n");
    expect(await runPreparedCommitFence(provider, expected.readSet, commitMutation)).toBe(false);

    const changed = await provider.capture(null);
    await writeFile(path.join(root, "added.ts"), "export const added = true;\n");
    expect(await runPreparedCommitFence(provider, changed.readSet, commitMutation)).toBe(false);
  });

  it("rejects a native change sequence that advances during the post-mutation proof", async () => {
    const root = await createRoot();
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let sequence = 0n;
    const handledSequence = 0n;
    let verifyCalls = 0;
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: () => ({
        close: vi.fn(),
        readHandledSequence: () => handledSequence,
        readSequence: () => sequence,
      }),
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-native-sequence",
      verifyReadSetSync: () => {
        verifyCalls += 1;
        if (verifyCalls === 2) {
          sequence += 1n;
        }
        return true;
      },
      watchWorkspaceChanges: true,
    });
    const expected = await provider.capture(null);
    const commitMutation = vi.fn();
    const prepared = await provider.prepareCommitFence(expected.readSet);
    if (prepared === null) {
      throw new Error("测试前置条件不成立。");
    }

    expect(provider.runCommitFence(expected.readSet, prepared, commitMutation)).toBe(false);
    expect(commitMutation).toHaveBeenCalledTimes(1);
    expect(verifyCalls).toBe(2);
    provider.close?.();
  });

  it("keeps native watcher sequences monotonic beyond the 32-bit range", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const largeSequence = 2n ** 40n;
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: () => ({
        close: vi.fn(),
        readHandledSequence: () => largeSequence,
        readSequence: () => largeSequence,
      }),
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-bigint-sequence",
      watchWorkspaceChanges: true,
    });
    const expected = await provider.capture(null);
    const commitMutation = vi.fn();

    expect(await runPreparedCommitFence(provider, expected.readSet, commitMutation)).toBe(true);
    expect(commitMutation).toHaveBeenCalledTimes(1);
    provider.close?.();
  });

  it("rejects a startup fence while a semantic watcher event is still pending", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: () => ({
        close: vi.fn(),
        readHandledSequence: () => 0n,
        readSequence: () => 1n,
      }),
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-pending-startup-event",
      watchWorkspaceChanges: true,
    });
    const expected = await provider.capture(null);

    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    provider.close?.();
  });

  it("fails closed when shared watcher health becomes fatal after fence preparation", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let fatal = false;
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: () => ({
        close: vi.fn(),
        readHandledSequence: () => 0n,
        readSequence: () => {
          if (fatal) {
            throw new Error("shared watcher fatal");
          }
          return 0n;
        },
      }),
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-shared-fatal",
      watchWorkspaceChanges: true,
    });
    const expected = await provider.capture(null);
    const prepared = await provider.prepareCommitFence(expected.readSet);
    if (prepared === null) {
      throw new Error("测试前置条件不成立。");
    }
    fatal = true;
    const commitMutation = vi.fn();

    expect(provider.runCommitFence(expected.readSet, prepared, commitMutation)).toBe(false);
    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    expect(commitMutation).not.toHaveBeenCalled();
    provider.close?.();
  });

  it("rechecks .codegraphignore after the post-mutation workspace traversal", async () => {
    const root = await createRoot();
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let verifyCalls = 0;
    const forceContentHashCalls: boolean[] = [];
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-post-ignore",
      verifyReadSetSync: (_expected, _proof, forceContentHash) => {
        verifyCalls += 1;
        forceContentHashCalls.push(forceContentHash === true);
        if (verifyCalls === 2) {
          writeFileSync(path.join(root, ".codegraphignore"), "dist/**\n", "utf8");
        }
        return true;
      },
    });
    const expected = await provider.capture(null);
    const commitMutation = vi.fn();
    const prepared = await provider.prepareCommitFence(expected.readSet);
    if (prepared === null) {
      throw new Error("测试前置条件不成立。");
    }

    expect(() => provider.runCommitFence(expected.readSet, prepared, commitMutation)).toThrow(
      WorkspaceIgnoreConfigChangedError,
    );
    expect(commitMutation).toHaveBeenCalledTimes(1);
    expect(forceContentHashCalls).toEqual([true, true]);
  });

  it("forces content verification when the commit fence has no independent watcher", async () => {
    const root = await createRoot();
    const sourcePath = path.join(root, "index.ts");
    await writeFile(sourcePath, "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const before = await scanWorkspace({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
    });
    await writeFile(sourcePath, "export const value = 2;\n");
    const live = await scanWorkspace({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
    });
    if (live.verificationProof === undefined) {
      throw new Error("生产扫描必须生成同步复核证明。");
    }
    const forgedCurrentMetadata = {
      ...live.verificationProof,
      manifestDigest: before.manifestDigest,
    };

    expect(verifyWorkspaceReadSetSync({
      expectedManifest: before.manifest,
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      verificationProof: forgedCurrentMetadata,
    })).toBe(true);
    expect(verifyWorkspaceReadSetSync({
      expectedManifest: before.manifest,
      forceContentHash: true,
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      verificationProof: forgedCurrentMetadata,
    })).toBe(false);

    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      scan: async () => ({
        ...before,
        verificationProof: forgedCurrentMetadata,
      }),
      statusEpoch: "epoch-read-set-force-content-hash",
    });
    const expected = await provider.capture(null);
    const prepared = await provider.prepareCommitFence(expected.readSet);
    if (prepared === null) {
      throw new Error("测试前置条件不成立。");
    }
    const commitMutation = vi.fn();

    expect(provider.runCommitFence(expected.readSet, prepared, commitMutation)).toBe(false);
    expect(commitMutation).not.toHaveBeenCalled();
    provider.close?.();
  });

  it("rejects equal content manifests whose consecutive collects have different version proofs", async () => {
    const root = await createRoot();
    const sourcePath = path.join(root, "index.ts");
    const original = "export const value = 1;\n";
    await writeFile(sourcePath, original);
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let scanCalls = 0;
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      scan: async (options) => {
        scanCalls += 1;
        const result = await scanWorkspace(options);
        if (scanCalls === 2) {
          await writeFile(sourcePath, "export const value = 200;\n");
          await writeFile(sourcePath, original);
        }
        return result;
      },
      statusEpoch: "epoch-read-set-versioned-double-collect",
    });
    const expected = await provider.capture(null);

    await expect(provider.prepareCommitFence(expected.readSet)).resolves.toBeNull();
    expect(scanCalls).toBe(3);
  });

  it("fails closed when the watched indexing root is replaced", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-root-replaced",
      watchWorkspaceChanges: true,
    });
    const expected = await provider.capture(null);
    const originalRoot = `${root}-original`;
    await rename(root, originalRoot);
    roots.push(originalRoot);
    await mkdir(root);
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");

    await expect(provider.prepareCommitFence(expected.readSet)).resolves.toBeNull();
    await expect(provider.capture(null)).rejects.toMatchObject({ code: "GRAPH_SCAN_FAILED" });
    provider.close?.();
  });

  it("rejects a generation change that occurs during the final verification scan", async () => {
    const root = await createRoot();
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const manifest = [{ contentHash: "1".repeat(64), path: "index.ts" }];
    const scanResult = {
      candidateFiles: ["index.ts"],
      coverage: "complete" as const,
      excludedPathCount: 0,
      manifest,
      manifestDigest: sha256CanonicalJson(manifest),
    };
    let scanCalls = 0;
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      scan: async () => {
        scanCalls += 1;
        if (scanCalls === 2) {
          await verificationGate;
        }
        return scanResult;
      },
      statusEpoch: "epoch-read-set-generation-race",
    });
    const expected = await provider.capture(null);
    const verification = provider.isCurrent(expected.readSet);
    await vi.waitFor(() => expect(scanCalls).toBe(2));
    provider.advanceBootstrapGeneration();
    releaseVerification();

    await expect(verification).resolves.toBe(false);
  });

  it("rejects a watched workspace change after the final scan has hashed an earlier file", async () => {
    const root = await createRoot();
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const manifest = [
      { contentHash: "1".repeat(64), path: "a.ts" },
      { contentHash: "2".repeat(64), path: "b.ts" },
    ];
    const scanResult = {
      candidateFiles: manifest.map((entry) => entry.path),
      coverage: "complete" as const,
      excludedPathCount: 0,
      manifest,
      manifestDigest: sha256CanonicalJson(manifest),
    };
    const changedManifest = [
      { contentHash: "3".repeat(64), path: "a.ts" },
      { contentHash: "2".repeat(64), path: "b.ts" },
    ];
    const changedScanResult = {
      ...scanResult,
      manifest: changedManifest,
      manifestDigest: sha256CanonicalJson(changedManifest),
    };
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    let releaseVerification!: () => void;
    let scanCalls = 0;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      scan: async () => {
        scanCalls += 1;
        if (scanCalls === 2) {
          await verificationGate;
        }
        return scanCalls >= 3 ? changedScanResult : scanResult;
      },
      statusEpoch: "epoch-read-set-watched-prefix-race",
      watchWorkspaceChanges: true,
    });
    const expected = await provider.capture(null);
    const verification = provider.isCurrent(expected.readSet);
    await vi.waitFor(() => expect(scanCalls).toBe(2));

    // 模拟 a.ts 已完成 hash、b.ts 尚未结束时发生的潜在语义文件事件。
    notifyWorkspaceChanged("b.ts", "rename");
    releaseVerification();

    await expect(verification).resolves.toBe(false);
    provider.close?.();
  });

  it("filters only definitive non-semantic changes and fails closed for ambiguous rename", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "README.md"), "documentation\n");
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "index"), "ignored\n");
    await mkdir(path.join(root, "node_modules", "ignored-package"), { recursive: true });
    await writeFile(
      path.join(root, "node_modules", "ignored-package", "index.js"),
      "export const ignored = true;\n",
    );
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const manifest = [{ contentHash: "1".repeat(64), path: "index.ts" }];
    const scanResult = {
      candidateFiles: ["index.ts"],
      coverage: "complete" as const,
      excludedPathCount: 0,
      manifest,
      manifestDigest: sha256CanonicalJson(manifest),
    };
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    let scanCalls = 0;
    const onSemanticChange = vi.fn();
    const verifyReadSetSync = vi.fn(() => true);
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      scan: async () => {
        scanCalls += 1;
        return scanResult;
      },
      statusEpoch: "epoch-read-set-ignored-watch-event",
      verifyReadSetSync,
      watchWorkspaceChanges: true,
      workspaceChangeHandler: onSemanticChange,
    });
    const expected = await provider.capture(null);
    await expect(provider.isCurrent(expected.readSet)).resolves.toBe(true);

    notifyWorkspaceChanged(".git/index", "change");
    notifyWorkspaceChanged("README.md", "change");
    notifyWorkspaceChanged("node_modules/ignored-package/index.js", "rename");

    expect(scanCalls).toBe(2);
    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    expect(onSemanticChange).not.toHaveBeenCalled();
    await provider.awaitPendingRenameVerification?.();
    expect(scanCalls).toBe(3);
    expect(verifyReadSetSync).not.toHaveBeenCalled();
    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(true);

    // 旧路径消失的 rename 可能跨越 ignored/included 边界，不能仅凭旧名忽略。
    await rm(path.join(root, ".git", "index"));
    notifyWorkspaceChanged(".git/index", "rename");
    notifyWorkspaceChanged(".git/index", "rename");
    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    // 同一 stale epoch 只发布一次状态变更，避免事件风暴制造重复 SQLite 写入。
    expect(onSemanticChange).toHaveBeenCalledTimes(1);
    provider.close?.();
  });

  it("invalidates when the only rename event reports an existing ignored destination", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    const onSemanticChange = vi.fn();
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-included-to-ignored",
      watchWorkspaceChanges: true,
      workspaceChangeHandler: onSemanticChange,
    });
    const expected = await provider.capture(null);

    await rename(path.join(root, "index.ts"), path.join(root, "node_modules", "index.ts"));
    notifyWorkspaceChanged("node_modules/index.ts", "rename");

    await vi.waitFor(() => expect(onSemanticChange).toHaveBeenCalledTimes(1));
    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    provider.close?.();
  });

  it("detects a source rewrite while an ignored rename is being disambiguated", async () => {
    const root = await createRoot();
    const sourcePath = path.join(root, "index.ts");
    await writeFile(sourcePath, "export const value = 1;\n");
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    const onSemanticChange = vi.fn();
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-ignored-rename-source-rewrite",
      watchWorkspaceChanges: true,
      workspaceChangeHandler: onSemanticChange,
    });
    const expected = await provider.capture(null);

    await writeFile(sourcePath, "export const value = 2;\n");
    notifyWorkspaceChanged("node_modules/ignored.js", "rename");
    await provider.awaitPendingRenameVerification?.();

    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    expect(onSemanticChange).toHaveBeenCalledTimes(1);
    provider.close?.();
  });

  it("aborts an in-flight ignored rename scan when the provider closes", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const baseline = await scanWorkspace({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
    });
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    let scanCalls = 0;
    let abortObserved = false;
    let markScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      scan: async (options) => {
        scanCalls += 1;
        if (scanCalls === 1) {
          return baseline;
        }
        return new Promise<never>((_resolve, reject) => {
          const rejectCancelled = (): void => {
            abortObserved = true;
            reject(new Error("rename verification cancelled"));
          };
          markScanStarted();
          if (options.signal?.aborted === true) {
            rejectCancelled();
            return;
          }
          options.signal?.addEventListener("abort", rejectCancelled, { once: true });
        });
      },
      statusEpoch: "epoch-read-set-rename-close-abort",
      watchWorkspaceChanges: true,
    });
    const expected = await provider.capture(null);
    notifyWorkspaceChanged("node_modules/ignored.js", "rename");
    await scanStarted;

    const pending = provider.awaitPendingRenameVerification?.() ?? Promise.resolve();
    provider.close?.();
    await pending;

    expect(abortObserved).toBe(true);
    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
  });

  it("aborts and invalidates when a second ambiguous rename overtakes the scan", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const baseline = await scanWorkspace({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
    });
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    let scanCalls = 0;
    let abortObserved = false;
    let markScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    const onSemanticChange = vi.fn();
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      scan: async (options) => {
        scanCalls += 1;
        if (scanCalls === 1) {
          return baseline;
        }
        return new Promise<never>((_resolve, reject) => {
          const rejectCancelled = (): void => {
            abortObserved = true;
            reject(new Error("rename verification superseded"));
          };
          markScanStarted();
          if (options.signal?.aborted === true) {
            rejectCancelled();
            return;
          }
          options.signal?.addEventListener("abort", rejectCancelled, { once: true });
        });
      },
      statusEpoch: "epoch-read-set-rename-superseded",
      watchWorkspaceChanges: true,
      workspaceChangeHandler: onSemanticChange,
    });
    const expected = await provider.capture(null);
    notifyWorkspaceChanged("node_modules/ignored.js", "rename");
    await scanStarted;

    const pending = provider.awaitPendingRenameVerification?.() ?? Promise.resolve();
    notifyWorkspaceChanged("node_modules/ignored.js", "rename");
    await pending;

    expect(abortObserved).toBe(true);
    expect(onSemanticChange).toHaveBeenCalledTimes(1);
    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    provider.close?.();
  });

  it("keeps the current proof when an ignored directory is created after capture", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    const onSemanticChange = vi.fn();
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-ignored-create",
      watchWorkspaceChanges: true,
      workspaceChangeHandler: onSemanticChange,
    });
    const expected = await provider.capture(null);

    await mkdir(path.join(root, "node_modules", "ignored-package"), { recursive: true });
    await writeFile(
      path.join(root, "node_modules", "ignored-package", "index.js"),
      "export const ignored = true;\n",
    );
    notifyWorkspaceChanged("node_modules", "rename");
    await provider.awaitPendingRenameVerification?.();

    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(true);
    expect(onSemanticChange).not.toHaveBeenCalled();
    provider.close?.();
  });

  it("fails closed when the root ignore configuration changes after startup", async () => {
    const root = await createRoot();
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    const onSemanticChange = vi.fn();
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-ignore-change",
      watchWorkspaceChanges: true,
      workspaceChangeHandler: onSemanticChange,
    });
    const expected = await provider.capture(null);

    notifyWorkspaceChanged(".CodeGraphIgnore", "rename");

    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    expect(onSemanticChange).toHaveBeenCalledTimes(1);
    await expect(provider.capture(null)).rejects.toBeInstanceOf(
      WorkspaceIgnoreConfigChangedError,
    );
    provider.close?.();
  });

  it("allows a new capture after a changed path disappears before classification", async () => {
    const root = await createRoot();
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_indexingRoot, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-disappeared-change",
      watchWorkspaceChanges: true,
    });
    const expected = await provider.capture(null);

    notifyWorkspaceChanged("deleted.ts", "change");

    expect(provider.isFenceCurrent?.(expected.readSet)).toBe(false);
    await expect(provider.capture(null)).resolves.toBeDefined();
    provider.close?.();
  });

  it("rejects an ignore snapshot mutation that occurs during the final verification scan", async () => {
    const root = await createRoot();
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const mutableSnapshot = {
      ...ignoreState.snapshot,
      effectiveRules: [...ignoreState.snapshot.effectiveRules],
      userRules: [...ignoreState.snapshot.userRules],
    } as never;
    const manifest = [{ contentHash: "1".repeat(64), path: "index.ts" }];
    const scanResult = {
      candidateFiles: ["index.ts"],
      coverage: "complete" as const,
      excludedPathCount: 0,
      manifest,
      manifestDigest: sha256CanonicalJson(manifest),
    };
    let scanCalls = 0;
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: mutableSnapshot,
      indexingRoot: root,
      scan: async () => {
        scanCalls += 1;
        if (scanCalls === 2) {
          await verificationGate;
        }
        return scanResult;
      },
      statusEpoch: "epoch-read-set-ignore-race",
    });
    const expected = await provider.capture(null);
    const verification = provider.isCurrent(expected.readSet);
    await vi.waitFor(() => expect(scanCalls).toBe(2));
    (mutableSnapshot as { effectiveRules: string[] }).effectiveRules = ["/changed/"];
    releaseVerification();

    await expect(verification).resolves.toBe(false);
  });

  it("detects manifest additions and removals with real workspace files", async () => {
    const root = await createRoot();
    const firstFile = path.join(root, "a.ts");
    const secondFile = path.join(root, "b.ts");
    await writeFile(firstFile, "export const a = 1;\n");
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      statusEpoch: "epoch-read-set-membership",
    });
    const before = await provider.capture(null);

    await writeFile(secondFile, "export const b = 1;\n");
    expect(await provider.isCurrent(before.readSet)).toBe(false);
    const withAddition = await provider.capture(null);
    await rm(firstFile);
    expect(await provider.isCurrent(withAddition.readSet)).toBe(false);
  });

  it("compares every field of the effective ignore snapshot", async () => {
    const root = await createRoot();
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const manifest = [{ contentHash: "1".repeat(64), path: "index.ts" }];
    const scanResult = {
      candidateFiles: ["index.ts"],
      coverage: "complete" as const,
      excludedPathCount: 0,
      manifest,
      manifestDigest: sha256CanonicalJson(manifest),
    };
    const mutations: Array<(snapshot: Record<string, unknown>) => void> = [
      (snapshot) => { snapshot.builtinRulesVersion = "builtin-ignore-v2"; },
      (snapshot) => { snapshot.contentHash = "2".repeat(64); },
      (snapshot) => { snapshot.effectiveDigest = "3".repeat(64); },
      (snapshot) => { snapshot.effectiveRules = ["/.git/", "/dist/"]; },
      (snapshot) => { snapshot.generation = 1; },
      (snapshot) => { snapshot.lastValidDigest = "4".repeat(64); },
      (snapshot) => { snapshot.userRules = ["/generated/"]; },
      (snapshot) => { snapshot.validity = "invalid"; },
      (snapshot) => { snapshot.version = 2; },
    ];

    for (const mutate of mutations) {
      const snapshot = {
        ...ignoreState.snapshot,
        effectiveRules: [...ignoreState.snapshot.effectiveRules],
        userRules: [...ignoreState.snapshot.userRules],
      } as unknown as Record<string, unknown>;
      const provider = createIndexReadSetProvider({
        ignoreSnapshot: snapshot as never,
        indexingRoot: root,
        scan: async () => scanResult,
        statusEpoch: "epoch-read-set-ignore-fields",
      });
      const before = await provider.capture(null);
      mutate(snapshot);
      expect(await provider.isCurrent(before.readSet)).toBe(false);
    }
  });
});
