import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  collectPublicCapabilitySurface,
  evaluatePublicCapabilityGateDiff,
  parsePublicCapabilityGateBindings,
} from "../../scripts/contracts/validate-public-capability-gates.mjs";

/** 创建覆盖 CLI/RPC/extension/递归 Schema export 的最小公共表面文件集。 */
function createSurfaceFiles(): Map<string, string> {
  return new Map([
    [
      "apps/cli/package.json",
      JSON.stringify({
        bin: { codegraph: "dist/index.js" },
        codegraph: { publicCommands: ["scan"] },
      }),
    ],
    [
      "apps/cli/src/public-command-registry.ts",
      "const scan = () => 1; export const PUBLIC_COMMANDS = Object.freeze({ scan });",
    ],
    [
      "apps/cli/src/index.ts",
      'import { PUBLIC_COMMANDS } from "./public-command-registry.js"; import { dispatchPublicCommand } from "./public-command-dispatch.js"; await dispatchPublicCommand(PUBLIC_COMMANDS, process.argv.slice(2));',
    ],
    [
      "apps/cli/src/public-command-dispatch.ts",
      "export async function dispatchPublicCommand(commands: Record<string, (...args: unknown[]) => unknown>, argv: string[]) { const commandId = argv[0] ?? ''; if (!Object.hasOwn(commands, commandId)) { throw new Error('unknown command'); } const handler = commands[commandId]; await handler(argv.slice(1)); }",
    ],
    [
      "apps/extension/package.json",
      JSON.stringify({ contributes: { commands: [{ command: "codegraph.open" }] } }),
    ],
    [
      "apps/extension/src/extension.ts",
      'import * as vscode from "vscode"; vscode.commands.registerCommand("codegraph.open", () => 1);',
    ],
    [
      "apps/graph-service/src/server.ts",
      'import { SERVICE_METHODS } from "../../../packages/contracts/src/service-control.js"; const connection = { onRequest(_callback: (method: string) => unknown) {} }; connection.onRequest((method) => { if (method === SERVICE_METHODS.initialize) return 1; return 0; });',
    ],
    [
      "packages/contracts/src/service-control.ts",
      'const initializeMethod = "initialize"; export const SERVICE_METHODS = { initialize: initializeMethod } as const;',
    ],
    [
      "packages/contracts/src/index.ts",
      'export * from "./nested/public-schema.js";',
    ],
    [
      "packages/contracts/src/nested/public-schema.ts",
      'const objectType = "object"; export const resultV1Schema = { type: objectType } as const;',
    ],
  ]);
}

/** 创建只包含门禁判定所需字段的 registry。 */
function registry(
  gates: Array<{ blocking: boolean; command?: string[]; gateId: string }>,
): {
  gates: Array<{
    gateDefinition: { blocking: boolean; command?: string[]; gateId: string };
  }>;
} {
  return { gates: gates.map((gateDefinition) => ({ gateDefinition })) };
}

