import { open, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const includedDirectories = [
  "apps",
  "ci",
  "docs/ci",
  "packages",
  "scripts",
  ".github/workflows",
];
const includedRootFiles = [
  ".npmrc",
  ".node-version",
  ".nvmrc",
  "eslint.config.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.quality.json",
  "vitest.config.ts",
  "vitest.contract.config.ts",
];
const ignoredDirectoryNames = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);
const supportedExtensions = new Set([
  ".cjs",
  ".cts",
  ".bash",
  ".env",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".ps1",
  ".psd1",
  ".psm1",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
  ".zsh",
]);
const placeholderValues = new Set([
  "admin123",
  "changeme",
  "dummy-secret",
  "example-secret",
  "password123",
  "replace-me",
  "replace_me",
  "test-secret",
  "todo-secret",
]);

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

async function collectDirectoryFiles(root, relativeDirectory) {
  const absoluteDirectory = path.join(root, ...relativeDirectory.split("/"));
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || ignoredDirectoryNames.has(entry.name)) {
      continue;
    }
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectDirectoryFiles(root, relativePath)));
    } else if (
      supportedExtensions.has(path.extname(entry.name)) ||
      (path.extname(entry.name) === "" && (await isLikelyUtf8TextFile(root, relativePath)))
    ) {
      files.push(relativePath);
    }
  }
  return files;
}

/**
 * 只读取文件头识别无扩展名 UTF-8 文本，避免把二进制文件加载为扫描输入。
 * @param {string} root 扫描根目录。
 * @param {string} relativePath 相对根目录的 POSIX 路径。
 * @returns {Promise<boolean>} 文件头不含 NUL 且可按严格 UTF-8 解码时返回 true。
 */
async function isLikelyUtf8TextFile(root, relativePath) {
  const handle = await open(path.join(root, ...relativePath.split("/")), "r");
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const content = header.subarray(0, bytesRead);
    if (content.includes(0)) {
      return false;
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
      return true;
    } catch {
      return false;
    }
  } finally {
    await handle.close();
  }
}

async function collectRootEnvironmentFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && (entry.name === ".env" || entry.name.startsWith(".env.")),
    )
    .map((entry) => entry.name);
}

function locationForIndex(source, index) {
  const preceding = source.slice(0, index).split("\n");
  return { column: preceding.at(-1).length + 1, line: preceding.length };
}

