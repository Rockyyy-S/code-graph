import ts from "typescript";
import {
  serializeModuleQualifier,
  type AnalysisDiagnosticV1,
  type LocalExportBindingSeedV1,
  type ModuleLanguageV1,
  type ModuleQualifierV1,
  type ModuleRelationTypeV1,
  type SourceRangeV1,
} from "@codegraph/domain";

/** 语法提取输入只包含受信任源码快照，不包含物理路径。 */
export interface ExtractModuleSyntaxFactsOptions {
  compilerOptions?: ts.CompilerOptions;
  /** NodeNext/Node16 下由 package.json type 推导出的文件格式。 */
  impliedNodeFormat?: ts.ResolutionMode;
  language: ModuleLanguageV1;
  /** Worker 可注入增量预算；事实进入结果数组前先执行 MAX+1 检查。 */
  onFact?: (
    fact: AnalysisDiagnosticV1 | LocalExportBindingSeedV1 | ModuleSyntaxRelationV1,
  ) => void;
  path: string;
  /** 持久 Program 已解析的同版本 SourceFile；提供时避免重复 AST 构建。 */
  sourceFile?: ts.SourceFile;
  sourceFileId: string;
  sourceText: string;
}

/** 尚未执行目标解析的 AD-24 关系 seed。 */
export interface ModuleSyntaxRelationV1 {
  language: ModuleLanguageV1;
  normalizedRange: SourceRangeV1;
  qualifier: string;
  qualifierModel: ModuleQualifierV1;
  relationType: ModuleRelationTypeV1;
  resolutionMode: "import" | "require";
  specifier: string;
  /** 传给 TypeScript resolveModuleName 的公开 ResolutionMode。 */
  typescriptResolutionMode: ts.ResolutionMode;
}

/** 单文件纯语法提取结果。 */
export interface ModuleSyntaxFactsV1 {
  diagnostics: readonly AnalysisDiagnosticV1[];
  localExportBindings: readonly LocalExportBindingSeedV1[];
  relations: readonly ModuleSyntaxRelationV1[];
}

/**
 * 使用 TypeScript 6 稳定公开 AST guards 执行 AD-24 唯一语法映射。
 *
 * 本函数不读取 emit、SymbolFlags、项目 plugin、transformer 或 tsserver 私有状态。
 */
