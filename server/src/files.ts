import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { FilePayload } from "./types.js";

const run = promisify(execFile);

export const expandHome = (path: string): string => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

// Texte d'un PDF avec pdftotext (poppler-utils) : -layout garde les colonnes des tableaux (relevés, factures).
export async function pdfText(data: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "firefox-jev-"));
  const file = join(dir, "document.pdf");
  try {
    await writeFile(file, data);
    const { stdout } = await run("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { maxBuffer: 64 * 1024 * 1024 });
    const pages = stdout.replace(/[ \t]+$/gm, "").split("\f").map((p) => p.trim());
    while (pages.length > 1 && !pages[pages.length - 1]) pages.pop();
    return pages.map((p, i) => (i ? `--- page ${i + 1} ---\n${p}` : p)).join("\n\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("pdftotext introuvable (paquet poppler-utils) : enregistrer le PDF avec browser_save, puis lire le fichier");
    }
    throw new Error(`Texte du PDF illisible : ${(err as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function downloadDir(): Promise<string> {
  try {
    const { stdout } = await run("xdg-user-dir", ["DOWNLOAD"]);
    if (stdout.trim()) return stdout.trim();
  } catch {}
  const downloads = join(homedir(), "Downloads");
  return existsSync(downloads) ? downloads : homedir();
}

// Extension ajoutée à un nom qui n'a pas la bonne (URL sans nom de fichier, par exemple).
const EXTENSIONS: Record<string, string> = { "application/pdf": ".pdf", "text/html": ".html" };

// Nom de fichier sans séparateur ni caractère de contrôle, avec l'extension qui correspond au type.
function safeName(name: string, type: string): string {
  const clean = name.replace(/[/\\\0-\x1f]/g, "_").replace(/^\.+/, "").trim().slice(0, 150) || "document";
  const ext = EXTENSIONS[type.split(";")[0].trim()];
  return ext && extname(clean).toLowerCase() !== ext ? clean + ext : clean;
}

const isDir = (path: string): Promise<boolean> => stat(path).then((s) => s.isDirectory(), () => false);

/**
 * Écrit le fichier dans dest : un dossier (le nom vient du site) ou un chemin de fichier. Par défaut, le dossier
 * Téléchargements. N'écrase jamais un fichier existant : ajoute (2), (3)... au nom. Renvoie le chemin écrit.
 */
export async function saveFile(file: FilePayload, dest?: string): Promise<string> {
  let dir: string;
  let name = safeName(file.name, file.type);
  if (!dest) {
    dir = await downloadDir();
  } else {
    const path = expandHome(dest);
    if (!isAbsolute(path)) throw new Error(`Chemin absolu attendu : ${dest}`);
    if (dest.endsWith("/") || (await isDir(path))) {
      dir = path;
    } else {
      dir = dirname(path);
      name = basename(path);
    }
  }
  await mkdir(dir, { recursive: true });
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const data = Buffer.from(file.data, "base64");
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      // wx : échoue si le fichier existe, sans course entre la vérification et l'écriture.
      await writeFile(path, data, { flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n === 100) throw err;
    }
  }
}
