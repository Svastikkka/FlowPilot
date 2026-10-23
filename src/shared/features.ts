// Capability registry. Future premium features (advanced logic, bulk
// execution, reusable libraries, advanced debugging) are declared here so a
// local licence check can be introduced in one place without a backend.
// In this version every feature is available and nothing is restricted.

export type Feature = 'core' | 'advancedLogic' | 'bulkExecution' | 'workflowLibraries' | 'advancedDebugging';

export function isFeatureEnabled(_feature: Feature): boolean {
  return true;
}
