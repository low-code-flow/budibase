import { Readable } from "stream"
import type { Body } from "undici"

export const toNodeReadable = (
  body: Body | null
): NodeJS.ReadableStream => {
  if (!body) {
    throw new Error("Response body is empty")
  }
  if (typeof (body as any).pipe === "function") {
    return body as unknown as NodeJS.ReadableStream
  }
  return Readable.fromWeb(body as unknown as ReadableStream)
}
