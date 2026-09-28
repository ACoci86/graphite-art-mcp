/**
 * Replaces `<text>` elements in SVG markup with outlined `<path>`s, because Graphite's web build has no fonts and
 * silently drops text. Handles the common subset: x/y, dx/dy, `<tspan>`, font-size (px/pt/em), font-family lists,
 * font-weight, font-style (synthetic italic), letter-spacing and text-anchor, whether given as attributes or in a
 * `style` attribute, inherited from ancestors. Presentation attributes such as fill, stroke, opacity and transform
 * are carried over to a `<g>` wrapping the generated paths.
 */

import { DOMParser, XMLSerializer, type Document, type Element, type Node } from "@xmldom/xmldom";
import type { FontRegistry } from "./fonts.js";

export interface OutlineResult {
	svg: string;
	/** Number of `<text>` elements replaced. */
	converted: number;
	/** Text elements left in place (no fonts available, or nothing renderable inside). */
	skipped: number;
}

interface TextStyle {
	families: string[];
	size: number;
	weight: number;
	italic: boolean;
	letterSpacing: number;
	anchor: "start" | "middle" | "end";
}

const TEXT_ONLY_ATTRIBUTES = new Set([
	"x",
	"y",
	"dx",
	"dy",
	"rotate",
	"textLength",
	"lengthAdjust",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"font-variant",
	"font-stretch",
	"font",
	"letter-spacing",
	"word-spacing",
	"text-anchor",
	"text-decoration",
	"dominant-baseline",
	"alignment-baseline",
	"baseline-shift",
	"xml:space",
	"writing-mode",
]);
const TEXT_ONLY_STYLE_PROPERTIES = /^(font(-[a-z]+)?|letter-spacing|word-spacing|text-anchor|text-decoration|dominant-baseline|alignment-baseline|baseline-shift|writing-mode|line-height)$/;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export function hasText(svg: string): boolean {
	return /<text[\s>]/i.test(svg);
}

export function outlineText(svg: string, fonts: FontRegistry): OutlineResult {
	if (!hasText(svg) || fonts.empty) return { svg, converted: 0, skipped: hasText(svg) ? 1 : 0 };
	let doc: Document;
	try {
		doc = new DOMParser({ onError: (level) => { if (level === "fatalError") throw new Error("parse error"); } }).parseFromString(svg, "image/svg+xml");
	} catch {
		return { svg, converted: 0, skipped: 1 };
	}
	const texts = Array.from(doc.getElementsByTagName("text"));
	let converted = 0;
	let skipped = 0;
	for (const text of texts) {
		const parent = text.parentNode;
		if (!parent) continue;
		const group = convertTextElement(doc, text, fonts);
		if (!group) {
			skipped += 1;
			continue;
		}
		parent.replaceChild(group, text);
		converted += 1;
	}
	if (converted === 0) return { svg, converted, skipped };
	return { svg: new XMLSerializer().serializeToString(doc), converted, skipped };
}

function convertTextElement(doc: Document, text: Element, fonts: FontRegistry): Element | undefined {
	const style = resolveStyle(text, undefined);
	const group = doc.createElementNS(text.namespaceURI, "g");
	for (const attr of Array.from(text.attributes)) {
		if (TEXT_ONLY_ATTRIBUTES.has(attr.name)) continue;
		if (attr.name === "style") {
			const kept = stripTextStyle(attr.value);
			if (kept) group.setAttribute("style", kept);
			continue;
		}
		group.setAttribute(attr.name, attr.value);
	}
	const cursor = { x: parseNumber(text.getAttribute("x")) ?? 0, y: parseNumber(text.getAttribute("y")) ?? 0 };
	const paths: Element[] = [];
	layoutRuns(doc, text, style, cursor, fonts, paths, true);
	if (paths.length === 0) return undefined;
	for (const p of paths) group.appendChild(p);
	return group;
}

/**
 * Walks the text content in document order. Each text node becomes one path; `<tspan>` may reposition the cursor
 * and override style. `trimStart` collapses leading whitespace at the very beginning of the element.
 */
function layoutRuns(doc: Document, element: Element, style: TextStyle, cursor: { x: number; y: number }, fonts: FontRegistry, out: Element[], trimStart: boolean): boolean {
	let atStart = trimStart;
	for (const child of Array.from(element.childNodes) as Node[]) {
		if (child.nodeType === TEXT_NODE) {
			let run = (child.nodeValue ?? "").replace(/\s+/g, " ");
			if (atStart) run = run.replace(/^ /, "");
			if (run.length === 0) continue;
			atStart = false;
			const path = renderRun(doc, element, run, style, cursor, fonts);
			if (path) out.push(path);
			continue;
		}
		if (child.nodeType === ELEMENT_NODE) {
			const el = child as Element;
			if (el.localName !== "tspan") continue;
			const x = parseNumber(el.getAttribute("x"));
			const y = parseNumber(el.getAttribute("y"));
			if (x !== undefined) cursor.x = x;
			if (y !== undefined) cursor.y = y;
			cursor.x += parseNumber(el.getAttribute("dx")) ?? 0;
			cursor.y += parseNumber(el.getAttribute("dy")) ?? 0;
			const childStyle = resolveStyle(el, style);
			const tspanStyleAttrs = presentationAttributes(el);
			const before = out.length;
			atStart = layoutRuns(doc, el, childStyle, cursor, fonts, out, atStart);
			// A tspan's own fill/stroke apply to the paths it produced
			for (const path of out.slice(before)) for (const [name, value] of tspanStyleAttrs) if (!path.hasAttribute(name)) path.setAttribute(name, value);
		}
	}
	return atStart;
}

