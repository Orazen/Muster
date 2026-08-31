export interface PendingTeamImport {
  manifest: unknown;
  name: string;
  description: string;
  members: Array<{ name: string; title: string }>;
}

/** JSON as decoded from an uploaded team file — the only shapes it can hold. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** True only for primitive strings — what JSON decoding yields for text fields. */
const isText = <T>(value: T): value is T & string => String(value) === value;

/** A string-keyed JSON object (arrays are JSON values, not records). */
const isJsonRecord = (value: JsonValue): value is { [key: string]: JsonValue } =>
  value instanceof Object && !Array.isArray(value);

/** Small client-side preview only; the server remains the trust boundary. */
export function teamImportPreview(manifest: JsonValue): PendingTeamImport {
  if (!isJsonRecord(manifest)) throw new Error("This file does not contain a team.");
  if (manifest.format !== "muster.team") throw new Error("This is not an Muster team file.");
  if (manifest.version !== 1 && manifest.version !== 2) {
    throw new Error(`Team file version ${String(manifest.version)} is not supported.`);
  }
  const team = manifest.team;
  if (!isJsonRecord(team)) throw new Error("This team file is missing its team definition.");
  if (!isText(team.name) || !team.name.trim()) throw new Error("This team does not have a name.");
  if (!Array.isArray(team.members) || team.members.length === 0) {
    throw new Error("This team has no members.");
  }
  if (team.members.length > 200) throw new Error("This team has too many members.");
  const members = team.members.map((member, index) => {
    if (!isJsonRecord(member)) throw new Error(`Team member ${index + 1} is invalid.`);
    if (!isText(member.name) || !member.name.trim()) {
      throw new Error(`Team member ${index + 1} does not have a name.`);
    }
    return {
      name: member.name.trim(),
      title: isText(member.title) ? member.title.trim() : "",
    };
  });
  return {
    manifest,
    name: team.name.trim(),
    description: isText(team.description) ? team.description.trim() : "",
    members,
  };
}
