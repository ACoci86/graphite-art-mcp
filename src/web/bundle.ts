/**
 * Fetches the pre-built, patched Graphite web app (a `.tar.gz` published on GitHub Releases) into the per-user cache,
 * once per connector version, so users never need a Rust toolchain. Verifies an optional SHA-256, extracts atomically,
 * and tolerates archives that wrap the site in a single top-level folder.
 */

import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { extract } from "tar";

export interface BundleOptions {
	url: string;
	sha256?: string | undefined;
	cacheDir: string;
	/** Bundles are cached per connector version, because each release pins a Graphite commit and bridge version. */
	version: string;
	log: (message: string) => void;
	/** Override for tests. */
	fetchImpl?: typeof fetch;
}

/** Returns the directory containing `index.html`, downloading and extracting the bundle when it is not cached yet. */
export async function ensureWebBundle(options: BundleOptions): Promise<string> {
	const targetDir = path.join(options.cacheDir, "web", options.version);
	if (await isFile(path.join(targetDir, "index.html"))) return targetDir;

	const downloads = path.join(options.cacheDir, "downloads");
	await fs.mkdir(downloads, { recursive: true });
	const archive = path.join(downloads, `graphite-web-${options.version}.tar.gz`);
	const staging = `${targetDir}.partial-${process.pid}`;

	try {
		await download(options, archive);
		await fs.rm(staging, { recursive: true, force: true });
		await fs.mkdir(staging, { recursive: true });
		await extract({ file: archive, cwd: staging });
		const siteRoot = await findSiteRoot(staging);
		if (!siteRoot) throw new Error(`The bundle from ${options.url} does not contain an index.html.`);
		await fs.rm(targetDir, { recursive: true, force: true });
		await fs.mkdir(path.dirname(targetDir), { recursive: true });
		await fs.rename(siteRoot, targetDir);
		options.log(`Graphite web app installed at ${targetDir}`);
		return targetDir;
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
		await fs.rm(archive, { force: true });
	}
}

async function download(options: BundleOptions, archive: string): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	options.log(`downloading Graphite web app from ${options.url}`);
	const response = await fetchImpl(options.url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Could not download ${options.url}: HTTP ${response.status} ${response.statusText}`.trim());
	}
	const hash = createHash("sha256");
	let received = 0;
	let lastReport = 0;
	const total = Number(response.headers.get("content-length") ?? 0);
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			received += chunk.length;
			if (received - lastReport > 8 * 1024 * 1024) {
				lastReport = received;
				options.log(`  ${(received / 1024 / 1024).toFixed(0)} MB${total ? ` of ${(total / 1024 / 1024).toFixed(0)} MB` : ""}`);
			}
			callback(null, chunk);
		},
	});
	await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counter, createWriteStream(archive));
	const digest = hash.digest("hex");
	if (options.sha256 && digest !== options.sha256) {
		throw new Error(`Downloaded bundle SHA-256 ${digest} does not match the expected ${options.sha256}.`);
	}
	options.log(`downloaded ${(received / 1024 / 1024).toFixed(1)} MB (sha256 ${digest.slice(0, 12)}…)`);
}

/** The archive may contain the site at its root or inside one wrapping folder (`tar -czf x.tgz dist`). */
async function findSiteRoot(dir: string): Promise<string | undefined> {
	if (await isFile(path.join(dir, "index.html"))) return dir;
	const entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory());
	if (entries.length === 1) {
		const inner = path.join(dir, entries[0]!.name);
		if (await isFile(path.join(inner, "index.html"))) return inner;
	}
	return undefined;
}

async function isFile(file: string): Promise<boolean> {
	try {
		return (await fs.stat(file)).isFile();
	} catch {
		return false;
	}
}
