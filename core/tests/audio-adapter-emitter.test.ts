import { describe, expect, it, vi } from "vitest";
import { createAudioAdapterEmitter } from "../src/player/audio-adapter";

describe("createAudioAdapterEmitter", () => {
  it("calls only the handlers subscribed to the emitted event", () => {
    const emitter = createAudioAdapterEmitter();
    const onPlay = vi.fn();
    const onPause = vi.fn();
    emitter.on("play", onPlay);
    emitter.on("pause", onPause);
    emitter.emit("play");
    expect(onPlay).toHaveBeenCalledOnce();
    expect(onPause).not.toHaveBeenCalled();
    emitter.emit("ended");
  });

  it("unsubscribes a handler without disturbing the others", () => {
    const emitter = createAudioAdapterEmitter();
    const kept = vi.fn();
    const removed = vi.fn();
    emitter.on("timeupdate", kept);
    const off = emitter.on("timeupdate", removed);
    off();
    off();
    emitter.emit("timeupdate");
    expect(kept).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
  });

  it("subscribes the same handler once", () => {
    const emitter = createAudioAdapterEmitter();
    const handler = vi.fn();
    emitter.on("seeked", handler);
    emitter.on("seeked", handler);
    emitter.emit("seeked");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("drops every subscription on clear but accepts new ones", () => {
    const emitter = createAudioAdapterEmitter();
    const before = vi.fn();
    const off = emitter.on("play", before);
    emitter.clear();
    emitter.emit("play");
    expect(before).not.toHaveBeenCalled();
    off();
    const after = vi.fn();
    emitter.on("play", after);
    emitter.emit("play");
    expect(after).toHaveBeenCalledOnce();
  });
});
