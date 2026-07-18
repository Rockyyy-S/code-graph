# IMPLEMENTATION-GUIDE 最终文字审校

| Original Text | Revised Text | Changes |
| --- | --- | --- |
| 有客户端连接时至多每 5 分钟完成一轮有界对账，显式 rebuild/check/impact/export 先对账。 | 有客户端连接时，每轮对账完成后至多 5 分钟启动下一轮，显式 rebuild/check/impact/export 先对账。 | 与架构脊柱的调度保证一致，避免把“启动间隔上限”误写成无法保证的“完成周期上限”。 |

除上项外，未发现影响理解的表述问题；技术术语、代码块与结构标记按规则保留。
