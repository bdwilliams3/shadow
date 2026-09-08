import { describe, expect, it } from "vitest";
import { parseInteractiveInput } from "../src/cli/interactive.js";

describe("interactive input parsing", () => {
  it("treats bare and slash command words as local commands", () => {
    expect(parseInteractiveInput("models")).toEqual({
      kind: "command",
      command: "models",
      args: []
    });
    expect(parseInteractiveInput("models/")).toEqual({
      kind: "command",
      command: "models",
      args: []
    });
    expect(parseInteractiveInput("/models")).toEqual({
      kind: "command",
      command: "models",
      args: []
    });
  });

  it("exits on ordinary exit words without spending a run", () => {
    expect(parseInteractiveInput("exit")).toEqual({ kind: "exit" });
    expect(parseInteractiveInput("/exit")).toEqual({ kind: "exit" });
    expect(parseInteractiveInput("quit")).toEqual({ kind: "exit" });
  });

  it("does not turn a single unknown token into a model-backed request", () => {
    expect(parseInteractiveInput("src/")).toMatchObject({ kind: "incomplete" });
    expect(parseInteractiveInput("fix")).toMatchObject({ kind: "incomplete" });
  });

  it("accepts a real sentence as a request", () => {
    expect(parseInteractiveInput("fix the models command")).toEqual({
      kind: "request",
      request: "fix the models command",
      decision: "start_coding"
    });
    expect(parseInteractiveInput("start coding")).toMatchObject({
      kind: "request",
      decision: "start_coding"
    });
  });

  it("keeps conversational questions out of the lifecycle", () => {
    expect(parseInteractiveInput("hello what are your capabilities?")).toEqual({
      kind: "chat",
      message: "hello what are your capabilities?",
      decision: "keep_thinking"
    });
    expect(parseInteractiveInput("what can we do here?")).toMatchObject({
      kind: "chat",
      decision: "keep_thinking"
    });
  });

  it("routes steering words without starting a run", () => {
    expect(parseInteractiveInput("btw keep this read-only")).toEqual({
      kind: "command",
      command: "btw",
      args: ["keep", "this", "read-only"]
    });
    expect(parseInteractiveInput("/steer inspect before coding")).toEqual({
      kind: "command",
      command: "steer",
      args: ["inspect", "before", "coding"]
    });
  });
});
