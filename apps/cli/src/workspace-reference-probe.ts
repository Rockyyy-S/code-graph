import type * as Contracts from "@codegraph/contracts";
import type * as ServiceClient from "@codegraph/service-client";

/**
 * 仅在编译阶段验证声明的工作区依赖可在全新检出中解析。
 */
type WorkspaceReferenceProbe = typeof Contracts | typeof ServiceClient;

export type { WorkspaceReferenceProbe };
