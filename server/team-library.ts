import { z } from "zod";

import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";
import { parseTeamMarkdown } from "./team-markdown.ts";
import { parseTeamManifest, type ParsedTeamManifest } from "./team-manifest.ts";

export const TEAM_LIBRARY_REPOSITORY = "https://github.com/tharunramagiri/muster-teams";
export const TEAM_LIBRARY_RAW_ROOT = "https://raw.githubusercontent.com/tharunramagiri/muster-teams/main";
export const TEAM_LIBRARY_CATALOG_URL = `${TEAM_LIBRARY_RAW_ROOT}/catalog.json`;

const MAX_CATALOG_BYTES = 256_000;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_README_BYTES = 200_000;

export interface TeamCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  manifest: string;
  readme: string;
  members: number;
  skills: string[];
  requires: { apps: string[] };
  /** Optional BotMRR-style enrichment (adopted field names, MIT repo).
   * Absent on older catalogs; present-but-malformed still throws — the
   * catalog is remote input and strictness is the contract. */
  outcome?: string;
  setupMinutes?: number;
  featured?: boolean;
  author?: { name: string; url?: string };
}

export interface TeamCatalog {
  format: "muster.catalog";
  version: 1;
  repositoryUrl: typeof TEAM_LIBRARY_REPOSITORY;
  teams: TeamCatalogEntry[];
}

type Fetcher = typeof fetch;

/** True only for primitive strings — what JSON decoding yields for text fields. */
const isText = <T>(value: T): value is T & string => String(value) === value;
/** True only for safe integers — what JSON decoding yields for count fields. */
const isCount = <T>(value: T): value is T & number => Number.isSafeInteger(value);
/** True only for primitive booleans — what JSON decoding yields for flag fields. */
const isFlag = <T>(value: T): value is T & boolean => Boolean(value) === value;

const isRecord = (value: JsonValue): value is JsonObject =>
  Boolean(value) && value instanceof Object && !Array.isArray(value);

function text(value: JsonValue, field: string, max: number): string {
  if (!isText(value) || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} is too long`);
  return normalized;
}

function relativeFile(value: JsonValue, field: string, suffix: string, prefix: string): string {
  const path = text(value, field, 300);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    !path.startsWith(prefix) ||
    !path.endsWith(suffix)
  ) {
    throw new Error(`${field} is not a safe catalog path`);
  }
  return path;
}

function stringList(value: JsonValue, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} is invalid`);
  return value.map((item, index) => text(item, `${field}[${index}]`, 100));
}

/** Validate the remotely maintained index before any of it reaches the renderer. */
export function parseTeamCatalog(value: JsonValue): TeamCatalog {
  if (!isRecord(value) || value.format !== "muster.catalog" || value.version !== 1) {
    throw new Error("The team library catalog is not supported");
  }
  if (!Array.isArray(value.teams) || value.teams.length > 100) {
    throw new Error("The team library catalog is invalid");
  }
  const slugs = new Set<string>();
  const teams = value.teams.map((raw, index): TeamCatalogEntry => {
    const field = `teams[${index}]`;
    if (!isRecord(raw)) throw new Error(`${field} is invalid`);
    const slug = text(raw.slug, `${field}.slug`, 80);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slugs.has(slug)) {
      throw new Error(`${field}.slug is invalid`);
    }
    slugs.add(slug);
    const prefix = `teams/${slug}/`;
    const requires = isRecord(raw.requires) ? raw.requires : {};
    const entry: TeamCatalogEntry = {
      slug,
      name: text(raw.name, `${field}.name`, 100),
      summary: text(raw.summary, `${field}.summary`, 300),
      category: text(raw.category, `${field}.category`, 80),
      manifest: relativeFile(raw.manifest, `${field}.manifest`, ".musterteam.json", prefix),
      readme: relativeFile(raw.readme, `${field}.readme`, "README.md", prefix),
      members:
        isCount(raw.members) && raw.members > 0 && raw.members <= 200
          ? raw.members
          : (() => { throw new Error(`${field}.members is invalid`); })(),
      skills: Array.isArray(raw.skills)
        ? raw.skills.map((skill, skillIndex) =>
            relativeFile(skill, `${field}.skills[${skillIndex}]`, "SKILL.md", `${prefix}skills/`),
          )
        : (() => { throw new Error(`${field}.skills is invalid`); })(),
      requires: { apps: stringList(requires.apps ?? [], `${field}.requires.apps`, 30) },
    };
    // Optional enrichment: absent stays absent; present must be well-formed.
    if (raw.outcome !== undefined) entry.outcome = text(raw.outcome, `${field}.outcome`, 200);
    if (raw.setupMinutes !== undefined) {
      if (!isCount(raw.setupMinutes) || raw.setupMinutes < 1 || raw.setupMinutes > 24 * 60) {
        throw new Error(`${field}.setupMinutes is invalid`);
      }
      entry.setupMinutes = raw.setupMinutes;
    }
    if (raw.featured !== undefined) {
      if (!isFlag(raw.featured)) throw new Error(`${field}.featured is invalid`);
      entry.featured = raw.featured;
    }
    if (raw.author !== undefined) {
      if (!isRecord(raw.author)) throw new Error(`${field}.author is invalid`);
      // zod at the boundary: the generic isText predicate does not narrow a
      // union member cleanly enough for the spread's inferred type.
      const authorUrl = z.string().regex(/^https:\/\//).max(300).safeParse(raw.author.url);
      const authorName = text(raw.author.name, `${field}.author.name`, 100);
      entry.author = authorUrl.success
        ? { name: authorName, url: authorUrl.data }
        : { name: authorName };
    }
    return entry;
  });
  return {
    format: "muster.catalog",
    version: 1,
    repositoryUrl: TEAM_LIBRARY_REPOSITORY,
    teams,
  };
}

