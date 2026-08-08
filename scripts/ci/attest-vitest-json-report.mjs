import path from "node:path";
import { fileURLToPath } from "node:url";

/** JSON reporter 的 stdout 最多保留 4 MiB，避免异常测试无限占用内存。 */
export const VITEST_JSON_REPORT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 解析并交叉证明 Vitest JSON reporter、固定 suite 权威与逐 assertion 明细。
 *
 * @param {string | Buffer | Uint8Array} output Vitest reporter stdout。
 * @param {{attestationVersion:number,expectedSuiteCount:number,expectedTestCount:number,expectedTestResults:readonly {filePath:string,suites:readonly {ancestorTitles:readonly string[],expectedAssertionCount:number}[]}[],shardId:string}} authority 项目内固定且版本化的 shard 权威。
 * @param {{repositoryRoot?:string}} [options] reporter 文件名的可信仓库根。
 * @returns {{failed:number,passed:number,pending:number,skipped:number,suites:number,testResults:number,todo:number,total:number}}
 * @throws {Error} 权威、reporter schema、suite 拓扑、计数闭合或测试终态不一致时 fail-closed。
 */
export function attestVitestJsonReport(output, authority, options = {}) {
  const normalizedAuthority = validateAuthority(authority);
  const shardId = normalizedAuthority.shardId;
  const outputBuffer = toOutputBuffer(output, shardId);
  if (outputBuffer.byteLength > VITEST_JSON_REPORT_MAX_BYTES) {
    throw createAttestationError(
      shardId,
      "VITEST_REPORT_OVERSIZED",
      `reporter 输出超过 ${VITEST_JSON_REPORT_MAX_BYTES} bytes。`,
    );
  }
  if (outputBuffer.byteLength === 0 || outputBuffer.toString("utf8").trim().length === 0) {
    throw createAttestationError(shardId, "VITEST_REPORT_EMPTY", "reporter 未输出 JSON。");
  }

  let report;
  try {
    report = JSON.parse(outputBuffer.toString("utf8"));
  } catch {
    throw createAttestationError(shardId, "VITEST_REPORT_MALFORMED", "reporter 输出不是单个有效 JSON 文档。");
  }
  if (!isRecord(report) || report.success !== true && report.success !== false) {
    throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "reporter 根对象或 success 字段无效。");
  }

  const rootCounts = {
    failed: readReportCount(report, "numFailedTests", shardId),
    passed: readReportCount(report, "numPassedTests", shardId),
    pending: readReportCount(report, "numPendingTests", shardId),
    todo: readReportCount(report, "numTodoTests", shardId),
    total: readReportCount(report, "numTotalTests", shardId),
  };
  const suiteCounts = {
    failed: readReportCount(report, "numFailedTestSuites", shardId),
    passed: readReportCount(report, "numPassedTestSuites", shardId),
    pending: readReportCount(report, "numPendingTestSuites", shardId),
  };
  const reportedSuiteTotal = report.numTotalTestSuites === undefined
    ? suiteCounts.passed + suiteCounts.failed + suiteCounts.pending
    : readReportCount(report, "numTotalTestSuites", shardId);
  if (rootCounts.passed + rootCounts.failed + rootCounts.pending + rootCounts.todo !== rootCounts.total
    || suiteCounts.passed + suiteCounts.failed + suiteCounts.pending !== reportedSuiteTotal) {
    throw createAttestationError(shardId, "VITEST_REPORT_INCOMPLETE", "reporter 汇总计数无法闭合。");
  }
  if (rootCounts.total !== normalizedAuthority.expectedTestCount) {
    throw createAttestationError(
      shardId,
      "VITEST_COUNT_MISMATCH",
      `expected=${normalizedAuthority.expectedTestCount} actual=${rootCounts.total}。`,
    );
  }
  if (reportedSuiteTotal !== normalizedAuthority.expectedSuiteCount) {
    throw createAttestationError(
      shardId,
      "VITEST_SUITE_COUNT_MISMATCH",
      `expected=${normalizedAuthority.expectedSuiteCount} actual=${reportedSuiteTotal}。`,
    );
  }
  if (rootCounts.failed > 0) {
    throw createAttestationError(shardId, "VITEST_FAILED", `failed=${rootCounts.failed}。`);
  }
  if (rootCounts.pending > 0 || rootCounts.todo > 0) {
    throw createAttestationError(
      shardId,
      "VITEST_NONPASSING",
      `pendingOrSkipped=${rootCounts.pending} todo=${rootCounts.todo}。`,
    );
  }
  if (!Array.isArray(report.testResults)) {
    throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "testResults 必须是数组。");
  }
  if (report.testResults.length !== normalizedAuthority.expectedTestResults.length) {
    throw createAttestationError(
      shardId,
      "VITEST_TEST_RESULT_COUNT_MISMATCH",
      `expected=${normalizedAuthority.expectedTestResults.length} actual=${report.testResults.length}。`,
    );
  }

  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const expectedResults = new Map(
    normalizedAuthority.expectedTestResults.map((result) => [result.filePath, result]),
  );
  const observedFiles = new Set();
  const observedSuitePrefixes = new Set();
  const derivedCounts = {
    failed: 0,
    passed: 0,
    pending: 0,
    skipped: 0,
    todo: 0,
    total: 0,
  };
  for (const testResult of report.testResults) {
    if (!isRecord(testResult) || typeof testResult.name !== "string"
      || typeof testResult.status !== "string" || !Array.isArray(testResult.assertionResults)) {
      throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "testResults 项必须包含 name、status 与 assertionResults。");
    }
    const filePath = normalizeReporterFilePath(testResult.name, repositoryRoot, shardId);
    if (observedFiles.has(filePath)) {
      throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", `重复 testResult ${filePath}。`);
    }
    observedFiles.add(filePath);
    const expectedResult = expectedResults.get(filePath);
    if (expectedResult === undefined) {
      throw createAttestationError(shardId, "VITEST_TEST_RESULT_MISMATCH", `未授权 testResult ${filePath}。`);
    }

    const observedSuiteAssertions = new Map();
    for (const assertion of testResult.assertionResults) {
      if (!isRecord(assertion) || typeof assertion.status !== "string"
        || !Array.isArray(assertion.ancestorTitles)
        || assertion.ancestorTitles.some((title) => typeof title !== "string")) {
        throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "assertion status 或 ancestorTitles 字段无效。");
      }
      derivedCounts.total += 1;
      incrementAssertionStatus(derivedCounts, assertion.status, shardId);
      const suiteKey = JSON.stringify(assertion.ancestorTitles);
      observedSuiteAssertions.set(suiteKey, (observedSuiteAssertions.get(suiteKey) ?? 0) + 1);
      for (let index = 1; index <= assertion.ancestorTitles.length; index += 1) {
        observedSuitePrefixes.add(`${filePath}\0${JSON.stringify(assertion.ancestorTitles.slice(0, index))}`);
      }
    }
    assertSuiteAssertionDistribution(
      shardId,
      filePath,
      observedSuiteAssertions,
      expectedResult.suites,
    );
    if (testResult.status !== "passed") {
      throw createAttestationError(shardId, "VITEST_NONPASSING", `testResult ${filePath} status=${testResult.status}。`);
    }
  }

  for (const expectedFile of expectedResults.keys()) {
    if (!observedFiles.has(expectedFile)) {
      throw createAttestationError(shardId, "VITEST_TEST_RESULT_MISMATCH", `缺少 testResult ${expectedFile}。`);
    }
  }
  const derivedSuiteCount = report.testResults.length + observedSuitePrefixes.size;
  if (derivedSuiteCount !== reportedSuiteTotal) {
    throw createAttestationError(
      shardId,
      "VITEST_SUITE_SUMMARY_MISMATCH",
      `derived=${derivedSuiteCount} reported=${reportedSuiteTotal}。`,
    );
  }
  if (derivedCounts.total !== rootCounts.total
    || derivedCounts.passed !== rootCounts.passed
    || derivedCounts.failed !== rootCounts.failed
    || derivedCounts.pending + derivedCounts.skipped !== rootCounts.pending
    || derivedCounts.todo !== rootCounts.todo) {
    throw createAttestationError(shardId, "VITEST_REPORT_INCOMPLETE", "逐项状态与 reporter 汇总不一致。");
  }
  if (!report.success || rootCounts.passed !== rootCounts.total
    || suiteCounts.failed > 0 || suiteCounts.pending > 0
    || suiteCounts.passed !== reportedSuiteTotal) {
    throw createAttestationError(shardId, "VITEST_REPORT_INCOMPLETE", "成功标记、suite 与测试汇总不一致。");
  }

  return Object.freeze({
    ...derivedCounts,
    suites: derivedSuiteCount,
    testResults: report.testResults.length,
  });
}

