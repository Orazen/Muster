// This must be the first side-effect import in main. Import only Electron,
// Node builtins and the profile helper before app modules capture paths.
import { app } from "electron";
import { configureProfilePaths } from "./profile-config.mjs";

export const desktopProfile = configureProfilePaths({ app });
