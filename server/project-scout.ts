// Project Scout — read a folder, describe the project in it, and propose a
// starting lineup of agents. Ported from OpenMausBot's project-scout and
// adapted to Muster's bot model: suggestions are plain member shapes the UI
// turns into real bots through the existing create endpoints. The scout
// reads, it never writes — and it reads bounded: a handful of well-known
// files by name, top-level directory listings, and nothing recursive. A
// folder full of surprises must cost milliseconds, not minutes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

export type ScoutRole =
  | "frontend"
  | "backend"
  | "mobile"
  | "data"
  | "testing"
  | "infra"
  | "docs";

export interface ProjectSignal {
  role: ScoutRole;
  /** the files and dependencies that argued for this role: shown to the
   * human reviewing the suggestion, and quoted in the suggested member's
   * description — which becomes persona text and reaches the provider */
  evidence: string[];
}

export interface ProjectProfile {
  /** README h1 > package name > folder name */
  name: string;
  /** README first paragraph > package description > "" */
  summary: string;
  /** display chips: languages, frameworks, notable tooling */
  stacks: string[];
  signals: ProjectSignal[];
}

export interface SuggestedMember {
  name: string;
  title: string;
  description: string;
  color: string;
}

export interface TeamSuggestion {
  roomName: string;
  members: SuggestedMember[];
  /** member name → the one-line reason it was suggested */
  reasons: Record<string, string>;
}

const pkgSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});

const MAX_FILE_BYTES = 256_000;
const MAX_DIR_ENTRIES = 400;

function readText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).slice(0, MAX_DIR_ENTRIES);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface PkgInfo {
  name?: string;
  description?: string;
  deps: Set<string>;
}

const emptyPkg = (): PkgInfo => ({ deps: new Set() });

function packageJson(cwd: string): PkgInfo {
  const raw = readText(join(cwd, "package.json"));
  if (!raw) return emptyPkg();
  try {
    // Decode at the boundary: package.json is external input, so it gets a
    // zod schema rather than ad-hoc typeof narrowing.
    const pkg = pkgSchema.parse(JSON.parse(raw));
    const deps = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);
    return { name: pkg.name, description: pkg.description, deps };
  } catch {
    return emptyPkg();
  }
}

/** README h1 and the first prose paragraph after it. Badge rows and heading
 * lines are skipped so the summary reads like a sentence, not markup. */
interface ReadmeInfo {
  title?: string;
  summary?: string;
}

