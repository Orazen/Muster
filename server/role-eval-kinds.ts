// Shared vocabulary only: importing a grader entry point into a bundled CLI
// would inline its executable main guard and run two commands at once.
export const roleNames = ["assistant", "coordinator", "specialist"] as const;
export type RoleName = (typeof roleNames)[number];
export const scenarioKinds = ["direct-answer", "grounded-answer", "delegation", "escalation"] as const;
export type ScenarioKind = (typeof scenarioKinds)[number];
