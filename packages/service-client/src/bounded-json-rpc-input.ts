import net from "node:net";
import { PassThrough } from "node:stream";

const MAX_JSON_RPC_HEADER_BYTES = 8 * 1024;
const MAX_JSON_RPC_FRAME_BYTES = 1024 * 1024;

/** 创建带帧头、正文大小与流背压限制的客户端 JSON-RPC 输入。 */
export function createBoundedJsonRpcInput(
  socket: net.Socket,
  onRejected: () => void = () => undefined,
): PassThrough {
  const input = new PassThrough({ highWaterMark: 64 * 1024 });
  let pendingHeader = Buffer.alloc(0);
  let remainingBodyBytes = 0;
  let rejected = false;
  const rejectFrame = (): void => {
    if (rejected) {
      return;
    }
    rejected = true;
    onRejected();
    input.destroy(new Error("JSON-RPC 响应违反客户端帧边界。"));
    socket.destroy();
  };
  const writeInput = (chunk: Buffer): void => {
    if (!input.write(chunk)) {
      socket.pause();
    }
  };
  const onData = (chunk: Buffer): void => {
    let pending = pendingHeader.byteLength === 0
      ? chunk
      : Buffer.concat([pendingHeader, chunk]);
    pendingHeader = Buffer.alloc(0);
    while (pending.byteLength > 0 && !rejected) {
      if (remainingBodyBytes > 0) {
        const consumed = Math.min(remainingBodyBytes, pending.byteLength);
        writeInput(pending.subarray(0, consumed));
        remainingBodyBytes -= consumed;
        pending = pending.subarray(consumed);
        continue;
      }
      const headerEnd = pending.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (pending.byteLength > MAX_JSON_RPC_HEADER_BYTES) {
          rejectFrame();
          return;
        }
        pendingHeader = Buffer.from(pending);
        return;
      }
      if (headerEnd + 4 > MAX_JSON_RPC_HEADER_BYTES) {
        rejectFrame();
        return;
      }
      const headerLines = pending.subarray(0, headerEnd).toString("ascii").split("\r\n");
      const parsedHeaders = headerLines.map((line) =>
        /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*([\t\x20-\x7e]*)$/u.exec(line));
      if (parsedHeaders.some((header) => header === null)) {
        rejectFrame();
        return;
      }
      const contentLengths = parsedHeaders.filter(
        (header) => header?.[1]?.toLowerCase() === "content-length",
      );
      if (contentLengths.length !== 1) {
        rejectFrame();
        return;
      }
      const rawLength = contentLengths[0]![2]!.trim();
      if (!/^\d+$/u.test(rawLength)) {
        rejectFrame();
        return;
      }
      const contentLength = Number(rawLength);
      if (!Number.isSafeInteger(contentLength) || contentLength > MAX_JSON_RPC_FRAME_BYTES) {
        rejectFrame();
        return;
      }
      writeInput(pending.subarray(0, headerEnd + 4));
      remainingBodyBytes = contentLength;
      pending = pending.subarray(headerEnd + 4);
    }
  };
  const onSocketError = (error: Error): void => {
    input.destroy(error);
  };
  const onSocketEnd = (): void => {
    if (pendingHeader.byteLength > 0 || remainingBodyBytes > 0) {
      rejectFrame();
      return;
    }
    input.end();
  };
  const onSocketClose = (): void => {
    socket.off("data", onData);
    socket.off("error", onSocketError);
    socket.off("end", onSocketEnd);
    if (!input.destroyed) {
      input.end();
    }
  };
  socket.on("data", onData);
  socket.on("error", onSocketError);
  socket.once("end", onSocketEnd);
  socket.once("close", onSocketClose);
  input.on("drain", () => socket.resume());
  return input;
}