function findPatternMatches(source) {
  const findings = [];
  const highConfidencePatterns = [
    {
      message: "private key material is checked into an implementation/config file",
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      rule: "hardcoded-private-key",
    },
    {
      message: "GitHub token-shaped credential is hardcoded",
      pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
      rule: "hardcoded-token",
    },
    {
      message: "AWS access key-shaped credential is hardcoded",
      pattern: /\bAKIA[0-9A-Z]{16}\b/g,
      rule: "hardcoded-token",
    },
    {
      message: "PowerShell dynamic expression execution is enabled",
      pattern: new RegExp(`\\b(?:Invoke-${"Expression"}|i${"ex"})\\b`, "gi"),
      rule: "dangerous-command",
    },
  ];

  for (const candidate of highConfidencePatterns) {
    for (const match of source.matchAll(candidate.pattern)) {
      findings.push({
        ...locationForIndex(source, match.index ?? 0),
        message: candidate.message,
        rule: candidate.rule,
      });
    }
  }
  for (const index of findRemoteShellPipelineIndexes(source)) {
    findings.push({
      ...locationForIndex(source, index),
      message: "remote content is piped directly into a command shell",
      rule: "dangerous-command",
    });
  }

  const assignmentPattern =
    /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z_$][\w$-]*))\s*[:=]\s*["'`]([^"'`\r\n]+)["'`]/g;
  for (const match of source.matchAll(assignmentPattern)) {
    const fieldName = match[1] ?? match[2] ?? match[3] ?? "";
    const normalizedFieldName = fieldName.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const isSensitiveField = [
      "apikey",
      "password",
      "secret",
      "token",
    ].some((suffix) => normalizedFieldName.endsWith(suffix));
    if (!isSensitiveField) {
      continue;
    }

    const value = match[4].trim().toLowerCase();
    findings.push({
      ...locationForIndex(source, match.index ?? 0),
      message: placeholderValues.has(value)
        ? "dangerous placeholder credential is assigned to a sensitive field"
        : "literal credential is assigned to a sensitive field",
      rule: placeholderValues.has(value)
        ? "placeholder-credential"
        : "hardcoded-credential",
    });
  }

  const npmTokenPattern = /:_authToken\s*=\s*(?!\$\{)[^\s]+/g;
  for (const match of source.matchAll(npmTokenPattern)) {
    findings.push({
      ...locationForIndex(source, match.index ?? 0),
      message: "literal npm authentication token is configured",
      rule: "hardcoded-token",
    });
  }

  return findings;
}

/** 使用受限 shell tokenizer 检测 curl/wget 通过 wrapper 链直接进入代码解释器的管道。 */
function findRemoteShellPipelineIndexes(source) {
  const tokens = tokenizeShellSource(source);
  const indexes = [];
  const commandBoundaries = new Set([";", "\n", "&&", "||", "(", ")", "{", "}"]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "|") {
      continue;
    }
    let segmentStart = index - 1;
    while (segmentStart >= 0 && !commandBoundaries.has(tokens[segmentStart].value)) {
      segmentStart -= 1;
    }
    const producer = tokens.slice(segmentStart + 1, index).find((token) =>
      ["curl", "wget"].includes(shellBasename(token.value)),
    );
    if (
      producer !== undefined &&
      isCodeInterpreterInvocationThroughWrappers(tokens.slice(index + 1))
    ) {
      indexes.push(producer.index);
      while (index + 1 < tokens.length && !commandBoundaries.has(tokens[index + 1].value)) {
        index += 1;
      }
    }
  }
  return indexes;
}

/**
 * 解析完整 shell 文本中的命令边界、group、管道、引号与续行。
 * @param {string} source 待扫描的完整文本。
 * @returns {Array<{index:number,value:string}>} 保留绝对字符偏移的受限 token 序列。
 */
function tokenizeShellSource(source) {
  const tokens = [];
  let value = "";
  let tokenStart = -1;
  let quote = null;
  const flush = () => {
    if (tokenStart >= 0) {
      tokens.push({ index: tokenStart, value });
      value = "";
      tokenStart = -1;
    }
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"' && index + 1 < source.length) {
        if (source[index + 1] === "\r" && source[index + 2] === "\n") {
          index += 2;
        } else if (source[index + 1] === "\n" || source[index + 1] === "\r") {
          index += 1;
        } else {
          index += 1;
          value += source[index];
        }
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      if (tokenStart < 0) {
        tokenStart = index;
      }
      quote = character;
      continue;
    }
    if (character === "\\" && index + 1 < source.length) {
      if (source[index + 1] === "\r" && source[index + 2] === "\n") {
        index += 2;
        continue;
      }
      if (source[index + 1] === "\n" || source[index + 1] === "\r") {
        index += 1;
        continue;
      }
      if (tokenStart < 0) {
        tokenStart = index;
      }
      index += 1;
      value += source[index];
      continue;
    }
    if (character === "|") {
      flush();
      if (source[index + 1] === "|") {
        tokens.push({ index, value: "||" });
        index += 1;
      } else {
        tokens.push({ index, value: "|" });
      }
      continue;
    }
    if (character === "&" && source[index + 1] === "&") {
      flush();
      tokens.push({ index, value: "&&" });
      index += 1;
      continue;
    }
    if ([";", "(", ")", "{", "}"].includes(character)) {
      flush();
      tokens.push({ index, value: character });
      continue;
    }
    if (character === "\r" || character === "\n") {
      flush();
      tokens.push({ index, value: "\n" });
      if (character === "\r" && source[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (tokenStart < 0) {
      tokenStart = index;
    }
    value += character;
  }
  flush();
  return tokens;
}

/** 解析 sudo/command/exec/env/赋值 wrapper，最终代码解释器消费 stdin 时命中。 */
function isCodeInterpreterInvocationThroughWrappers(tokens) {
  let index = 0;
  while (index < tokens.length) {
    while (["\n", "(", "{"].includes(tokens[index]?.value)) {
      index += 1;
    }
    if (index >= tokens.length || [";", "&&", "||", ")", "}"].includes(tokens[index].value)) {
      return false;
    }
    const token = tokens[index].value;
    const basename = shellBasename(token);
    if (isShellExecutable(basename)) {
      return true;
    }
    if (basename === "busybox") {
      const applet = tokens.slice(index + 1).find(({ value }) => !value.startsWith("-"));
      return applet !== undefined && ["ash", "bash", "sh"].includes(shellBasename(applet.value));
    }
    if (isStdinCodeInterpreter(basename, tokens.slice(index + 1))) {
      return true;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token)) {
      index += 1;
      continue;
    }
    if (basename === "sudo") {
      index = consumeWrapperOptions(tokens, index + 1, new Set([
        "-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host",
        "-p", "--prompt", "-r", "--role", "-T", "--command-timeout", "-t", "--type",
        "-u", "--user",
      ]));
      continue;
    }
    if (basename === "exec") {
      index = consumeWrapperOptions(tokens, index + 1, new Set(["-a"]));
      continue;
    }
    if (basename === "command") {
      index = consumeWrapperOptions(tokens, index + 1, new Set());
      continue;
    }
    if (basename === "env") {
      index += 1;
      while (index < tokens.length) {
        const option = tokens[index].value;
        if (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(option)) {
          index += 1;
          continue;
        }
        if (["-S", "--split-string"].includes(option)) {
          const splitValue = tokens[index + 1]?.value ?? "";
          const splitTokens = splitValue
            .trim()
            .split(/\s+/u)
            .filter(Boolean)
            .map((value) => ({ index: 0, value }));
          return isCodeInterpreterInvocationThroughWrappers(splitTokens);
        }
        if (["-u", "--unset", "-C", "--chdir"].includes(option)) {
          index += 2;
          continue;
        }
        if (option.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    return false;
  }
  return false;
}

/** 识别会把管道 stdin 当作程序源执行的常见运行时。 */
function isStdinCodeInterpreter(executable, remainingTokens) {
  const argumentsBeforeBoundary = [];
  for (const token of remainingTokens) {
    if ([";", "\n", "&&", "||", ")", "}"].includes(token.value)) {
      break;
    }
    argumentsBeforeBoundary.push(token.value);
  }
  const normalized = executable.toLowerCase();
  if (["powershell", "pwsh"].includes(normalized)) {
    if (argumentsBeforeBoundary.length === 0) {
      return true;
    }
    return argumentsBeforeBoundary.some(
      (argument, index) =>
        ["-c", "-command", "-f", "-file"].includes(argument.toLowerCase()) &&
        argumentsBeforeBoundary[index + 1] === "-",
    );
  }
  if (!["node", "perl", "php", "python", "python3", "ruby"].includes(normalized)) {
    return false;
  }
  if (argumentsBeforeBoundary.length === 0) {
    return true;
  }
  if (argumentsBeforeBoundary.includes("-")) {
    return true;
  }
  const inlineFlags = normalized === "python" || normalized === "python3"
    ? new Set(["-c", "-m"])
    : normalized === "node"
      ? new Set(["-e", "--eval", "-p", "--print"])
      : new Set(["-e"]);
  for (let index = 0; index < argumentsBeforeBoundary.length; index += 1) {
    const argument = argumentsBeforeBoundary[index];
    if (inlineFlags.has(argument) || /^(?:-e|-p).+/u.test(argument)) {
      return false;
    }
    if (!argument.startsWith("-")) {
      return false;
    }
  }
  return true;
}

/** 消费 wrapper option；已知取值 option 必须同时跳过其参数。 */
function consumeWrapperOptions(tokens, startIndex, optionsWithValue) {
  let index = startIndex;
  while (index < tokens.length && tokens[index].value.startsWith("-")) {
    const option = tokens[index].value;
    index += optionsWithValue.has(option) ? 2 : 1;
  }
  return index;
}

/** wrapper 与 shell 可使用 /bin、/usr/bin 等绝对路径。 */
function shellBasename(value) {
  return value.replace(/\\/gu, "/").split("/").at(-1) ?? value;
}

/** 常见 POSIX command shell 均会把管道 stdin 作为命令输入。 */
function isShellExecutable(value) {
  return ["ash", "bash", "dash", "ksh", "sh", "zsh"].includes(value);
}

export async function scanBasicSecurity(root) {
  const relativeFiles = await collectRootEnvironmentFiles(root);
  for (const relativeDirectory of includedDirectories) {
    relativeFiles.push(...(await collectDirectoryFiles(root, relativeDirectory)));
  }
  for (const relativeFile of includedRootFiles) {
    try {
      await readFile(path.join(root, relativeFile), "utf8");
      relativeFiles.push(relativeFile);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  const findings = [];
  for (const relativePath of [...new Set(relativeFiles)].sort()) {
    const source = await readFile(
      path.join(root, ...relativePath.split("/")),
      "utf8",
    );
    for (const finding of findPatternMatches(source)) {
      findings.push({ ...finding, relativePath: toPosix(relativePath) });
    }
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootOptionIndex = process.argv.indexOf("--root");
  const requestedRoot =
    rootOptionIndex >= 0 && process.argv[rootOptionIndex + 1]
      ? path.resolve(process.argv[rootOptionIndex + 1])
      : repositoryRoot;
  const findings = await scanBasicSecurity(requestedRoot);
  for (const finding of findings) {
    console.error(
      `${finding.relativePath}:${finding.line}:${finding.column}: ${finding.message}. Rule: ${finding.rule}. Fix: load credentials from an approved runtime secret source and remove the literal value.`,
    );
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}