/**
 * 将 PF-A runner 结果收敛为稳定失败代码，禁止 timeout、未排空流或 residual 伪装成功。
 *
 * @param {object} result PF-A runner 结果。
 * @param {string} prefix 稳定错误代码前缀。
 * @returns {string | null} null 表示有界成功。
 */
export function getBoundedProcessFailureCode(result, prefix) {
  const stableCode = result?.termination?.kind === "spawn-error"
    ? result.termination.stableCode
    : null;
  if (
    [
      "EPROCESSCLEANUP",
      "EPROCESSCLEANUPTIMEOUT",
      "EPROCESSCONTAINMENTUNAVAILABLE",
      "EPROCESSIDENTITYAMBIGUOUS",
      "EPIPEOPEN",
    ].includes(stableCode)
    || result?.cleanupComplete !== true
    || result?.streamsDrained !== true
    || result?.residualProcessTree !== 0
  ) {
    return `${prefix}_CLEANUP_UNPROVEN`;
  }
  if (stableCode === "ETIMEDOUT" || result?.timedOut === true) {
    return `${prefix}_TIMEOUT`;
  }
  if (result?.status !== "pass") {
    return result?.termination?.kind === "signal"
      ? `${prefix}_ABNORMAL_TERMINATION`
      : `${prefix}_EXIT_NONZERO`;
  }
  if (result?.termination?.kind !== "exit" || result.termination.code !== 0) {
    return `${prefix}_EXIT_NONZERO`;
  }
  return null;
}

