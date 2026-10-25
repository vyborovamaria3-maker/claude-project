import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "./tginvite-events";

describe("EventEmitter", () => {
  it("emits and listens to events", () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on("test", handler);
    emitter.emit("test", { data: 123 });
    expect(handler).toHaveBeenCalledWith({ data: 123 });
  });

  it("supports multiple listeners", () => {
    const emitter = new EventEmitter();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    emitter.on("test", handler1);
    emitter.on("test", handler2);
    emitter.emit("test", null);
    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it("supports once listeners", () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.once("test", handler);
    emitter.emit("test", null);
    emitter.emit("test", null);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("removes listeners", () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();
    const unsub = emitter.on("test", handler);
    unsub();
    emitter.emit("test", null);
    expect(handler).not.toHaveBeenCalled();
  });

  it("removes all listeners", () => {
    const emitter = new EventEmitter();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    emitter.on("test", handler1);
    emitter.on("other", handler2);
    emitter.removeAllListeners("test");
    emitter.emit("test", null);
    emitter.emit("other", null);
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it("counts listeners", () => {
    const emitter = new EventEmitter();
    expect(emitter.listenerCount("test")).toBe(0);
    emitter.on("test", () => {});
    emitter.on("test", () => {});
    expect(emitter.listenerCount("test")).toBe(2);
  });

  it("handles errors in handlers gracefully", () => {
    const emitter = new EventEmitter();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    emitter.on("test", () => { throw new Error("fail"); });
    expect(() => emitter.emit("test", null)).not.toThrow();
    consoleSpy.mockRestore();
  });
});
