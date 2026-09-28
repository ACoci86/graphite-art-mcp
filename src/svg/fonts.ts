/**
 * Font registry for text outlining. Loads the bundled Liberation faces plus any `.ttf`/`.otf` files from user
 * directories, and picks the closest face for a CSS font-family list, weight and style.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

export interface LoadedFont {
	family: string;
	weight: number;
	italic: boolean;
	font: opentype.Font;
	file: string;
}

export interface FontChoice {
	font: opentype.Font;
	/** True when italic was requested but only an upright face exists; the caller applies a skew. */
	syntheticItalic: boolean;
}

/** Generic families and common metric-compatible names map onto the bundled faces. */
const ALIASES: Record<string, string> = {
	"sans-serif": "Liberation Sans",
	sans: "Liberation Sans",
	arial: "Liberation Sans",
	helvetica: "Liberation Sans",
	"helvetica neue": "Liberation Sans",
	"liberation sans": "Liberation Sans",
	"dejavu sans": "Liberation Sans",
	verdana: "Liberation Sans",
	"system-ui": "Liberation Sans",
	serif: "Liberation Serif",
	times: "Liberation Serif",
	"times new roman": "Liberation Serif",
	georgia: "Liberation Serif",
	"liberation serif": "Liberation Serif",
	monospace: "Liberation Mono",
	mono: "Liberation Mono",
	courier: "Liberation Mono",
	"courier new": "Liberation Mono",
	consolas: "Liberation Mono",
	menlo: "Liberation Mono",
	"liberation mono": "Liberation Mono",
};

export function bundledFontDir(): string {
	// dist/svg/fonts.js -> package root/fonts
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fonts");
}

export class FontRegistry {
	private constructor(readonly fonts: LoadedFont[]) {}

	static async load(directories: string[], log: (message: string) => void = () => undefined): Promise<FontRegistry> {
		const fonts: LoadedFont[] = [];
		for (const dir of directories) {
			let entries: string[];
			try {
				entries = await fs.readdir(dir);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!/\.(ttf|otf)$/i.test(name)) continue;
				const file = path.join(dir, name);
				try {
					const buffer = await fs.readFile(file);
					const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
					fonts.push({ family: familyOf(font, name), weight: weightOf(font), italic: italicOf(font), font, file });
				} catch (error) {
					log(`skipping font ${file}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		return new FontRegistry(fonts);
	}

	get empty(): boolean {
		return this.fonts.length === 0;
	}

	/** `families` is the parsed CSS font-family list, most preferred first. */
	pick(families: string[], weight: number, italic: boolean): FontChoice | undefined {
		if (this.fonts.length === 0) return undefined;
		const wanted = [...families.map(normalize), "sans-serif"];
		for (const family of wanted) {
			const target = ALIASES[family] ?? family;
			const candidates = this.fonts.filter((f) => normalize(f.family) === normalize(target) || normalize(f.family) === family);
			if (candidates.length === 0) continue;
			return choose(candidates, weight, italic);
		}
		return choose(this.fonts, weight, italic);
	}
}

function choose(candidates: LoadedFont[], weight: number, italic: boolean): FontChoice {
	const score = (f: LoadedFont): number => Math.abs(f.weight - weight) + (f.italic === italic ? 0 : 1000);
	const best = [...candidates].sort((a, b) => score(a) - score(b))[0]!;
	return { font: best.font, syntheticItalic: italic && !best.italic };
}

function normalize(name: string): string {
	return name.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

function familyOf(font: opentype.Font, fileName: string): string {
	const names = font.names as unknown as Record<string, Record<string, string> | undefined>;
	const preferred = names.preferredFamily?.en ?? names.fontFamily?.en;
	return preferred ?? fileName.replace(/\.(ttf|otf)$/i, "").replace(/[-_](Regular|Bold|Italic|BoldItalic)$/i, "");
}

function weightOf(font: opentype.Font): number {
	const os2 = (font.tables as Record<string, Record<string, number> | undefined>).os2;
	if (os2?.usWeightClass) return os2.usWeightClass;
	const sub = ((font.names as unknown as Record<string, Record<string, string> | undefined>).fontSubfamily?.en ?? "").toLowerCase();
	return sub.includes("bold") ? 700 : 400;
}

function italicOf(font: opentype.Font): boolean {
	const os2 = (font.tables as Record<string, Record<string, number> | undefined>).os2;
	if (os2?.fsSelection !== undefined) return (os2.fsSelection & 1) === 1;
	const sub = ((font.names as unknown as Record<string, Record<string, string> | undefined>).fontSubfamily?.en ?? "").toLowerCase();
	return sub.includes("italic") || sub.includes("oblique");
}
