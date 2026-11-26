import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { guardBrokenPipe } from "../src/stdout-pipe.js";

class FakeStream extends EventEmitter {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe("guardBrokenPipe", () => {
  it("passes writes through until the reader closes, then drops them", () => {
    const stream = new FakeStream();
    const writer = guardBrokenPipe(stream);

    writer.write("first\n");
    expect(writer.readerClosed).toBe(false);
    expect(() => stream.emit("error", errnoError("EPIPE"))).not.toThrow();
    writer.write("second\n");

    expect(writer.readerClosed).toBe(true);
    expect(stream.chunks).toEqual(["first\n"]);
  });

  it("rethrows stream errors other than EPIPE", () => {
    const stream = new FakeStream();
    const writer = guardBrokenPipe(stream);
    const failure = errnoError("ENOSPC");

    expect(() => stream.emit("error", failure)).toThrow(failure);
    expect(() => stream.emit("error", null)).toThrow();
    writer.write("still written\n");

    expect(writer.readerClosed).toBe(false);
    expect(stream.chunks).toEqual(["still written\n"]);
  });

  it("installs one listener per stream and shares its state", () => {
    const stream = new FakeStream();
    const first = guardBrokenPipe(stream);
    const second = guardBrokenPipe(stream);

    expect(second).toBe(first);
    expect(stream.listenerCount("error")).toBe(1);
    stream.emit("error", errnoError("EPIPE"));
    second.write("dropped\n");
    expect(stream.chunks).toEqual([]);
  });
});
