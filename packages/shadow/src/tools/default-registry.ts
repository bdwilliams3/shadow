import { contextSelectAction, contextVerifyAction } from "./actions/context.js";
import { gitStatusAction } from "./actions/git.js";
import { patchApplyAction, patchCheckAction } from "./actions/patch.js";
import { testAction, typecheckAction } from "./actions/quality.js";
import { repositoryInspectAction } from "./actions/repository.js";
import { testSelectionAction } from "./actions/tests.js";
import { ActionRegistry } from "./registry.js";

export function createDefaultActionRegistry(): ActionRegistry {
  return new ActionRegistry()
    .register(contextSelectAction)
    .register(contextVerifyAction)
    .register(repositoryInspectAction)
    .register(gitStatusAction)
    .register(patchCheckAction)
    .register(patchApplyAction)
    .register(testAction)
    .register(testSelectionAction)
    .register(typecheckAction);
}
