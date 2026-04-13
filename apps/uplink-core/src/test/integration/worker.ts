// Test worker entry point for integration tests
// Re-exports the main worker with test configuration

import type { Env } from "../../types";

// Re-export the main worker
export { default, SourceCoordinator, BrowserManagerDO, CollectionWorkflow, RetentionWorkflow } from "../../index";

// Export types for test environment
export type { Env };