function readme(cwd: string): ReadmeInfo {
  const raw =
    readText(join(cwd, "README.md")) ?? readText(join(cwd, "readme.md")) ?? readText(join(cwd, "README"));
  if (!raw) return {};
  let title: string | undefined;
  let summary: string | undefined;
  for (const line of raw.slice(0, 64_000).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      if (!title) title = trimmed.replace(/^#+\s*/, "").trim() || undefined;
      continue;
    }
    // badge rows, raw HTML, and blockquote callouts (warnings, notices) are
    // not the sentence that says what the project is
    if (trimmed.startsWith("[![") || trimmed.startsWith("![") || trimmed.startsWith("<") || trimmed.startsWith(">")) continue;
    // the summary is rendered as plain text; markdown emphasis would show
    // its asterisks
    summary = trimmed.replace(/[*_`]/g, "").slice(0, 1_000);
    break;
  }
  const info: ReadmeInfo = { title, summary };
  return info;
}

interface Detector {
  role: ScoutRole;
  deps: string[];
  paths: string[];
}

// Order is priority: when a suggestion has to be trimmed, the roles that
// define the project's shape survive over the ones that polish it.
const DETECTORS: Detector[] = [
  {
    role: "frontend",
    deps: ["react", "vue", "svelte", "next", "nuxt", "astro", "vite", "@angular/core", "solid-js"],
    paths: ["index.html", "vite.config.ts", "vite.config.js", "next.config.js", "next.config.ts"],
  },
  {
    role: "backend",
    deps: ["express", "fastify", "koa", "hono", "@nestjs/core", "django", "flask", "fastapi"],
    paths: ["server", "api", "go.mod"],
  },
  {
    role: "mobile",
    deps: ["react-native", "expo"],
    paths: ["ios", "android", "pubspec.yaml"],
  },
  {
    role: "data",
    deps: ["prisma", "drizzle-orm", "knex", "sequelize", "typeorm", "mongoose", "pg", "mysql2", "better-sqlite3", "sqlalchemy"],
    paths: ["prisma", "migrations"],
  },
  {
    role: "testing",
    deps: ["vitest", "jest", "mocha", "@playwright/test", "cypress", "pytest"],
    paths: ["test", "tests", "__tests__", "e2e"],
  },
  {
    role: "infra",
    deps: [],
    paths: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml", ".github/workflows", "terraform", "helm"],
  },
  {
    role: "docs",
    deps: [],
    paths: ["docs", "mkdocs.yml"],
  },
];

const STACK_MARKERS: Array<{ stack: string; deps?: string[]; paths?: string[] }> = [
  { stack: "TypeScript", deps: ["typescript"], paths: ["tsconfig.json"] },
  { stack: "React", deps: ["react"] },
  { stack: "Vue", deps: ["vue"] },
  { stack: "Svelte", deps: ["svelte"] },
  { stack: "Next.js", deps: ["next"] },
  { stack: "Vite", deps: ["vite"] },
  { stack: "Node", paths: ["package.json"] },
  { stack: "Python", paths: ["pyproject.toml", "requirements.txt", "setup.py"] },
  { stack: "Rust", paths: ["Cargo.toml"] },
  { stack: "Go", paths: ["go.mod"] },
  { stack: "Ruby", paths: ["Gemfile"] },
  { stack: "PHP", paths: ["composer.json"] },
  { stack: "Java", paths: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  { stack: "Docker", paths: ["Dockerfile", "docker-compose.yml", "compose.yaml"] },
];

/** Read a folder and describe the project in it: name, one-line summary,
 * stack chips, and which team roles the contents argue for. Deterministic
 * and offline — the same folder always scouts to the same profile. */
export function scoutProject(cwd: string): ProjectProfile {
  const pkg = packageJson(cwd);
  const md = readme(cwd);
  const entries = new Set(listNames(cwd));

  // Python deps live in files, not a lockfile-adjacent field; a cheap
  // substring scan of the two conventional files covers the common cases.
  const pythonDeps = `${readText(join(cwd, "requirements.txt")) ?? ""}\n${readText(join(cwd, "pyproject.toml")) ?? ""}`.toLowerCase();
  const hasDep = (dep: string) => pkg.deps.has(dep) || (pythonDeps.length > 1 && pythonDeps.includes(dep));

  const pathEvidence = (path: string): string | null => {
    if (path.includes("/")) return isDir(join(cwd, path)) && listNames(join(cwd, path)).length > 0 ? `${path}/` : null;
    if (entries.has(path)) return isDir(join(cwd, path)) ? `${path}/` : path;
    return null;
  };

  const signals: ProjectSignal[] = [];
  for (const detector of DETECTORS) {
    const evidence: string[] = [];
    for (const dep of detector.deps) if (hasDep(dep)) evidence.push(dep);
    for (const path of detector.paths) {
      const found = pathEvidence(path);
      if (found) evidence.push(found);
    }
    // docs need substance: a folder with no markdown in it is not a docs site
    if (detector.role === "docs" && evidence.length > 0) {
      const hasMkdocs = evidence.includes("mkdocs.yml");
      const hasMarkdown = listNames(join(cwd, "docs")).some((name) => name.endsWith(".md"));
      if (!hasMkdocs && !hasMarkdown) continue;
    }
    if (evidence.length > 0) signals.push({ role: detector.role, evidence: evidence.slice(0, 6) });
  }

  const stacks: string[] = [];
  for (const marker of STACK_MARKERS) {
    const byDep = marker.deps?.some((dep) => hasDep(dep)) ?? false;
    const byPath = marker.paths?.some((path) => entries.has(path)) ?? false;
    if (byDep || byPath) stacks.push(marker.stack);
  }

  return {
    name: (md.title ?? pkg.name ?? basename(cwd)).slice(0, 100),
    summary: (md.summary ?? pkg.description ?? "").slice(0, 1_000),
    stacks,
    signals,
  };
}

interface RoleTemplate {
  name: string;
  title: string;
  color: string;
  describe: (profile: ProjectProfile, evidence: string[]) => string;
}

const stackLine = (profile: ProjectProfile) =>
  profile.stacks.length > 0 ? ` The stack: ${profile.stacks.join(", ")}.` : "";

const ROLE_TEMPLATES = {
  frontend: {
    name: "Pixel",
    title: "Frontend Builder",
    color: "pink",
    describe: (profile, evidence) =>
      `You build and refine the user interface of ${profile.name}.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Keep changes small, match the existing component patterns, and check what you built actually renders before calling it done.`,
  },
  backend: {
    name: "Forge",
    title: "Backend Builder",
    color: "blue",
    describe: (profile, evidence) =>
      `You own the server side of ${profile.name}: endpoints, business logic, and the contracts the frontend relies on.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Change behavior only alongside the tests that prove it.`,
  },
  mobile: {
    name: "Pocket",
    title: "Mobile Builder",
    color: "coral",
    describe: (profile, evidence) =>
      `You keep ${profile.name} working on phones: screens, navigation, and platform quirks.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Test on both platforms before declaring victory.`,
  },
  data: {
    name: "Schema",
    title: "Data Engineer",
    color: "teal",
    describe: (profile, evidence) =>
      `You own the data layer of ${profile.name}: models, migrations, and query performance.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Every migration ships with its rollback story.`,
  },
  testing: {
    name: "Probe",
    title: "Test Engineer",
    color: "green",
    describe: (profile, evidence) =>
      `You guard ${profile.name} with tests: you reproduce bugs before they are fixed and extend coverage where changes land.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. A red test you wrote is worth more than a green suite nobody trusts.`,
  },
  infra: {
    name: "Anchor",
    title: "Infra & CI",
    color: "orange",
    describe: (profile, evidence) =>
      `You keep ${profile.name} buildable, shippable, and observable: CI, containers, and deploy paths.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. Prefer boring, reproducible steps over clever ones.`,
  },
  docs: {
    name: "Quill",
    title: "Docs Writer",
    color: "purple",
    describe: (profile, evidence) =>
      `You keep the documentation of ${profile.name} truthful and current.${stackLine(profile)} Your turf shows up as ${evidence.join(", ")}. When code and docs disagree, you chase down which one is lying.`,
  },
} satisfies Record<ScoutRole, RoleTemplate>;

const LEAD: RoleTemplate = {
  name: "Compass",
  title: "Project Lead",
  color: "yellow",
  describe: (profile) =>
    `You coordinate work on ${profile.name}: break briefs into tasks for the team, keep everyone current, and review results before they count as done.${stackLine(profile)}${profile.summary ? ` The project, in its own words: ${profile.summary}` : ""}`,
};

/** at most the lead plus this many specialists — a suggestion is a starting
 * lineup, not a payroll */
const MAX_SUGGESTED_SPECIALISTS = 5;

/** Turn a scouted profile into a suggested lineup: a lead plus one member
 * per detected role. Suggesting is all this does — creating bots stays
 * behind the existing create endpoints and their human click. */
export function suggestTeam(profile: ProjectProfile): TeamSuggestion {
  const reasons: TeamSuggestion["reasons"] = {
    Compass: "Every project needs one member who briefs, splits, and reviews.",
  };

  const members: SuggestedMember[] = [
    {
      name: LEAD.name,
      title: LEAD.title,
      description: LEAD.describe(profile, []),
      color: LEAD.color,
    },
  ];
  for (const signal of profile.signals.slice(0, MAX_SUGGESTED_SPECIALISTS)) {
    const template = ROLE_TEMPLATES[signal.role];
    members.push({
      name: template.name,
      title: template.title,
      description: template.describe(profile, signal.evidence),
      color: template.color,
    });
    reasons[template.name] = `Detected via ${signal.evidence.join(", ")}.`;
  }
  // no signals at all → the project still gets a working pair of hands
  if (members.length === 1) {
    members.push({
      name: "Wrench",
      title: "Builder",
      description: `You do the hands-on work in ${profile.name}: read the folder, make the change, show the result.${stackLine(profile)}`,
      color: "blue",
    });
    reasons.Wrench = "No specific stack detected — a generalist covers the ground.";
  }

  const out: TeamSuggestion = { roomName: profile.name, members, reasons };
  return out;
}