export function extractModuleSyntaxFacts(
  options: ExtractModuleSyntaxFactsOptions,
): ModuleSyntaxFactsV1 {
  const sourceFile = options.sourceFile ?? ts.createSourceFile(
      options.path,
      options.sourceText,
      {
        impliedNodeFormat: options.impliedNodeFormat,
        languageVersion: ts.ScriptTarget.Latest,
      },
      true,
      scriptKindForLanguage(options.language),
    );
  const relations: ModuleSyntaxRelationV1[] = [];
  const diagnostics: AnalysisDiagnosticV1[] = [];
  const localExportBindings: LocalExportBindingSeedV1[] = [];
  const requireBindings = collectRequireBindings(sourceFile);

  const addRelation = (
    relationType: ModuleRelationTypeV1,
    qualifierModel: ModuleQualifierV1,
    specifier: string,
    node: ts.Node,
    usage: ts.StringLiteralLike,
    resolutionMode: "import" | "require",
  ): void => {
    const compilerOptions = options.compilerOptions ?? {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const fact = Object.freeze({
      language: options.language,
      normalizedRange: rangeOf(node, sourceFile),
      qualifier: serializeModuleQualifier(qualifierModel),
      qualifierModel,
      relationType,
      resolutionMode,
      specifier,
      typescriptResolutionMode: ts.getModeForUsageLocation(sourceFile, usage, compilerOptions),
    });
    options.onFact?.(fact);
    relations.push(fact);
  };
  const addImport = (
    specifier: string,
    typeOrValue: "dynamic" | "type" | "value",
    node: ts.Node,
    usage: ts.StringLiteralLike,
    resolutionMode: "import" | "require" = "import",
  ): void => addRelation(
    "imports",
    { kind: "imports", typeOrValue, version: 1 },
    specifier,
    node,
    usage,
    resolutionMode,
  );
  const addLocalExport = (
    exportedName: string,
    localName: string | "default",
    typeOrValue: "type" | "value",
    node: ts.Node,
  ): void => {
    const normalizedRange = rangeOf(node, sourceFile);
    const fact = Object.freeze({
      exportedName,
      language: options.language,
      localName,
      normalizedRange,
      sourceFileId: options.sourceFileId,
      stableSortKey: [exportedName, localName, typeOrValue, normalizedRange.start,
        normalizedRange.end].join("\0"),
      typeOrValue,
    });
    options.onFact?.(fact);
    localExportBindings.push(fact);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause === undefined) {
        addImport(specifier, "value", node, node.moduleSpecifier);
      } else if (clause.isTypeOnly) {
        addImport(specifier, "type", clause, node.moduleSpecifier);
      } else {
        let emittedBinding = false;
        if (clause.name !== undefined) {
          addImport(specifier, "value", clause.name, node.moduleSpecifier);
          emittedBinding = true;
        }
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          addImport(specifier, "value", bindings, node.moduleSpecifier);
          emittedBinding = true;
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            addImport(
              specifier,
              element.isTypeOnly ? "type" : "value",
              element,
              node.moduleSpecifier,
            );
            emittedBinding = true;
          }
        }
        if (!emittedBinding) {
          addImport(specifier, "value", node, node.moduleSpecifier);
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression !== undefined &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        addImport(
          node.moduleReference.expression.text,
          node.isTypeOnly ? "type" : "value",
          node,
          node.moduleReference.expression,
          "require",
        );
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (node.exportClause === undefined) {
          const typeOrValue = node.isTypeOnly ? "type" : "value";
          addImport(specifier, typeOrValue, node, node.moduleSpecifier);
          addRelation(
            "exports",
            { kind: "star", typeOrValue, version: 1 },
            specifier,
            node,
            node.moduleSpecifier,
            "import",
          );
        } else if (ts.isNamedExports(node.exportClause)) {
          if (node.exportClause.elements.length === 0) {
            addImport(
              specifier,
              node.isTypeOnly ? "type" : "value",
              node,
              node.moduleSpecifier,
            );
          }
          for (const element of node.exportClause.elements) {
            const typeOrValue = node.isTypeOnly || element.isTypeOnly ? "type" : "value";
            const importedName = element.propertyName?.text ?? element.name.text;
            const exportedName = element.name.text;
            addImport(specifier, typeOrValue, element, node.moduleSpecifier);
            addRelation("exports", {
              exportedName,
              importedName,
              kind: "reexport",
              typeOrValue,
              version: 1,
            }, specifier, element, node.moduleSpecifier, "import");
          }
        } else {
          const exportedName = node.exportClause.name.text;
          addImport(
            specifier,
            node.isTypeOnly ? "type" : "value",
            node.exportClause,
            node.moduleSpecifier,
          );
          addRelation("exports", {
            exportedName,
            importedName: "*",
            kind: "reexport",
            typeOrValue: node.isTypeOnly ? "type" : "value",
            version: 1,
          }, specifier, node.exportClause, node.moduleSpecifier, "import");
        }
      } else if (
        node.parent === sourceFile &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const element of node.exportClause.elements) {
          addLocalExport(
            element.name.text,
            element.propertyName?.text ?? element.name.text,
            node.isTypeOnly || element.isTypeOnly ? "type" : "value",
            element,
          );
        }
      }
    } else if (node.parent === sourceFile && isExportedDeclaration(node)) {
      addDeclarationExports(node, addLocalExport);
    } else if (
      node.parent === sourceFile &&
      ts.isExportAssignment(node) &&
      !node.isExportEquals
    ) {
      addLocalExport(
        "default",
        defaultExportLocalName(node.expression),
        "value",
        node,
      );
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          addImport(argument.text, "dynamic", node, argument);
        } else {
          const diagnostic = createLiteralDiagnostic(
            "MODULE_DYNAMIC_SPECIFIER_NOT_LITERAL",
            options.path,
            rangeOf(node, sourceFile),
            "将动态 import 的模块名改为字符串 literal，或接受本次不生成精确边。",
          );
          options.onFact?.(diagnostic);
          diagnostics.push(diagnostic);
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        !isRequireShadowed(node.expression, requireBindings)
      ) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          addImport(argument.text, "value", node, argument, "require");
        } else {
          const diagnostic = createLiteralDiagnostic(
            "MODULE_REQUIRE_SPECIFIER_NOT_LITERAL",
            options.path,
            rangeOf(node, sourceFile),
            "将 require 的模块名改为字符串 literal，或接受本次不生成精确边。",
          );
          options.onFact?.(diagnostic);
          diagnostics.push(diagnostic);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    localExportBindings: Object.freeze(localExportBindings),
    relations: Object.freeze(relations),
  });
}

