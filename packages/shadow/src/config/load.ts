import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { defaultConfig } from "./defaults.js";
import { ShadowConfigSchema, type ShadowConfig } from "./schema.js";

export interface LoadedConfig {
  config: ShadowConfig;
  sources: string[];
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override ?? base;
  }

  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? mergeDeep(merged[key], value) : value;
  }
  return merged;
}

async function readYamlIfExists(path: string): Promise<unknown | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  const source = await readFile(path, "utf8");
  return YAML.parse(source) as unknown;
}

export async function loadConfig(workspaceRoot: string): Promise<LoadedConfig> {
  const userPath = resolve(homedir(), ".config/shadow/config.yaml");
  const repoPath = resolve(workspaceRoot, ".shadow/config.yaml");
  const policyPath = resolve(workspaceRoot, ".shadow/policy.yaml");

  let merged: unknown = defaultConfig;
  const sources: string[] = [];

  for (const path of [userPath, repoPath]) {
    const parsed = await readYamlIfExists(path);
    if (parsed !== undefined) {
      merged = mergeDeep(merged, parsed);
      sources.push(path);
    }
  }

  const policy = await readYamlIfExists(policyPath);
  if (policy !== undefined) {
    merged = mergeDeep(merged, { approvals: policy });
    sources.push(policyPath);
  }

  return {
    config: ShadowConfigSchema.parse(merged),
    sources
  };
}

export function renderDefaultConfig(): string {
  return YAML.stringify(defaultConfig);
}

export function renderDefaultPolicy(): string {
  return YAML.stringify(defaultConfig.approvals);
}