function renderRun(doc: Document, element: Element, run: string, style: TextStyle, cursor: { x: number; y: number }, fonts: FontRegistry): Element | undefined {
	const choice = fonts.pick(style.families, style.weight, style.italic);
	if (!choice) return undefined;
	const options = { kerning: true, letterSpacing: style.size > 0 ? style.letterSpacing / style.size : 0 };
	const advance = choice.font.getAdvanceWidth(run, style.size, options);
	let x = cursor.x;
	if (style.anchor === "middle") x -= advance / 2;
	else if (style.anchor === "end") x -= advance;
	const baseline = cursor.y;
	const d = choice.font.getPath(run, x, baseline, style.size, options).toPathData(3);
	cursor.x += advance;
	if (!d) return undefined;
	const path = doc.createElementNS(element.namespaceURI, "path");
	path.setAttribute("d", d);
	if (choice.syntheticItalic) path.setAttribute("transform", `translate(${fmt(x)} ${fmt(baseline)}) skewX(-12) translate(${fmt(-x)} ${fmt(-baseline)})`);
	return path;
}

// --- style resolution ------------------------------------------------------------------------------------------------

function resolveStyle(element: Element, inherited: TextStyle | undefined): TextStyle {
	// Collect the ancestor chain (outermost first) so nearer declarations win; the inherited style already covers
	// ancestors of a tspan, so only look at the element itself in that case.
	const chain: Element[] = [];
	if (inherited) chain.push(element);
	else {
		let node: Node | null = element;
		while (node && node.nodeType === ELEMENT_NODE) {
			chain.unshift(node as Element);
			node = node.parentNode;
		}
	}
	let style: TextStyle = inherited ?? { families: ["sans-serif"], size: 16, weight: 400, italic: false, letterSpacing: 0, anchor: "start" };
	for (const el of chain) {
		const declared = declarations(el);
		const family = declared.get("font-family");
		if (family) style = { ...style, families: parseFamilies(family) };
		const size = declared.get("font-size");
		if (size) style = { ...style, size: parseLength(size, style.size) };
		const weight = declared.get("font-weight");
		if (weight) style = { ...style, weight: parseWeight(weight, style.weight) };
		const fontStyle = declared.get("font-style");
		if (fontStyle) style = { ...style, italic: /italic|oblique/i.test(fontStyle) };
		const spacing = declared.get("letter-spacing");
		if (spacing) style = { ...style, letterSpacing: spacing.trim() === "normal" ? 0 : parseLength(spacing, style.size) };
		const anchor = declared.get("text-anchor");
		if (anchor && /^(start|middle|end)$/.test(anchor.trim())) style = { ...style, anchor: anchor.trim() as TextStyle["anchor"] };
	}
	return style;
}

/** Attribute values overridden by `style` declarations, as CSS specifies. */
function declarations(el: Element): Map<string, string> {
	const map = new Map<string, string>();
	for (const name of ["font-family", "font-size", "font-weight", "font-style", "letter-spacing", "text-anchor"]) {
		const value = el.getAttribute(name);
		if (value) map.set(name, value);
	}
	const style = el.getAttribute("style");
	if (style) for (const [name, value] of parseStyle(style)) map.set(name, value);
	return map;
}

function parseStyle(style: string): Array<[string, string]> {
	return style
		.split(";")
		.map((decl) => decl.split(":"))
		.filter((parts): parts is [string, string, ...string[]] => parts.length >= 2)
		.map(([name, ...value]) => [name.trim().toLowerCase(), value.join(":").trim()] as [string, string])
		.filter(([name, value]) => name.length > 0 && value.length > 0);
}

function stripTextStyle(style: string): string {
	return parseStyle(style)
		.filter(([name]) => !TEXT_ONLY_STYLE_PROPERTIES.test(name))
		.map(([name, value]) => `${name}:${value}`)
		.join(";");
}

function presentationAttributes(el: Element): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const name of ["fill", "fill-opacity", "stroke", "stroke-width", "opacity"]) {
		const value = el.getAttribute(name);
		if (value) out.push([name, value]);
	}
	return out;
}

function parseFamilies(value: string): string[] {
	return value
		.split(",")
		.map((f) => f.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

function parseLength(value: string, relativeTo: number): number {
	const m = /^\s*(-?[\d.]+)\s*([a-z%]*)\s*$/i.exec(value);
	if (!m) return relativeTo;
	const n = Number.parseFloat(m[1]!);
	if (!Number.isFinite(n)) return relativeTo;
	switch (m[2]!.toLowerCase()) {
		case "":
		case "px":
			return n;
		case "pt":
			return (n * 4) / 3;
		case "em":
			return n * relativeTo;
		case "rem":
			return n * 16;
		case "%":
			return (n / 100) * relativeTo;
		case "mm":
			return n * 3.7795;
		case "cm":
			return n * 37.795;
		case "in":
			return n * 96;
		default:
			return n;
	}
}

function parseWeight(value: string, inherited: number): number {
	const v = value.trim().toLowerCase();
	if (v === "normal") return 400;
	if (v === "bold") return 700;
	if (v === "bolder") return Math.min(900, inherited + 300);
	if (v === "lighter") return Math.max(100, inherited - 300);
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : inherited;
}

function parseNumber(value: string | null): number | undefined {
	if (value === null) return undefined;
	const first = value.trim().split(/[\s,]+/)[0];
	const n = Number.parseFloat(first ?? "");
	return Number.isFinite(n) ? n : undefined;
}

function fmt(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}