/** PF-A runner 未形成有界成功终态时抛出不含本机路径的稳定错误。 */
export function assertBoundedProcessSuccess(result, contextId, prefix) {
  const failure = getBoundedProcessFailureCode(result, prefix);
  if (failure !== null) {
    throw createAttestationError(contextId, failure, "子进程未形成可证明的有界成功终态。");
  }
}

/** 校验并规范化项目内固定 authority，禁止 reporter 输出参与自授权。 */
function validateAuthority(authority) {
  const shardId = typeof authority?.shardId === "string" && authority.shardId.length > 0
    ? authority.shardId
    : "unknown-shard";
  if (!Number.isSafeInteger(authority?.attestationVersion) || authority.attestationVersion <= 0
    || !Number.isSafeInteger(authority?.expectedTestCount) || authority.expectedTestCount < 0
    || !Number.isSafeInteger(authority?.expectedSuiteCount) || authority.expectedSuiteCount < 0
    || !Array.isArray(authority?.expectedTestResults)) {
    throw createAttestationError(shardId, "VITEST_AUTHORITY_INVALID", "版本、test/suite 计数或 testResults 权威无效。");
  }
  const normalizedResults = authority.expectedTestResults.map((result) => {
    if (!isRecord(result) || !Array.isArray(result.suites)) {
      throw createAttestationError(shardId, "VITEST_AUTHORITY_INVALID", "expectedTestResults 项无效。");
    }
    const filePath = normalizeExpectedFilePath(result.filePath, shardId);
    const suites = result.suites.map((suite) => {
      if (!isRecord(suite) || !Array.isArray(suite.ancestorTitles)
        || suite.ancestorTitles.some((title) => typeof title !== "string")
        || !Number.isSafeInteger(suite.expectedAssertionCount)
        || suite.expectedAssertionCount < 0) {
        throw createAttestationError(shardId, "VITEST_AUTHORITY_INVALID", `suite 权威无效：${filePath}。`);
      }
      return Object.freeze({
        ancestorTitles: Object.freeze([...suite.ancestorTitles]),
        expectedAssertionCount: suite.expectedAssertionCount,
      });
    });
    return Object.freeze({ filePath, suites: Object.freeze(suites) });
  });
  const filePaths = normalizedResults.map(({ filePath }) => filePath);
  if (new Set(filePaths).size !== filePaths.length) {
    throw createAttestationError(shardId, "VITEST_AUTHORITY_INVALID", "testResult 文件权威重复。");
  }
  const expectedAssertionTotal = normalizedResults.reduce(
    (total, result) => total + result.suites.reduce(
      (suiteTotal, suite) => suiteTotal + suite.expectedAssertionCount,
      0,
    ),
    0,
  );
  const expectedSuitePrefixes = new Set();
  for (const result of normalizedResults) {
    const suiteKeys = new Set();
    for (const suite of result.suites) {
      const suiteKey = JSON.stringify(suite.ancestorTitles);
      if (suiteKeys.has(suiteKey)) {
        throw createAttestationError(shardId, "VITEST_AUTHORITY_INVALID", `suite 权威重复：${result.filePath}。`);
      }
      suiteKeys.add(suiteKey);
      for (let index = 1; index <= suite.ancestorTitles.length; index += 1) {
        expectedSuitePrefixes.add(`${result.filePath}\0${JSON.stringify(suite.ancestorTitles.slice(0, index))}`);
      }
    }
  }
  const expectedDerivedSuiteCount = normalizedResults.length + expectedSuitePrefixes.size;
  if (expectedAssertionTotal !== authority.expectedTestCount
    || expectedDerivedSuiteCount !== authority.expectedSuiteCount) {
    throw createAttestationError(
      shardId,
      "VITEST_AUTHORITY_INVALID",
      `authority 未闭合：tests=${expectedAssertionTotal}/${authority.expectedTestCount} suites=${expectedDerivedSuiteCount}/${authority.expectedSuiteCount}。`,
    );
  }
  return Object.freeze({
    attestationVersion: authority.attestationVersion,
    expectedSuiteCount: authority.expectedSuiteCount,
    expectedTestCount: authority.expectedTestCount,
    expectedTestResults: Object.freeze(normalizedResults),
    shardId,
  });
}

