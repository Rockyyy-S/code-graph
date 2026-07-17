import path from "node:path";

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

export default function formatEslintResults(results) {
  const lines = [];

  for (const result of results) {
    const relativePath = toPosix(path.relative(process.cwd(), result.filePath));
    for (const message of result.messages) {
      const rule = message.ruleId ?? "eslint";
      lines.push(
        `${relativePath}:${message.line ?? 1}:${message.column ?? 1}: ${message.message} Rule: ${rule}. Fix: resolve the reported issue without disabling or suppressing the rule.`,
      );
    }
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
