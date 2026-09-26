/** Which build is the reader looking at. The two are different products, not
 * one product with a wider or narrower window: a browser reader has no
 * machine of their own that any of these routes can reach. */
export type HostBuild = "browser" | "desktop";

/** Read the build off the capability set rather than off `window.ogb`.
 *
 * The preload marker is a second, independent platform guess that can
 * disagree with the capability the server and the main process already
 * agree on, and it is a synchronous read of a global. `host.label` is the
 * same value every other surface branches on, and it is already correct
 * before the async capability fetch resolves: the browser fallback labels
 * the host "Browser" and the Electron fallback labels it from the
 * platform, so a surface that reads this never flashes the wrong build.
 *
 * The sibling field `localComputer.available` is deliberately NOT the test.
 * It is false in the initial capabilities of EVERY build until
 * getCapabilities() answers, and it stays false on a desktop where the user
 * has simply not enabled computer access — so gating on it would hide the
 * Local VM surface from exactly the people who came to switch it on. */
export function hostBuild(capabilities: DesktopCapabilities): HostBuild {
  return capabilities.host.label === "Browser" ? "browser" : "desktop";
}

/** A settings section that acts on the reader's own machine: a container
 * runtime started through /api/local-computer, or an SSH host named in the
 * reader's ~/.ssh/config. On a hosted deployment both of those resolve
 * against the SERVER — so a browser is offered a button that starts
 * containers on someone else's production host, or asks it to read a
 * config file the reader does not have. Neither is a preference that
 * happens to live in the wrong place; both are the wrong machine.
 *
 * `localFirst` is the one section that keeps its own historical test: the
 * Electron preload marker, read synchronously, because "is the desktop
 * shell rendering at all" is a question about the shell rather than about
 * any capability. */
export function settingsSectionAllowed(sectionId: string, build: HostBuild, hasPreload: boolean): boolean {
  if (sectionId === "localFirst") return hasPreload;
  if (sectionId === "computer") return build === "desktop";
  return true;
}

/** A one-click repair that starts containers and pulls a desktop image on
 * whichever machine answers /api/local-computer. Same reason as above: on a
 * browser that is the server, so the repair would act on a host the reader
 * does not own. Switching a bot to the cloud computer is a bot setting and
 * stays available in both builds. */
export function turnFixAllowed(action: string, build: HostBuild): boolean {
  if (action === "open-vm-settings") return build === "desktop";
  return true;
}

/** A section the deployment operator alone can open. `/api/people` lists
 * every account on a hosted server, so it answers 403 to anyone else — not
 * because the request was wrong, but because this reader does not administer
 * the deployment. That is a permanent condition, so rendering the section
 * means a nav entry whose only possible outcome is a red error. Hide it
 * instead.
 *
 * This is a different axis from the build. A desktop install and a hosted
 * operator both pass, and a hosted non-operator is the only case excluded;
 * the default is true so a config that predates the flag, or the window
 * before it loads, still offers the section rather than blinking it out. */
export function operatorSectionAllowed(sectionId: string, isOperator: boolean | undefined): boolean {
  if (sectionId === "people") return isOperator !== false;
  return true;
}
