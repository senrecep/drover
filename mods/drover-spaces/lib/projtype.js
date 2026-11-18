// A space's project type, from the names in its folder (one `ls -A`): pure, no host calls.
// The first rule that matches wins, in this order:
//   csharp, typescript / nodejs, go, rust, python, swift, dart, kotlin / gradle / java, ruby, php,
//   docker, git, folder.
// Only names are looked at, never file contents.

const lower = (n) => n.toLowerCase();
const ext = (...exts) => (names) => names.some((n) => exts.some((e) => lower(n).endsWith(e)));
const has = (...files) => (names) => files.some((f) => names.includes(f));

const RULES = [
  ["csharp", (n) => ext(".sln", ".slnx", ".csproj")(n) || has("Directory.Build.props")(n)],
  ["typescript", (n) => has("package.json")(n) && has("tsconfig.json")(n)],
  ["nodejs", has("package.json")],
  ["go", has("go.mod")],
  ["rust", has("Cargo.toml")],
  ["python", has("pyproject.toml", "requirements.txt", "setup.py")],
  ["swift", (n) => has("Package.swift")(n) || ext(".xcodeproj", ".xcworkspace")(n)],
  ["dart", has("pubspec.yaml")],
  ["kotlin", has("build.gradle.kts", "settings.gradle.kts")],
  ["gradle", has("build.gradle", "settings.gradle")],
  ["java", has("pom.xml")],
  ["ruby", has("Gemfile")],
  ["php", has("composer.json")],
  ["docker", has("Dockerfile")],
  ["git", has(".git")],
];

export const TYPES = Object.freeze([...RULES.map(([type]) => type), "folder"]);

/** The project type for a folder's entry names (as `ls -A` prints them, one per line). */
export function projectType(names) {
  const list = Array.isArray(names) ? names.filter((n) => typeof n === "string" && n) : [];
  for (const [type, test] of RULES) if (test(list)) return type;
  return "folder";
}

/** `ls -A` output to entry names. */
export const parseListing = (stdout) => String(stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const ICON_FILE = Object.freeze({
  csharp: "csharp", typescript: "typescript", nodejs: "nodejs", go: "go", rust: "rust", python: "python",
  swift: "swift", dart: "dart", kotlin: "kotlin", gradle: "gradle", java: "java", ruby: "ruby", php: "php",
  docker: "docker", git: "folder-git", folder: "folder",
});

export const ICON_DIR = "mods/drover-spaces/icons/project";

/** The icon (a path from the app's home folder) for a type; unknown types get the plain folder. */
export const typeIcon = (type) => `${ICON_DIR}/${ICON_FILE[type] ?? ICON_FILE.folder}.svg`;

const LABEL = Object.freeze({
  csharp: "C# project", typescript: "TypeScript project", nodejs: "Node.js project", go: "Go project",
  rust: "Rust project", python: "Python project", swift: "Swift project", dart: "Dart / Flutter project",
  kotlin: "Kotlin project", gradle: "Gradle project", java: "Java project", ruby: "Ruby project",
  php: "PHP project", docker: "Docker project", git: "Git repository", folder: "Folder",
});

export const typeLabel = (type) => LABEL[type] ?? LABEL.folder;

/** The cache key for a space's folder on its machine. */
export const typeKey = (machine, folder) => `${machine ?? ""}\u0000${folder ?? ""}`;

export const TYPE_TTL = 10 * 60_000;

/** Whether a cached entry ({type, at}) needs a fresh look. */
export const needsLook = (entry, now, ttl = TYPE_TTL) => !entry || !(now - entry.at < ttl);
