/**
 * 在 Vitest 运行结束时拒绝所有被跳过的测试。
 *
 * 检测到静态或动态跳过时，报告器输出对应测试位置，并将进程退出码设置为失败。
 */
export default class FailOnSkippedReporter {
  /**
   * 检查测试模块中的跳过项并传播失败状态。
   *
   * 参数 `testModules` 是 Vitest 提供的测试模块集合；此方法不返回结果。
   */
  onTestRunEnd(testModules) {
    const skipped = testModules.flatMap((testModule) => [
      ...testModule.children.allTests("skipped"),
    ]);

    for (const testCase of skipped) {
      console.error(
        `${testCase.module.relativeModuleId}: Skipped test is forbidden (${testCase.fullName}). Fix: make the test execute with real assertions or keep a deliberate failure fixture under tests/fixtures.`,
      );
    }

    if (skipped.length > 0) {
      process.exitCode = 1;
    }
  }
}
