import type { ActionDefinition, ActionManifest } from "./types.js";
import { ActionManifestSchema } from "./types.js";

export class ActionRegistry {
  private readonly definitions = new Map<string, ActionDefinition>();

  register<TInput, TOutput>(definition: ActionDefinition<TInput, TOutput>): this {
    const manifest = ActionManifestSchema.parse(definition.manifest);
    if (this.definitions.has(manifest.id)) {
      throw new Error(`Action ${manifest.id} is already registered`);
    }
    this.definitions.set(manifest.id, { ...definition, manifest } as ActionDefinition);
    return this;
  }

  get(actionId: string): ActionDefinition | undefined {
    return this.definitions.get(actionId);
  }

  list(): ActionManifest[] {
    return [...this.definitions.values()]
      .map((definition) => definition.manifest)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
