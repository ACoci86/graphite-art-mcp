/** Opens a URL in the user's default browser without extra dependencies. Failures are logged, never thrown. */

import { spawn } from "node:child_process";
import { platform } from "node:os";

export function openInBrowser(url: string, log: (message: string) => void): void {
	try {
		const os = platform();
		const [command, args] =
			os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]] : ["xdg-open", [url]];
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", (error) => log(`could not open a browser (${error.message}); open ${url} yourself`));
		child.unref();
	} catch (error) {
		log(`could not open a browser (${error instanceof Error ? error.message : String(error)}); open ${url} yourself`);
	}
}
