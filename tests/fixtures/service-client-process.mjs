import { createGraphServiceProcessLauncher } from "../../packages/service-client/dist/index.js";
import { connectToGraphServiceWithCacheRootForTests } from "../../packages/service-client/dist/connection.js";

const source = process.env.CODEGRAPH_TEST_CLIENT_CONFIG;
if (source === undefined) {
  throw new Error("缺少客户端进程测试配置。");
}
const config = JSON.parse(source);
const launcher = createGraphServiceProcessLauncher({
  args: [config.graphServiceEntry],
  command: process.execPath,
});
const client = await connectToGraphServiceWithCacheRootForTests(
  {
    clientVersion: "0.0.0-process-test",
    indexingRoot: config.indexingRoot,
    launcher,
    pollIntervalMs: 10,
    startTimeoutMs: 10_000,
    trust: { isTrusted: true },
  },
  config.cacheRoot,
);
const status = await client.status();
process.stdout.write(
  `${JSON.stringify({
    endpointKind: client.metadata.endpointKind,
    pid: client.metadata.pid,
    serviceInstanceId: status.serviceInstanceId,
    statusEpoch: status.statusEpoch,
  })}\n`,
);
await client.close();
