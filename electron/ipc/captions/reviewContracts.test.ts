import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("SenseVoice integration review contracts", () => {
	it("keeps every macOS release target in the effective builder config", async () => {
		const source = await fs.readFile(path.join(projectRoot, "electron-builder.json5"), "utf8");
		const config = vm.runInNewContext(`(${source})`) as {
			mac: { target: Array<{ target: string; arch: string[] }> };
		};

		expect(config.mac.target).toEqual([
			{ target: "dmg", arch: ["x64", "arm64"] },
			{ target: "zip", arch: ["x64", "arm64"] },
			{ target: "dir", arch: ["arm64"] },
		]);
	});

	it("downloads each bundled model file once and atomically promotes it", async () => {
		const source = await fs.readFile(
			path.join(projectRoot, "scripts/download-bundled-models.mjs"),
			"utf8",
		);
		expect(source.match(/await downloadFile\(file\.url,/g)).toHaveLength(1);
		expect(source).toContain("await rename(tempDest, dest)");
	});

	it("surrounds the development index table with blank lines", async () => {
		const source = await fs.readFile(path.join(projectRoot, "dev_docs/INDEX.md"), "utf8");
		const lines = source.split(/\r?\n/);
		const tableStart = lines.findIndex((line) => line.startsWith("| 日期"));
		expect(tableStart).toBeGreaterThan(0);
		expect(lines[tableStart - 1]).toBe("");

		let tableEnd = tableStart;
		while (tableEnd + 1 < lines.length && lines[tableEnd + 1].startsWith("|")) {
			tableEnd += 1;
		}
		expect(lines[tableEnd + 1]).toBe("");
	});
});