describe("public capability gate contract", () => {
  it("通过 AST 提取 CLI、RPC 别名、extension 和递归 re-export Schema", () => {
    expect([...collectPublicCapabilitySurface(createSurfaceFiles()).keys()].sort()).toEqual([
      "cli:binary:codegraph",
      "cli:command:scan",
      "extension:command:codegraph.open",
      "rpc:initialize",
      "schema:resultV1Schema",
    ]);
  });

  it("Schema 指纹忽略常量别名但检测既有 Schema 结构变化", () => {
    const direct = createSurfaceFiles();
    direct.set(
      "packages/contracts/src/nested/public-schema.ts",
      'export const resultV1Schema = { type: "object" } as const;',
    );
    const changed = createSurfaceFiles();
    changed.set(
      "packages/contracts/src/nested/public-schema.ts",
      'export const resultV1Schema = { type: "string" } as const;',
    );

    const aliasedFingerprint = collectPublicCapabilitySurface(createSurfaceFiles()).get(
      "schema:resultV1Schema",
    );
    expect(collectPublicCapabilitySurface(direct).get("schema:resultV1Schema")).toBe(
      aliasedFingerprint,
    );
    expect(collectPublicCapabilitySurface(changed).get("schema:resultV1Schema")).not.toBe(
      aliasedFingerprint,
    );
  });

  it("Schema 指纹区分嵌套回调的外层与内层参数引用", () => {
    const outerReference = createSurfaceFiles();
    outerReference.set(
      "packages/contracts/src/nested/public-schema.ts",
      'export const resultV1Schema = { type: "object", transform: (outer: unknown) => (inner: unknown) => outer } as const;',
    );
    const innerReference = createSurfaceFiles();
    innerReference.set(
      "packages/contracts/src/nested/public-schema.ts",
      'export const resultV1Schema = { type: "object", transform: (outer: unknown) => (inner: unknown) => inner } as const;',
    );

    expect(collectPublicCapabilitySurface(outerReference).get("schema:resultV1Schema")).not.toBe(
      collectPublicCapabilitySurface(innerReference).get("schema:resultV1Schema"),
    );
  });

  it("Schema 指纹区分全局 Number 常量与局部同名 shadow", () => {
    const globalNumber = createSurfaceFiles();
    globalNumber.set(
      "packages/contracts/src/nested/public-schema.ts",
      "export const resultV1Schema = { type: 'number', maximum: Number.MAX_SAFE_INTEGER } as const;",
    );
    const shadowedNumber = createSurfaceFiles();
    shadowedNumber.set(
      "packages/contracts/src/nested/public-schema.ts",
      "const Number = { MAX_SAFE_INTEGER: 1 }; export const resultV1Schema = { type: 'number', maximum: Number.MAX_SAFE_INTEGER } as const;",
    );

    expect(collectPublicCapabilitySurface(globalNumber).get("schema:resultV1Schema")).not.toBe(
      collectPublicCapabilitySurface(shadowedNumber).get("schema:resultV1Schema"),
    );
  });

  it.each([
    ["async", "(value: unknown) => value", "async (value: unknown) => value"],
    ["default", "(value: unknown) => value", "(value: unknown = 1) => value"],
    ["rest", "(value: unknown) => value", "(...value: unknown[]) => value"],
    ["optional-call", "() => resolve()", "() => resolve?.()"],
    ["optional-chain", "() => target.value", "() => target?.value"],
  ])("Schema 指纹包含 %s 运行时语义", (_label, leftExpression, rightExpression) => {
    const left = createSurfaceFiles();
    left.set(
      "packages/contracts/src/nested/public-schema.ts",
      `export const resultV1Schema = { type: "object", transform: ${leftExpression} } as const;`,
    );
    const right = createSurfaceFiles();
    right.set(
      "packages/contracts/src/nested/public-schema.ts",
      `export const resultV1Schema = { type: "object", transform: ${rightExpression} } as const;`,
    );

    expect(collectPublicCapabilitySurface(left).get("schema:resultV1Schema")).not.toBe(
      collectPublicCapabilitySurface(right).get("schema:resultV1Schema"),
    );
  });

  it("识别 Object.freeze 包装与 namespace re-export 的公共 Schema", () => {
    const files = createSurfaceFiles();
    files.set(
      "packages/contracts/src/index.ts",
      'export * as v1 from "./nested/public-schema.js";',
    );
    files.set(
      "packages/contracts/src/nested/public-schema.ts",
      'export const resultV1Schema = Object.freeze({ type: "object", properties: {} });',
    );

    expect([...collectPublicCapabilitySurface(files).keys()]).toContain(
      "schema:v1.resultV1Schema",
    );
  });

  it("拒绝 manifest 声明但未绑定真实源码 handler 的 CLI 命令", () => {
    const files = createSurfaceFiles();
    files.set(
      "apps/cli/src/public-command-registry.ts",
      "export const PUBLIC_COMMANDS = Object.freeze({});",
    );

    expect(() => collectPublicCapabilitySurface(files)).toThrow(/publicCommands.*PUBLIC_COMMANDS/u);
  });

  it("extension manifest 与真实 registerCommand 必须逐项一致", () => {
    const hidden = createSurfaceFiles();
    hidden.set(
      "apps/extension/src/extension.ts",
      'import * as vscode from "vscode"; vscode.commands.registerCommand("codegraph.hidden", () => 1);',
    );
    expect(() => collectPublicCapabilitySurface(hidden)).toThrow(/registerCommand.*逐项一致/u);

    const unregistered = createSurfaceFiles();
    unregistered.delete("apps/extension/src/extension.ts");
    expect(() => collectPublicCapabilitySurface(unregistered)).toThrow(/registerCommand.*逐项一致/u);
  });

  it("SERVICE_METHODS 与真实 graph-service handler 必须逐项一致", () => {
    const hidden = createSurfaceFiles();
    hidden.set(
      "apps/graph-service/src/server.ts",
      'import { SERVICE_METHODS } from "../../../packages/contracts/src/service-control.js"; const connection = { onRequest(_callback: (method: string) => unknown) {} }; connection.onRequest((method) => { if (method === SERVICE_METHODS.initialize) return 1; if (method === "graph/hidden") return 2; return 0; });',
    );
    expect(() => collectPublicCapabilitySurface(hidden)).toThrow(/SERVICE_METHODS.*真实/u);

    const missing = createSurfaceFiles();
    missing.set(
      "apps/graph-service/src/server.ts",
      "const connection = { onRequest(_callback: (method: string) => unknown) {} }; connection.onRequest((_requestMethod) => 0);",
    );
    expect(() => collectPublicCapabilitySurface(missing)).toThrow(/SERVICE_METHODS.*真实/u);
  });

  it("拒绝空函数、无副作用表达式或显式返回 undefined 的公共 CLI handler", () => {
    for (const handler of [
      "() => undefined",
      "() => {}",
      "function () { return undefined; }",
      'function () { "noop"; }',
    ]) {
      const files = createSurfaceFiles();
      files.set(
        "apps/cli/src/public-command-registry.ts",
        `export const PUBLIC_COMMANDS = Object.freeze({ scan: ${handler} });`,
      );
      expect(() => collectPublicCapabilitySurface(files)).toThrow(/真实函数实现/u);
    }
  });

  it("公开 CLI bin 必须通过唯一分派入口消费冻结命令注册表", () => {
    const files = createSurfaceFiles();
    files.set(
      "apps/cli/src/index.ts",
      'export { PUBLIC_COMMANDS } from "./public-command-registry.js";',
    );

    expect(() => collectPublicCapabilitySurface(files)).toThrow(/bin.*PUBLIC_COMMANDS|分派入口/u);

    files.set(
      "apps/cli/src/index.ts",
      'import { PUBLIC_COMMANDS } from "./public-command-registry.js"; import { dispatchPublicCommand } from "./public-command-dispatch.js"; async function unused() { await dispatchPublicCommand(PUBLIC_COMMANDS, process.argv.slice(2)); } export { unused };',
    );
    expect(() => collectPublicCapabilitySurface(files)).toThrow(/bin.*PUBLIC_COMMANDS|分派入口/u);

    files.set(
      "apps/cli/src/index.ts",
      'import { PUBLIC_COMMANDS } from "./public-command-registry.js"; import { dispatchPublicCommand } from "./public-command-dispatch.js"; await dispatchPublicCommand(PUBLIC_COMMANDS, process.argv.slice(2));',
    );
    files.set(
      "apps/cli/src/public-command-dispatch.ts",
      "export function dispatchPublicCommand(_commands: unknown, _argv: string[]) { return 1; }",
    );
    expect(() => collectPublicCapabilitySurface(files)).toThrow(/真实.*dispatchPublicCommand|分派/u);

    files.set(
      "apps/cli/src/public-command-dispatch.ts",
      "export async function dispatchPublicCommand(commands: Record<string, (...args: unknown[]) => unknown>, argv: string[]) { const commandId = argv[0] ?? ''; if (!Object.hasOwn(commands, commandId)) { throw new Error('unknown command'); } const handler = commands[commandId]; if (false) { await handler(argv.slice(1)); } }",
    );
    expect(() => collectPublicCapabilitySurface(files)).toThrow(/真实.*dispatchPublicCommand|分派/u);

    files.set(
      "apps/cli/src/public-command-dispatch.ts",
      "export async function dispatchPublicCommand(commands: Record<string, (...args: unknown[]) => unknown>, argv: string[]) { const handler = commands[argv[0] ?? '']; await handler(argv.slice(1)); }",
    );
    expect(() => collectPublicCapabilitySurface(files)).toThrow(/真实.*dispatchPublicCommand|分派/u);

    files.set(
      "apps/cli/src/public-command-dispatch.ts",
      "export async function dispatchPublicCommand(commands: Record<string, (...args: unknown[]) => unknown>, argv: string[]) { const commandId = (argv, 'scan'); if (!Object.hasOwn(commands, commandId)) { throw new Error('unknown'); } const handler = commands[commandId]; await handler(argv.slice(1)); }",
    );
    expect(() => collectPublicCapabilitySurface(files)).toThrow(/真实.*dispatchPublicCommand|分派/u);

    files.set(
      "apps/cli/src/public-command-dispatch.ts",
      "export async function dispatchPublicCommand(commands: Record<string, (...args: unknown[]) => unknown>, argv: string[]) { const commandId = argv[0] ?? ''; if (argv.length > 0) { if (!Object.hasOwn(commands, commandId)) { throw new Error('unknown'); } } const handler = commands[commandId]; await handler(argv.slice(1)); }",
    );
    expect(() => collectPublicCapabilitySurface(files)).toThrow(/真实.*dispatchPublicCommand|分派/u);
  });

  it("使用对象实际所属模块解析跨模块 RPC 常量，并支持 namespace/default handler import", () => {
    const files = createSurfaceFiles();
    files.set(
      "packages/contracts/src/service-control.ts",
      'import { METHODS } from "./methods.js"; export const SERVICE_METHODS = METHODS;',
    );
    files.set(
      "packages/contracts/src/methods.ts",
      'const QUERY = "graph/query"; export const METHODS = { query: QUERY } as const;',
    );
    files.set(
      "apps/graph-service/src/server.ts",
      'import { SERVICE_METHODS } from "../../../packages/contracts/src/service-control.js"; const connection = { onRequest(_callback: (method: string) => unknown) {} }; connection.onRequest((method) => { if (method === SERVICE_METHODS.query) return 1; return 0; });',
    );
    files.set(
      "apps/cli/src/public-command-registry.ts",
      'import scanHandler from "./scan-handler.js"; export const PUBLIC_COMMANDS = Object.freeze({ scan: scanHandler });',
    );
    files.set(
      "apps/cli/src/scan-handler.ts",
      "export default function scanHandler() { return 1; }",
    );

    const surface = collectPublicCapabilitySurface(files);

    expect(surface.has("rpc:graph/query")).toBe(true);
    expect(surface.has("rpc:initialize")).toBe(false);
    expect(surface.has("cli:command:scan")).toBe(true);

    files.set(
      "apps/cli/src/public-command-registry.ts",
      'import * as handlers from "./handlers.js"; export const PUBLIC_COMMANDS = Object.freeze({ scan: handlers.scan });',
    );
    files.set("apps/cli/src/handlers.ts", "export function scan() { return 1; }");
    expect(collectPublicCapabilitySurface(files).has("cli:command:scan")).toBe(true);
  });

  it.each([
    'SERVICE_METHODS.query = "graph/query";',
    'Object.assign(SERVICE_METHODS, { query: "graph/query" });',
    'const alias = SERVICE_METHODS; alias.query = "graph/query";',
  ])("拒绝 SERVICE_METHODS 声明后的 runtime mutation：%s", (mutation) => {
    const files = createSurfaceFiles();
    files.set(
      "packages/contracts/src/service-control.ts",
      `export const SERVICE_METHODS = { initialize: "initialize" } as const; ${mutation}`,
    );

    expect(() => collectPublicCapabilitySurface(files)).toThrow(/SERVICE_METHODS.*mutation|运行时修改/u);
  });

  it.each([
    "PUBLIC_COMMANDS.hidden = () => undefined;",
    "Object.assign(PUBLIC_COMMANDS, { hidden: () => undefined });",
    "const alias = PUBLIC_COMMANDS; alias.hidden = () => undefined;",
  ])("拒绝 PUBLIC_COMMANDS 声明后的 mutation 或别名逃逸：%s", (mutation) => {
    const files = createSurfaceFiles();
    files.set(
      "apps/cli/src/public-command-registry.ts",
      `const scan = () => 1; export const PUBLIC_COMMANDS = Object.freeze({ scan }); ${mutation}`,
    );

    expect(() => collectPublicCapabilitySurface(files)).toThrow(/PUBLIC_COMMANDS.*Object\.freeze|mutation/u);
  });

  it("拒绝通过同名 Object 绑定伪造 freeze", () => {
    const files = createSurfaceFiles();
    files.set(
      "apps/cli/src/public-command-registry.ts",
      "const Object = { freeze: (value: unknown) => value }; const scan = () => 1; export const PUBLIC_COMMANDS = Object.freeze({ scan });",
    );

    expect(() => collectPublicCapabilitySurface(files)).toThrow(/全局 Object\.freeze/u);
  });

  it("按真实绑定识别被重命名为非 Schema 后缀的公共 Schema", () => {
    const files = createSurfaceFiles();
    files.set(
      "packages/contracts/src/index.ts",
      'export { resultV1Schema as PublicResultContract } from "./nested/public-schema.js";',
    );

    expect([...collectPublicCapabilitySurface(files).keys()]).toContain(
      "schema:PublicResultContract",
    );

    files.set(
      "packages/contracts/src/nested/public-schema.ts",
      'export const PublicResultContract = { type: "object", properties: {} } as const;',
    );
    files.set(
      "packages/contracts/src/index.ts",
      'export { PublicResultContract } from "./nested/public-schema.js";',
    );
    expect([...collectPublicCapabilitySurface(files).keys()]).toContain(
      "schema:PublicResultContract",
    );
  });

  it.each([
    'resultV1Schema.required = ["id"];',
    'Object.assign(resultV1Schema, { additionalProperties: false });',
    'const alias = resultV1Schema; alias.type = "string";',
    'function mutate(value: Record<string, unknown>) { value.type = "string"; } mutate(resultV1Schema);',
  ])("拒绝公共 Schema 声明后的 runtime mutation：%s", (mutation) => {
    const files = createSurfaceFiles();
    files.set(
      "packages/contracts/src/nested/public-schema.ts",
      `export const resultV1Schema = { type: "object" } as const; ${mutation}`,
    );

    expect(() => collectPublicCapabilitySurface(files)).toThrow(/公共 Schema.*mutation|运行时修改/u);
  });

  it.each([
    'export const CompositeContract = { allOf: [{ type: "object" }] } as const;',
    'export const ReferencedContract = { $ref: "#/$defs/value", $defs: { value: { type: "string" } } } as const;',
  ])("识别不依赖 Schema 后缀的组合或引用 JSON Schema：%s", (declaration) => {
    const files = createSurfaceFiles();
    files.set("packages/contracts/src/nested/public-schema.ts", declaration);

    expect([...collectPublicCapabilitySurface(files).keys()]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^schema:/u)]),
    );
  });

  it("新增或结构变化能力缺失完整映射或专属验证时 fail closed", () => {
    const baseSurface = new Map([["rpc:initialize", "rpc:initialize"]]);
    const headSurface = new Map([
      ["rpc:initialize", "rpc:initialize"],
      ["rpc:graph/query", "rpc:graph/query"],
    ]);
    const baseGateIds = new Set(["contract"]);

    expect(
      evaluatePublicCapabilityGateDiff({
        baseBindings: { bindings: [], schemaVersion: 1 },
        baseGateIds,
        baseSurface,
        headBindings: { bindings: [], schemaVersion: 1 },
        headRegistry: registry([
          { blocking: true, gateId: "contract" },
          { blocking: true, gateId: "graph-query-contract" },
        ]),
        headSurface,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "public-capability-gate" }),
      ]),
    );

    expect(
      evaluatePublicCapabilityGateDiff({
        baseBindings: { bindings: [], schemaVersion: 1 },
        baseGateIds,
        baseSurface,
        headBindings: {
          bindings: [{ capabilityId: "rpc:graph/query", gateId: "graph-query-contract" }],
          schemaVersion: 1,
        },
        headRegistry: registry([
          { blocking: true, gateId: "contract" },
          { blocking: true, gateId: "graph-query-contract" },
          { blocking: false, gateId: "graph-query-diagnostics" },
        ]),
        headSurface,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/专属.*evidence/u) }),
      ]),
    );
  });

  it("基线无 registry/mapping 时仍要求候选新增能力完成严格 verification", () => {
    expect(
      evaluatePublicCapabilityGateDiff({
        baseBindings: { bindings: [], schemaVersion: 1 },
        baseGateIds: new Set(),
        baseSurface: new Map(),
        headBindings: {
          bindings: [{ capabilityId: "rpc:initialize", gateId: "contract" }],
          schemaVersion: 1,
        },
        headRegistry: registry([{ blocking: true, gateId: "contract" }]),
        headSurface: new Map([["rpc:initialize", "rpc:initialize"]]),
      }),
    ).toEqual([expect.objectContaining({ message: expect.stringMatching(/专属.*evidence/u) })]);
  });

  it("候选 bindings 必须完整覆盖公共表面且不得静默删除基线映射", () => {
    const baseSurface = new Map([["rpc:initialize", "rpc:initialize"]]);
    const headSurface = new Map(baseSurface);
    const result = evaluatePublicCapabilityGateDiff({
      baseBindings: {
        bindings: [{ capabilityId: "rpc:initialize", gateId: "contract" }],
        schemaVersion: 1,
      },
      baseGateIds: new Set(["contract"]),
      baseSurface,
      headBindings: { bindings: [], schemaVersion: 1 },
      headRegistry: registry([{ blocking: true, command: ["pnpm", "contract"], gateId: "contract" }]),
      headSurface,
    });

    expect(result).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/完整覆盖|静默删除/u),
        rule: "public-capability-gate",
      }),
    ]);
  });

  it("变化能力必须绑定专属测试、fixture、独立 gate 入口与 evidence 合同", () => {
    const capabilityId = "rpc:graph/query";
    const evidenceId = `public-capability:${capabilityId}`;
    const entryPath = "scripts/contracts/verify-graph-query.mjs";
    const testPath = "tests/contract/graph-query.contract.test.ts";
    const fixturePath = "tests/fixtures/graph-query.request.json";
    const modulePath = "packages/application/src/graph-query.ts";
    const verification = {
      assertionTarget: { exportName: "validateGraphQuery", modulePath },
      entryPath,
      evidenceId,
      fixturePath,
      testPath,
    };
    const command = [
      "node",
      entryPath,
      "--capability",
      capabilityId,
      "--test",
      testPath,
      "--fixture",
      fixturePath,
      "--evidence-id",
      evidenceId,
    ];
    const common = {
      baseBindings: {
        bindings: [{ capabilityId: "rpc:initialize", gateId: "contract" }],
        schemaVersion: 1,
      },
      baseFiles: new Map<string, string>(),
      baseGateIds: new Set(["contract"]),
      baseSurface: new Map([["rpc:initialize", "rpc:initialize"]]),
      headBindings: {
        bindings: [
          { capabilityId: "rpc:initialize", gateId: "contract" },
          { capabilityId, gateId: "graph-query-contract", verification },
        ],
        schemaVersion: 1,
      },
      headFiles: new Map([
        [
          entryPath,
          `import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";
await runPublicCapabilityVerification({ argv: process.argv.slice(2), capabilityId: "${capabilityId}", evidenceId: "${evidenceId}", fixturePath: "${fixturePath}", testPath: "${testPath}" });`,
        ],
        [
          testPath,
          `import { expect, it } from "vitest";
import { validateGraphQuery } from "../../packages/application/src/graph-query.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";
it("验证正向与负向能力合同", async () => {
  await runBoundPublicCapabilityTest({
    capabilityId: "${capabilityId}",
    evidenceId: "${evidenceId}",
    fixturePath: "${fixturePath}",
    verifyNegative: ({ fixture }) => {
      expect(validateGraphQuery({ fixture, invalid: true })).toBe(false);
    },
    verifyPositive: ({ fixture }) => {
      expect(validateGraphQuery(fixture)).toBe(true);
    },
  });
});`,
        ],
        [modulePath, "export const validateGraphQuery = (value: unknown) => Boolean(value);"],
        [fixturePath, JSON.stringify({ capabilityId, evidenceId })],
      ]),
      headSurface: new Map([
        ["rpc:initialize", "rpc:initialize"],
        [capabilityId, capabilityId],
      ]),
    };

    expect(
      evaluatePublicCapabilityGateDiff({
        ...common,
        headRegistry: registry([
          { blocking: true, command: ["pnpm", "contract"], gateId: "contract" },
          { blocking: true, command, gateId: "graph-query-contract" },
        ]),
      }),
    ).toEqual([]);

    for (const forgedTest of [
      `import { it } from "vitest";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";
const expect = (_value: unknown) => ({ not: { toBe: () => undefined }, toBe: () => undefined });
it("伪造 expect", async () => {
  await runBoundPublicCapabilityTest({ capabilityId: "${capabilityId}", evidenceId: "${evidenceId}", fixturePath: "${fixturePath}", verifyNegative: (context) => { expect(context).not.toBe(context); }, verifyPositive: (context) => { expect(context).toBe(context); } });
});`,
      `import { expect, it } from "vitest";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";
it("恒真自比较", async () => {
  await runBoundPublicCapabilityTest({ capabilityId: "${capabilityId}", evidenceId: "${evidenceId}", fixturePath: "${fixturePath}", verifyNegative: (context) => { expect(context).not.toBe(context); }, verifyPositive: (context) => { expect(context).toBe(context); } });
});`,
      `import assert from "node:assert/strict";
import { it } from "vitest";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";
it("doesNotThrow 不代表负向拒绝", async () => {
  await runBoundPublicCapabilityTest({ capabilityId: "${capabilityId}", evidenceId: "${evidenceId}", fixturePath: "${fixturePath}", verifyNegative: (context) => { assert.doesNotThrow(() => String(context)); }, verifyPositive: (context) => { assert.strictEqual(context.capabilityId, "${capabilityId}"); } });
});`,
    ]) {
      const forgedAssets = { ...common, headFiles: new Map(common.headFiles) };
      forgedAssets.headFiles.set(testPath, forgedTest);
      expect(
        evaluatePublicCapabilityGateDiff({
          ...forgedAssets,
          headRegistry: registry([
            { blocking: true, command: ["pnpm", "contract"], gateId: "contract" },
            { blocking: true, command, gateId: "graph-query-contract" },
          ]),
        }),
      ).toEqual([expect.objectContaining({ message: expect.stringMatching(/测试|断言|runtime/u) })]);
    }

    const unrelatedAssertionAssets = {
      ...common,
      headFiles: new Map(common.headFiles),
    };
    unrelatedAssertionAssets.headFiles.set(
      testPath,
      `import { expect, it } from "vitest";
import { validateGraphQuery } from "../../packages/application/src/graph-query.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";
it("能力调用结果未进入断言", async () => {
  await runBoundPublicCapabilityTest({
    capabilityId: "${capabilityId}",
    evidenceId: "${evidenceId}",
    fixturePath: "${fixturePath}",
    verifyNegative: ({ fixture }) => { validateGraphQuery(fixture); expect(fixture).not.toBe(null); },
    verifyPositive: ({ fixture }) => { validateGraphQuery(fixture); expect(fixture).toBeDefined(); },
  });
});`,
    );
    expect(
      evaluatePublicCapabilityGateDiff({
        ...unrelatedAssertionAssets,
        headRegistry: registry([
          { blocking: true, command: ["pnpm", "contract"], gateId: "contract" },
          { blocking: true, command, gateId: "graph-query-contract" },
        ]),
      }),
    ).toEqual([expect.objectContaining({ message: expect.stringMatching(/能力|断言|测试/u) })]);

    const lexicalOnlyAssets = {
      ...common,
      headFiles: new Map(common.headFiles),
    };
    lexicalOnlyAssets.headFiles.set(
      testPath,
      `import { expect, it } from "vitest";
const fixturePath = "${fixturePath}";
const evidenceId = "${evidenceId}";
it("只伪造字符串标记", () => { expect(fixturePath).toContain("fixtures"); expect(evidenceId).not.toBe(""); });`,
    );
    expect(
      evaluatePublicCapabilityGateDiff({
        ...lexicalOnlyAssets,
        headRegistry: registry([
          { blocking: true, command: ["pnpm", "contract"], gateId: "contract" },
          { blocking: true, command, gateId: "graph-query-contract" },
        ]),
      }),
    ).toEqual([expect.objectContaining({ message: expect.stringMatching(/测试|runtime|fixture|evidence/u) })]);

    expect(
      evaluatePublicCapabilityGateDiff({
        ...common,
        headBindings: {
          bindings: [
            { capabilityId: "rpc:initialize", gateId: "contract" },
            { capabilityId, gateId: "graph-query-contract" },
          ],
          schemaVersion: 1,
        },
        headRegistry: registry([
          { blocking: true, command: ["pnpm", "contract"], gateId: "contract" },
          { blocking: true, command, gateId: "graph-query-contract" },
        ]),
      }),
    ).toEqual([expect.objectContaining({ message: expect.stringMatching(/专属.*evidence/u) })]);

    expect(
      evaluatePublicCapabilityGateDiff({
        ...common,
        headRegistry: registry([
          { blocking: true, command: ["pnpm", "contract"], gateId: "contract" },
          { blocking: true, command: ["pnpm", "contract"], gateId: "graph-query-contract" },
        ]),
      }),
    ).toEqual([expect.objectContaining({ message: expect.stringMatching(/命令|入口/u) })]);

    const noOpAssets = {
      ...common,
      headFiles: new Map([
        [entryPath, `export const capabilityId = "${capabilityId}";`],
        [testPath, `export const evidenceId = "${evidenceId}";`],
        [fixturePath, "{}"],
      ]),
    };
    expect(
      evaluatePublicCapabilityGateDiff({
        ...noOpAssets,
        headRegistry: registry([
          { blocking: true, command: ["pnpm", "contract"], gateId: "contract" },
          { blocking: true, command, gateId: "graph-query-contract" },
        ]),
      }),
    ).toEqual([expect.objectContaining({ message: expect.stringMatching(/入口|测试|fixture|evidence/u) })]);
  });

  it("映射合同拒绝乱序、重复与未知字段", () => {
    expect(() =>
      parsePublicCapabilityGateBindings(
        JSON.stringify({
          bindings: [
            { capabilityId: "rpc:z", gateId: "contract" },
            { capabilityId: "rpc:a", gateId: "contract" },
          ],
          schemaVersion: 1,
        }),
      ),
    ).toThrow(/升序/u);
    expect(() =>
      parsePublicCapabilityGateBindings(
        JSON.stringify({ bindings: [], extra: true, schemaVersion: 1 }),
      ),
    ).toThrow(/封闭对象/u);
    expect(() =>
      parsePublicCapabilityGateBindings(
        JSON.stringify({
          bindings: [
            {
              capabilityId: "rpc:a",
              gateId: "rpc-a-contract",
              verification: {
                assertionTarget: {
                  exportName: "verifyRpcA",
                  modulePath: "packages/application/src/rpc-a.ts",
                },
                entryPath: "scripts/contracts/verify-a.mjs",
                evidenceId: "public-capability:rpc:a",
                fixturePath: "tests/fixtures/a.json",
                testPath: "tests/contract/a.test.ts",
              },
            },
          ],
          schemaVersion: 1,
        }),
      ),
    ).not.toThrow();
  });

  it("当前仓库公共表面在 bootstrap 迁移中全部绑定真实 blocking gate", async () => {
    const repositoryRoot = path.resolve(new URL("../../", import.meta.url).pathname.replace(
      /^\/(?:[A-Za-z]:)/u,
      (value) => value.slice(1),
    ));
    const files = new Map<string, string>();
    for (const relativePath of ["apps/cli/package.json", "apps/extension/package.json"]) {
      files.set(relativePath, await readFile(path.join(repositoryRoot, relativePath), "utf8"));
    }
    for (const relativeRoot of [
      "apps/cli/src",
      "apps/extension/src",
      "apps/graph-service/src",
      "packages/contracts",
    ]) {
      await collectTypeScriptSources(repositoryRoot, relativeRoot, files);
    }
    const headSurface = collectPublicCapabilitySurface(files);
    const headBindings = parsePublicCapabilityGateBindings(
      await readFile(path.join(repositoryRoot, "ci/public-capability-gates.v1.json"), "utf8"),
    );
    for (const binding of headBindings.bindings) {
      const verificationPaths = binding.verification === undefined
        ? []
        : [
            binding.verification.entryPath,
            binding.verification.fixturePath,
            binding.verification.testPath,
            binding.verification.assertionTarget.modulePath,
          ];
      for (const relativePath of verificationPaths) {
        if (typeof relativePath === "string" && relativePath.includes("/")) {
          files.set(relativePath, await readFile(path.join(repositoryRoot, relativePath), "utf8"));
        }
      }
    }
    const headRegistry = parse(
      await readFile(path.join(repositoryRoot, "ci/quality-gates.v1.yaml"), "utf8"),
    ) as { gates: Array<{ gateDefinition: { blocking: boolean; gateId: string } }> };
    const gateSchemaCapabilities = new Set([
      "schema:gateDefinitionV1Schema",
      "schema:gateEvaluationContextV1Schema",
      "schema:gateEvidenceV1Schema",
      "schema:gateOutputV1Schema",
      "schema:gateRegistryV1Schema",
    ]);
    const baseSurface = new Map(
      [...headSurface].filter(([capabilityId]) => !gateSchemaCapabilities.has(capabilityId)),
    );

    expect(
      evaluatePublicCapabilityGateDiff({
        baseBindings: { bindings: [], schemaVersion: 1 },
        baseGateIds: new Set(),
        baseSurface,
        headFiles: files,
        headBindings,
        headRegistry,
        headSurface,
      }),
    ).toEqual([]);
  });
});

/** 递归读取公共表面分析所需源码，排除构建产物与依赖目录。 */
async function collectTypeScriptSources(
  repositoryRoot: string,
  relativeDirectory: string,
  files: Map<string, string>,
): Promise<void> {
  const absoluteDirectory = path.join(repositoryRoot, relativeDirectory);
  for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules") {
        await collectTypeScriptSources(
          repositoryRoot,
          `${relativeDirectory}/${entry.name}`,
          files,
        );
      }
      continue;
    }
    if (!/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) {
      continue;
    }
    const relativePath = `${relativeDirectory}/${entry.name}`;
    files.set(
      relativePath,
      await readFile(path.join(repositoryRoot, ...relativePath.split("/")), "utf8"),
    );
  }
}
