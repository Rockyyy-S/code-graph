import {
  connectToGraphService,
  createGraphServiceProcessLauncher,
} from "../../packages/service-client/dist/index.js";

const source = process.env.CODEGRAPH_TEST_CLIENT_CONFIG;
if (source === undefined) {
  throw new Error("缺少客户端进程测试配置。");
}
const config = JSON.parse(source);
const launcher = createGraphServiceProcessLauncher({
  args: [config.graphServiceEntry],
  command: process.execPath,
});
const client = await connectToGraphService({
  cacheRoot: config.cacheRoot,
  clientVersion: "0.0.0-process-test",
  indexingRoot: config.indexingRoot,
  launcher,
  pollIntervalMs: 10,
  startTimeoutMs: 3_000,
  trust: { isTrusted: true },
});
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
