import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DEFAULT_UPDATE_DIR = "/Volumes/ModelX/Apps/Pings-v2/artifacts";
const updateDir = process.env.PINGS_UPDATE_DIR || DEFAULT_UPDATE_DIR;
const tauriConfigPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  const tauriConfig = await readJson(tauriConfigPath);
  const version = process.env.PINGS_UPDATE_VERSION || tauriConfig.version;
  const notes = process.env.PINGS_UPDATE_NOTES || `Local test build ${version}`;
  const baseUrl = (process.env.PINGS_UPDATE_BASE_URL || `http://${os.hostname()}:8123`).replace(/\/+$/, "");

  await fs.mkdir(updateDir, { recursive: true });

  const bundles = [
    {
      platformKey: "darwin-aarch64",
      sourceTar: path.join(
        projectRoot,
        "src-tauri",
        "target",
        "aarch64-apple-darwin",
        "release",
        "bundle",
        "macos",
        "Pings.app.tar.gz",
      ),
      sourceSig: path.join(
        projectRoot,
        "src-tauri",
        "target",
        "aarch64-apple-darwin",
        "release",
        "bundle",
        "macos",
        "Pings.app.tar.gz.sig",
      ),
      outputTar: `Pings_${version}_aarch64_updater.tar.gz`,
      outputSig: `Pings_${version}_aarch64_updater.tar.gz.sig`,
    },
    {
      platformKey: "darwin-x86_64",
      sourceTar: path.join(
        projectRoot,
        "src-tauri",
        "target",
        "x86_64-apple-darwin",
        "release",
        "bundle",
        "macos",
        "Pings.app.tar.gz",
      ),
      sourceSig: path.join(
        projectRoot,
        "src-tauri",
        "target",
        "x86_64-apple-darwin",
        "release",
        "bundle",
        "macos",
        "Pings.app.tar.gz.sig",
      ),
      outputTar: `Pings_${version}_x64_updater.tar.gz`,
      outputSig: `Pings_${version}_x64_updater.tar.gz.sig`,
    },
  ];

  const platforms = {};
  const copied = [];

  for (const bundle of bundles) {
    const hasTar = await fileExists(bundle.sourceTar);
    const hasSig = await fileExists(bundle.sourceSig);
    if (!hasTar || !hasSig) {
      // Skip platform if build output is missing.
      continue;
    }

    const destTar = path.join(updateDir, bundle.outputTar);
    const destSig = path.join(updateDir, bundle.outputSig);
    await fs.copyFile(bundle.sourceTar, destTar);
    await fs.copyFile(bundle.sourceSig, destSig);

    const signature = (await fs.readFile(destSig, "utf8")).trim();
    platforms[bundle.platformKey] = {
      url: `${baseUrl}/${bundle.outputTar}`,
      signature,
    };
    copied.push(bundle.platformKey);
  }

  if (copied.length === 0) {
    throw new Error("No updater bundles found. Build at least one target first.");
  }

  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };

  const latestPath = path.join(updateDir, "latest.json");
  await fs.writeFile(latestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`[updates] prepared ${copied.length} platform(s): ${copied.join(", ")}`);
  console.log(`[updates] wrote ${latestPath}`);
  console.log(`[updates] base URL: ${baseUrl}`);
}

main().catch((error) => {
  console.error("[updates] prepare failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
