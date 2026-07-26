import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sherpaMocks = vi.hoisted(() => ({
	createOfflineRecognizer: vi.fn(),
	readWave: vi.fn(),
}));

vi.mock("sherpa-onnx", () => sherpaMocks);

import * as sensevoice from "./sensevoice";

type TokensToWords = (
	tokens: string[],
	timestamps: number[],
) => Array<{ text: string; startMs: number; endMs: number }>;

describe("SenseVoice timing and cleanup", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		vi.clearAllMocks();
		await Promise.all(
			tempRoots
				.splice(0)
				.map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
		);
	});

	it("preserves real pauses between tokenized words", () => {
		const tokensToWords = (sensevoice as { tokensToWords?: TokensToWords }).tokensToWords;
		expect(tokensToWords).toBeTypeOf("function");
		if (!tokensToWords) return;

		expect(tokensToWords([" hello", " world"], [0.1, 2])).toEqual([
			{ text: "hello", startMs: 100, endMs: 1_050 },
			{ text: "world", startMs: 2_000, endMs: 2_200 },
		]);
	});

	it("frees the recognizer when WAV decoding throws", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-sensevoice-"));
		tempRoots.push(tempRoot);
		const audioPath = path.join(tempRoot, "audio.wav");
		const modelPath = path.join(tempRoot, "model.int8.onnx");
		await fs.writeFile(audioPath, "not-a-wave");
		await fs.writeFile(path.join(tempRoot, "tokens.txt"), "token");

		const recognizer = {
			createStream: vi.fn(),
			free: vi.fn(),
		};
		sherpaMocks.createOfflineRecognizer.mockReturnValue(recognizer);
		sherpaMocks.readWave.mockImplementation(() => {
			throw new Error("malformed WAV");
		});

		const engine = new sensevoice.SenseVoiceEngine();
		await expect(
			engine.generate({
				audioPath,
				modelPath,
				model: {
					id: "sensevoice-small",
					name: "SenseVoice Small",
					engine: "sensevoice",
					downloadUrl: "https://example.com/model",
					fileName: "model.int8.onnx",
				},
				tempDir: tempRoot,
			}),
		).rejects.toThrow("malformed WAV");
		expect(recognizer.free).toHaveBeenCalledOnce();
	});
});