/** 比较单个 testResult 的 suite 路径与 assertion 数，阻断 assertion 在 suite 间搬移。 */
function assertSuiteAssertionDistribution(shardId, filePath, observed, expectedSuites) {
  const expected = new Map(
    expectedSuites.map((suite) => [JSON.stringify(suite.ancestorTitles), suite.expectedAssertionCount]),
  );
  if (observed.size !== expected.size) {
    throw createAttestationError(shardId, "VITEST_SUITE_ASSERTION_MISMATCH", `suite 数量或路径漂移：${filePath}。`);
  }
  for (const [suiteKey, expectedCount] of expected) {
    if (observed.get(suiteKey) !== expectedCount) {
      throw createAttestationError(shardId, "VITEST_SUITE_ASSERTION_MISMATCH", `suite assertion 漂移：${filePath}。`);
    }
  }
}

/** 累计 Vitest assertion 状态并拒绝未知枚举。 */
function incrementAssertionStatus(counts, status, shardId) {
  switch (status) {
    case "passed": counts.passed += 1; break;
    case "failed": counts.failed += 1; break;
    case "pending": counts.pending += 1; break;
    case "skipped":
    case "disabled": counts.skipped += 1; break;
    case "todo": counts.todo += 1; break;
    default:
      throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", `未知测试状态 ${status}。`);
  }
}

/** 将 reporter 输出统一为 Buffer，以字节长度实施平台无关上界。 */
function toOutputBuffer(output, shardId) {
  if (typeof output === "string") {
    return Buffer.from(output, "utf8");
  }
  if (Buffer.isBuffer(output) || output instanceof Uint8Array) {
    return Buffer.from(output);
  }
  throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "reporter stdout 类型无效。");
}

/** 从 reporter 根对象读取非负安全整数。 */
function readReportCount(report, field, shardId) {
  const value = report[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", `${field} 必须是非负安全整数。`);
  }
  return value;
}

/** 将项目内 authority 文件名规范为 POSIX 相对路径。 */
function normalizeExpectedFilePath(filePath, shardId) {
  if (typeof filePath !== "string" || filePath.length === 0 || path.isAbsolute(filePath)) {
    throw createAttestationError(shardId, "VITEST_AUTHORITY_INVALID", "authority 文件路径必须是仓库相对路径。");
  }
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    throw createAttestationError(shardId, "VITEST_AUTHORITY_INVALID", "authority 文件路径越出仓库根。");
  }
  return normalized;
}

/** 将 reporter 的绝对文件名绑定到可信仓库根并转为相对路径。 */
function normalizeReporterFilePath(fileName, repositoryRoot, shardId) {
  let localPath = fileName;
  if (fileName.startsWith("file:")) {
    try {
      localPath = fileURLToPath(fileName);
    } catch {
      throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "testResult file URL 无效。");
    }
  }
  const relative = path.relative(repositoryRoot, path.resolve(localPath));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw createAttestationError(shardId, "VITEST_TEST_RESULT_MISMATCH", "testResult 文件不属于可信仓库根。");
  }
  return relative.replaceAll(path.sep, "/");
}

/** 判断值是否为非数组对象。 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 创建包含稳定代码与 shard 身份的错误。 */
function createAttestationError(shardId, code, detail) {
  return new Error(`[vitest-json-attestation:${shardId}] ${code}: ${detail}`);
}