/** 递归剥离不改变运行时值身份的透明表达式包装。 */
function defaultExportLocalName(expression: ts.Expression): string | "default" {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : "default";
}

/** 依据 manifest 语言选择公开 ScriptKind。 */
function scriptKindForLanguage(language: ModuleLanguageV1): ts.ScriptKind {
  switch (language) {
    case "javascript": return ts.ScriptKind.JS;
    case "javascriptreact": return ts.ScriptKind.JSX;
    case "typescript": return ts.ScriptKind.TS;
    case "typescriptreact": return ts.ScriptKind.TSX;
  }
}

/** 判断声明是否带有 export/default 修饰符。 */
function isExportedDeclaration(node: ts.Node): node is
  | ts.ClassDeclaration
  | ts.EnumDeclaration
  | ts.FunctionDeclaration
  | ts.InterfaceDeclaration
  | ts.ModuleDeclaration
  | ts.TypeAliasDeclaration
  | ts.VariableStatement {
  return (
    ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) ||
    ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) ||
    ts.isModuleDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
    ts.isVariableStatement(node)
  ) && ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

/** 将 Story 1.5 声明级导出收敛为后续 symbol Story 可消费的本地 binding seed。 */
function addDeclarationExports(
  node:
    | ts.ClassDeclaration
    | ts.EnumDeclaration
    | ts.FunctionDeclaration
    | ts.InterfaceDeclaration
    | ts.ModuleDeclaration
    | ts.TypeAliasDeclaration
    | ts.VariableStatement,
  addLocalExport: (
    exportedName: string,
    localName: string | "default",
    typeOrValue: "type" | "value",
    declaration: ts.Node,
  ) => void,
): void {
  const isDefault = ts.getModifiers(node)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.DefaultKeyword) === true;
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      for (const name of bindingNames(declaration.name)) {
        addLocalExport(name, name, "value", declaration);
      }
    }
    return;
  }
  if (ts.isModuleDeclaration(node)) {
    if (ts.isIdentifier(node.name)) {
      addLocalExport(node.name.text, node.name.text, "value", node);
    }
    return;
  }
  const typeOrValue = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
    ? "type"
    : "value";
  const localName = node.name?.text ?? "default";
  addLocalExport(isDefault ? "default" : localName, localName, typeOrValue, node);
}

/** 递归提取变量绑定名，避免解构导出遗漏本地 seed。 */
function bindingNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) {return [name.text];}
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