async function fetchJson(url: string, maxBytes: number, fetcher: Fetcher): Promise<JsonValue> {
  const raw = await fetchTeamFile(url, maxBytes, fetcher);
  try {
    // SAFETY: parseJson is the boundary; its return is this module's JsonValue.
    return parseJson(raw) as JsonValue;
  } catch {
    throw new Error("GitHub did not return valid JSON");
  }
}

/** Fetch a remote team file as text (JSON or Markdown) with the same size
 * and host discipline as before. Malformed content is left to the caller's
 * parser so the error names the actual format problem. */
async function fetchTeamFile(url: string, maxBytes: number, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(url, {
    headers: { accept: "application/json, text/markdown, text/plain;q=0.9" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
    throw error;
  }
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote team file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote team file is too large");
  return raw;
}

export async function fetchTeamCatalog(fetcher: Fetcher = fetch): Promise<TeamCatalog> {
  return parseTeamCatalog(await fetchJson(TEAM_LIBRARY_CATALOG_URL, MAX_CATALOG_BYTES, fetcher));
}

export async function fetchLibraryTeam(slug: string, fetcher: Fetcher = fetch): Promise<ParsedTeamManifest> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("That team name is invalid");
  const catalog = await fetchTeamCatalog(fetcher);
  const entry = catalog.teams.find((team) => team.slug === slug);
  if (!entry) throw Object.assign(new Error("That library team was not found"), { status: 404 });
  const value = await fetchJson(`${TEAM_LIBRARY_RAW_ROOT}/${entry.manifest}`, MAX_MANIFEST_BYTES, fetcher);
  return parseTeamManifest(value);
}

/** Same discipline as fetchJson, for the markdown README: fixed host (the
 * path is catalog-validated relativeFile), no redirects, byte-capped. */
async function fetchText(url: string, maxBytes: number, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(url, {
    headers: { accept: "text/plain, text/markdown;q=0.9" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
  }
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote team file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote team file is too large");
  return raw;
}

export async function fetchLibraryTeamReadme(slug: string, fetcher: Fetcher = fetch): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("That team name is invalid");
  const catalog = await fetchTeamCatalog(fetcher);
  const entry = catalog.teams.find((team) => team.slug === slug);
  if (!entry) throw Object.assign(new Error("That library team was not found"), { status: 404 });
  return fetchText(`${TEAM_LIBRARY_RAW_ROOT}/${entry.readme}`, MAX_README_BYTES, fetcher);
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/** Resolve only public GitHub JSON files. Other hosts never reach server fetch. */
export function githubManifestUrls(input: string): string[] {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid GitHub URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Only public HTTPS GitHub links are supported");
  }
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!parts.every(safeSegment)) throw new Error("That GitHub path is not supported");

  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    if (parts.length === 2) {
      const [owner, repo] = parts;
      return [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/team.musterteam.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/team.musterteam.json`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/team.musterteam.json`,
      ];
    }
    if (parts.length >= 5 && (parts[2] === "blob" || parts[2] === "raw")) {
      const [owner, repo, , ref, ...file] = parts;
      if (!file.at(-1)?.endsWith(".json") && !file.at(-1)?.endsWith(".md")) throw new Error("The GitHub link must point to a .musterteam.json or .musterteam.md team file");
      return [`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file.join("/")}`];
    }
  }

  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    if (!parts.at(-1)?.endsWith(".json") && !parts.at(-1)?.endsWith(".md")) throw new Error("The GitHub link must point to a .musterteam.json or .musterteam.md team file");
    return [`https://raw.githubusercontent.com/${parts.join("/")}`];
  }

  throw new Error("Paste a GitHub repository or team file link");
}

export async function fetchGithubTeam(input: string, fetcher: Fetcher = fetch): Promise<ParsedTeamManifest> {
  const urls = githubManifestUrls(input);
  let lastError: unknown;
  for (const url of urls) {
    try {
      // .musterteam.md is the portable Markdown playbook dialect (same
      // schema, YAML frontmatter); anything else parses as the JSON form.
      const raw = await fetchTeamFile(url, MAX_MANIFEST_BYTES, fetcher);
      return url.endsWith(".md") ? parseTeamMarkdown(raw) : parseTeamManifest(parseJson(raw));
    } catch (error) {
      lastError = error;
      // SAFETY: fetchText stamps the errors it throws with a numeric HTTP status;
      // other failures here have no status property and read undefined.
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  throw lastError ?? new Error("No team.musterteam.json or team.musterteam.md file was found in that repository");
}
