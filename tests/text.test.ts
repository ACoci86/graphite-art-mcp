/** Text outlining against the bundled Liberation faces. */
import { describe, expect, it, beforeAll } from "vitest";
import { bundledFontDir, FontRegistry } from "../src/svg/fonts.js";
import { hasText, outlineText } from "../src/svg/outline-text.js";

let fonts: FontRegistry;
beforeAll(async () => {
	fonts = await FontRegistry.load([bundledFontDir()]);
});

/** Rough x extent of all path data in the markup, from absolute M/L coordinates. */
function xRange(svg: string): { min: number; max: number } {
	const xs: number[] = [];
	for (const d of svg.matchAll(/ d="([^"]+)"/g)) for (const m of d[1]!.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) xs.push(Number(m[1]));
	return { min: Math.min(...xs), max: Math.max(...xs) };
}

describe("font registry", () => {
	it("loads the bundled faces and maps generic families and aliases", () => {
		expect(fonts.empty).toBe(false);
		expect(fonts.fonts.map((f) => `${f.family}/${f.weight}`).sort()).toEqual([
			"Liberation Mono/400",
			"Liberation Mono/700",
			"Liberation Sans/400",
			"Liberation Sans/700",
			"Liberation Serif/400",
			"Liberation Serif/700",
		]);
		expect(fonts.pick(["Arial"], 700, false)?.font.names.fontFamily?.en).toBe("Liberation Sans");
		expect(fonts.pick(["Times New Roman", "serif"], 400, false)?.font.names.fontFamily?.en).toBe("Liberation Serif");
		expect(fonts.pick(["Consolas", "monospace"], 400, false)?.font.names.fontFamily?.en).toBe("Liberation Mono");
		expect(fonts.pick(["Comic Sans MS"], 400, false)?.font.names.fontFamily?.en).toBe("Liberation Sans");
		const italic = fonts.pick(["sans-serif"], 400, true)!;
		expect(italic.syntheticItalic).toBe(true);
	});
});

describe("outlineText", () => {
	it("replaces text with paths and keeps presentation attributes on a group", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><text x="10" y="40" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="24" letter-spacing="4" fill="#151515" transform="rotate(1)" id="caption">THE TEST</text></svg>';
		const result = outlineText(svg, fonts);
		expect(result.converted).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.svg).not.toMatch(/<text/);
		expect(result.svg).toMatch(/<g[^>]*fill="#151515"[^>]*>/);
		expect(result.svg).toMatch(/<g[^>]*transform="rotate\(1\)"/);
		expect(result.svg).toMatch(/<g[^>]*id="caption"/);
		expect(result.svg).not.toMatch(/font-|letter-spacing/);
		expect(result.svg).toMatch(/<path d="M/);
		const { min, max } = xRange(result.svg);
		expect(min).toBeGreaterThanOrEqual(9.5);
		// 8 characters at 24px bold with 4px tracking: comfortably wider than 100px, narrower than the whole canvas
		expect(max).toBeGreaterThan(100);
		expect(max).toBeLessThan(200);
	});

	it("honours text-anchor, style declarations, units and tspans", () => {
		const middle = outlineText('<svg xmlns="http://www.w3.org/2000/svg"><text x="200" y="50" text-anchor="middle" style="font-size:18pt;font-family:serif">Centered</text></svg>', fonts);
		const { min, max } = xRange(middle.svg);
		expect((min + max) / 2).toBeGreaterThan(190);
		expect((min + max) / 2).toBeLessThan(210);

		const end = outlineText('<svg xmlns="http://www.w3.org/2000/svg"><text x="300" y="50" text-anchor="end" font-size="20">Right</text></svg>', fonts);
		expect(xRange(end.svg).max).toBeLessThanOrEqual(300.5);

		const tspans = outlineText(
			'<svg xmlns="http://www.w3.org/2000/svg"><g font-size="20"><text x="10" y="30">Line one<tspan x="10" dy="24" fill="red">Line two</tspan> <tspan font-style="italic">tail</tspan></text></g></svg>',
			fonts,
		);
		expect(tspans.converted).toBe(1);
		const paths = tspans.svg.match(/<path /g) ?? [];
		expect(paths.length).toBe(3);
		expect(tspans.svg).toMatch(/<path [^>]*fill="red"/);
		expect(tspans.svg).toMatch(/skewX\(-12\)/);
	});

	it("leaves markup alone when there is no text, when parsing fails, or when no fonts are available", async () => {
		const plain = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
		expect(hasText(plain)).toBe(false);
		expect(outlineText(plain, fonts)).toEqual({ svg: plain, converted: 0, skipped: 0 });
		const broken = '<svg xmlns="http://www.w3.org/2000/svg"><text>oops</svg>';
		expect(outlineText(broken, fonts).svg).toBe(broken);
		const none = await FontRegistry.load(["/nonexistent/fonts"]);
		expect(none.empty).toBe(true);
		const withText = '<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="2">Hi</text></svg>';
		expect(outlineText(withText, none)).toEqual({ svg: withText, converted: 0, skipped: 1 });
		const empty = outlineText('<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="2">   </text></svg>', fonts);
		expect(empty.converted).toBe(0);
	});
});
