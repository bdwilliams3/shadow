import { contextSelectAction, contextVerifyAction } from "./actions/context.js";
import { deployExecuteAction, deployRollbackAction } from "./actions/deploy.js";
import { gitStatusAction } from "./actions/git.js";
import { patchApplyAction, patchCheckAction } from "./actions/patch.js";
import { testAction, typecheckAction } from "./actions/quality.js";
import { repositoryInspectAction } from "./actions/repository.js";
import { dependencyScanAction, secretScanAction } from "./actions/security.js";
import { testSelectionAction } from "./actions/tests.js";
import { ActionRegistry } from "./registry.js";

export function createDefaultActionRegistry(): ActionRegistry {
  return new ActionRegistry()
    .register(contextSelectAction)
    .register(contextVerifyAction)
    .register(deployExecuteAction)
    .register(deployRollbackAction)
    .register(repositoryInspectAction)
    .register(dependencyScanAction)
    .register(secretScanAction)
    .register(gitStatusAction)
    .register(patchCheckAction)
    .register(patchApplyAction)
    .register(testAction)
    .register(testSelectionAction)
    .register(typecheckAction);
}
