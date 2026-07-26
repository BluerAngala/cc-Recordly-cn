import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	appGetPath: vi.fn(),
	engineGenerate: vi.fn(),
	execFile: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: mocks.appGetPath } }));
vi.mock("node:child_process", () => ({
	execFile: mocks.execFile,
	spawnSync: vi.fn(),
}));
vi.mock("../ffmpeg/binary", () => ({ getFfmpegBinaryPath: () => "/fake/ffmpeg" }));
vi.mock("../paths/binaries", () => ({ getBundledWhisperExecutableCandidates: () => [] }));
vi.mock("../project/session", () => ({ resolveRecordingSession: async () => null }));
vi.mock("../utils", () => ({ normalizeVideoSourcePath: (value: string) => value }));
vi.mock("./models", () => ({
	getModelById: () => ({
		id: "sensevoice-small",
		name: "SenseVoice Small",
		engine: "sensevoice",
		downloadUrl: "https://example.com/model",
		fileName: "model.int8.onnx",
	}),
}));
vi.mock("./sensevoice", () => ({
	SenseVoiceEngine: class {
		generate = mocks.engineGenerate;
	},
}));

import { generateAutoCaptionsFromVideo } from "./generate";

describe("SenseVoice caption temp files", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		mocks.appGetPath.mockReset();
		mocks.engineGenerate.mockReset();
		mocks.execFile.mockReset();
		await Promise.all(
			tempRoots
				.splice(0)
				.map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
		);
	});

	async function arrangeSource() {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-generate-"));
		tempRoots.push(tempRoot);
		const videoPath = path.join(tempRoot, "recording.mp4");
		await fs.writeFile(videoPath, "video");
		mocks.appGetPath.mockReturnValue(tempRoot);
		mocks.execFile.mockImplementation((_file, args, _options, callback) => {
			const wavPath = args.at(-1) as string;
			void fs.writeFile(wavPath, "wav").then(
				() => callback(null, "", ""),
				(error) => callback(error),
			);
			return {};
		});
		return { tempRoot, videoPath };
	}

	it("removes the extracted WAV when the engine throws", async () => {
		const { videoPath } = await arrangeSource();
		let wavPath = "";
		mocks.engineGenerate.mockImplementation((options) => {
			wavPath = options.audioPath;
			throw new Error("native recognizer failed");
		});

		await expect(
			generateAutoCaptionsFromVideo({
				videoPath,
				whisperModelPath: "/models/model.int8.onnx",
				modelId: "sensevoice-small",
			}),
		).rejects.toThrow("native recognizer failed");
		expect(wavPath).not.toBe("");
		await expect(fs.access(wavPath)).rejects.toThrow();
	});

	it("uses distinct WAV paths for concurrent runs started in the same millisecond", async () => {
		const { videoPath } = await arrangeSource();
		vi.spyOn(Date, "now").mockReturnValue(1_234_567);
		const wavPaths: string[] = [];
		const resolvers: Array<() => void> = [];
		mocks.engineGenerate.mockImplementation(
			(options) =>
				new Promise((resolve) => {
					wavPaths.push(options.audioPath);
					resolvers.push(() => resolve({ success: true, cues: [] }));
				}),
		);

		const first = generateAutoCaptionsFromVideo({
			videoPath,
			whisperModelPath: "/models/model.int8.onnx",
			modelId: "sensevoice-small",
		});
		const second = generateAutoCaptionsFromVideo({
			videoPath,
			whisperModelPath: "/models/model.int8.onnx",
			modelId: "sensevoice-small",
		});
		await vi.waitFor(() => expect(wavPaths).toHaveLength(2));
		expect(new Set(wavPaths)).toHaveLength(2);
		for (const resolve of resolvers) resolve();
		await Promise.all([first, second]);
	});
});