/** 收集每个词法作用域内会遮蔽 CommonJS 全局 require 的值声明。 */
function collectRequireBindings(sourceFile: ts.SourceFile): ReadonlyMap<ts.Node, ReadonlySet<string>> {
  const bindings = new Map<ts.Node, Set<string>>();
  const register = (scope: ts.Node | null, names: readonly string[]): void => {
    if (scope === null || !names.includes("require")) {return;}
    const namesInScope = bindings.get(scope) ?? new Set<string>();
    namesInScope.add("require");
    bindings.set(scope, namesInScope);
  };
  const visit = (node: ts.Node): void => {
    if (isAmbientDeclaration(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isVariableDeclaration(node) && !ts.isCatchClause(node.parent)) {
      const declarationList = node.parent;
      const blockScoped = ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      register(findDeclarationScope(node, blockScoped), bindingNames(node.name));
    } else if (ts.isParameter(node)) {
      register(findFunctionScope(node), bindingNames(node.name));
    } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      register(node, bindingNames(node.variableDeclaration.name));
    } else if (ts.isImportClause(node) && node.name !== undefined && !node.isTypeOnly) {
      register(sourceFile, [node.name.text]);
    } else if ((ts.isNamespaceImport(node) || ts.isImportSpecifier(node)) &&
      !isTypeOnlyImportBinding(node)) {
      register(sourceFile, [node.name.text]);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      register(sourceFile, [node.name.text]);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) &&
      node.name !== undefined && ts.isIdentifier(node.name)
    ) {
      register(findDeclarationScope(node, true), [node.name.text]);
      if (ts.isFunctionDeclaration(node)) {register(node, [node.name.text]);}
    } else if (
      (ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
      node.name !== undefined
    ) {
      register(node, [node.name.text]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

/** declare、ambient namespace 与声明文件只提供类型环境，不遮蔽真实 CommonJS require。 */
function isAmbientDeclaration(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isSourceFile(current)) {return current.isDeclarationFile;}
    if (ts.canHaveModifiers(current) && ts.getModifiers(current)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.DeclareKeyword) === true) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** type-only specifier/namespace 不建立值绑定，不能遮蔽运行时 CommonJS require。 */
function isTypeOnlyImportBinding(node: ts.NamespaceImport | ts.ImportSpecifier): boolean {
  if (ts.isImportSpecifier(node) && node.isTypeOnly) {return true;}
  const importClause = ts.isImportSpecifier(node)
    ? node.parent.parent
    : node.parent;
  return ts.isImportClause(importClause) && importClause.isTypeOnly;
}

/** 判断 require 标识符从调用点向外是否命中任一词法值声明。 */
function isRequireShadowed(
  identifier: ts.Identifier,
  bindings: ReadonlyMap<ts.Node, ReadonlySet<string>>,
): boolean {
  let current: ts.Node | undefined = identifier.parent;
  while (current !== undefined) {
    if (bindings.get(current)?.has("require") === true) {return true;}
    current = current.parent;
  }
  return false;
}

/** var 归属函数作用域；let/const/class/function 归属最近词法块。 */
function findDeclarationScope(node: ts.Node, blockScoped: boolean): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (isFunctionScope(current)) {return current;}
    if (
      blockScoped &&
      (ts.isBlock(current) || ts.isModuleBlock(current) || ts.isCaseBlock(current) ||
        ts.isCatchClause(current) || ts.isForStatement(current) ||
        ts.isForInStatement(current) || ts.isForOfStatement(current))
    ) {
      return current;
    }
    if (ts.isSourceFile(current)) {return current;}
    current = current.parent;
  }
  return null;
}

/** 参数声明固定归属其直接函数式父节点。 */
function findFunctionScope(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (isFunctionScope(current)) {return current;}
    current = current.parent;
  }
  return null;
}

/** 使用公开 AST guards 识别拥有独立 var/参数作用域的函数式节点。 */
function isFunctionScope(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);
}

/** TypeScript Node 起止位置天然使用 UTF-16 code-unit 半开区间。 */
function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): SourceRangeV1 {
  return Object.freeze({ end: node.end, start: node.getStart(sourceFile) });
}

/** 构造不含绝对路径或源码正文的稳定提示。 */
function createLiteralDiagnostic(
  code: "MODULE_DYNAMIC_SPECIFIER_NOT_LITERAL" | "MODULE_REQUIRE_SPECIFIER_NOT_LITERAL",
  path: string,
  normalizedRange: SourceRangeV1,
  suggestedAction: string,
): AnalysisDiagnosticV1 {
  return Object.freeze({ code, normalizedRange, path, severity: "warning", suggestedAction });
}
