import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	appGetPath: vi.fn(),
	getBundledModelDir: vi.fn(),
	getModelById: vi.fn(),
	getModelFilePath: vi.fn(),
	getModelStorageDir: vi.fn(),
	httpsGet: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: mocks.appGetPath } }));
vi.mock("node:https", () => ({ get: mocks.httpsGet }));
vi.mock("./models", () => ({
	getBundledModelDir: mocks.getBundledModelDir,
	getModelById: mocks.getModelById,
	getModelFilePath: mocks.getModelFilePath,
	getModelStorageDir: mocks.getModelStorageDir,
}));

import { downloadFileWithProgress, downloadModel, getModelStatus } from "./whisper";

interface MockResponseOptions {
	statusCode?: number;
	location?: string;
	body?: string;
	error?: Error;
}

function respond(
	callback: (
		response: PassThrough & { statusCode: number; headers: Record<string, string> },
	) => void,
	options: MockResponseOptions = {},
) {
	const response = new PassThrough() as PassThrough & {
		statusCode: number;
		headers: Record<string, string>;
	};
	const body = options.body ?? "data";
	response.statusCode = options.statusCode ?? 200;
	response.headers = options.location
		? { location: options.location }
		: { "content-length": String(Buffer.byteLength(body)) };

	queueMicrotask(() => {
		callback(response);
		if (options.error) {
			response.write(body);
			response.emit("error", options.error);
			return;
		}
		response.end(body);
	});

	const request = new EventEmitter() as EventEmitter & {
		setTimeout: ReturnType<typeof vi.fn>;
		destroy: ReturnType<typeof vi.fn>;
	};
	request.setTimeout = vi.fn();
	request.destroy = vi.fn();
	return request;
}

describe("caption model downloads", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		vi.clearAllMocks();
		await Promise.all(
			tempRoots
				.splice(0)
				.map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
		);
	});

	it("resolves relative redirect locations against the current URL", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-redirect-"));
		tempRoots.push(tempRoot);
		const destinationPath = path.join(tempRoot, "model.bin");

		mocks.httpsGet
			.mockImplementationOnce((_url, callback) =>
				respond(callback, { statusCode: 302, location: "/downloads/model.bin" }),
			)
			.mockImplementationOnce((_url, callback) => respond(callback, { body: "model" }));

		await downloadFileWithProgress(
			"https://models.example.com/releases/start",
			destinationPath,
			() => undefined,
		);

		expect(mocks.httpsGet.mock.calls[1]?.[0]).toBe(
			"https://models.example.com/downloads/model.bin",
		);
		expect(await fs.readFile(destinationPath, "utf8")).toBe("model");
	});

	it("downloads each missing auxiliary file once", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-model-"));
		tempRoots.push(tempRoot);
		const storageDir = path.join(tempRoot, "sensevoice-small");
		const primaryPath = path.join(storageDir, "model.int8.onnx");
		mocks.appGetPath.mockReturnValue(tempRoot);
		mocks.getModelStorageDir.mockReturnValue(storageDir);
		mocks.getModelFilePath.mockReturnValue(primaryPath);
		mocks.getModelById.mockReturnValue({
			id: "sensevoice-small",
			fileName: "model.int8.onnx",
			downloadUrl: "https://models.example.com/model",
			auxiliaryFiles: [{ fileName: "tokens.txt", url: "https://models.example.com/tokens" }],
		});
		mocks.httpsGet.mockImplementation((_url, callback) => respond(callback));

		await downloadModel({ send: vi.fn() } as never, "sensevoice-small");

		expect(mocks.httpsGet).toHaveBeenCalledTimes(2);
		expect(await fs.readFile(path.join(storageDir, "tokens.txt"), "utf8")).toBe("data");
	});

	it("reports a multi-file model as missing until every required file exists", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-model-status-"));
		tempRoots.push(tempRoot);
		const storageDir = path.join(tempRoot, "sensevoice-small");
		const primaryPath = path.join(storageDir, "model.int8.onnx");
		mocks.appGetPath.mockReturnValue(tempRoot);
		mocks.getModelStorageDir.mockReturnValue(storageDir);
		mocks.getModelFilePath.mockReturnValue(primaryPath);
		mocks.getBundledModelDir.mockReturnValue(path.join(tempRoot, "bundled"));
		mocks.getModelById.mockReturnValue({
			id: "sensevoice-small",
			fileName: "model.int8.onnx",
			downloadUrl: "https://models.example.com/model",
			auxiliaryFiles: [{ fileName: "tokens.txt", url: "https://models.example.com/tokens" }],
		});
		await fs.mkdir(storageDir, { recursive: true });
		await fs.writeFile(primaryPath, "model");

		await expect(getModelStatus("sensevoice-small")).resolves.toMatchObject({
			success: true,
			exists: false,
			path: null,
		});

		await fs.writeFile(path.join(storageDir, "tokens.txt"), "tokens");
		await expect(getModelStatus("sensevoice-small")).resolves.toMatchObject({
			success: true,
			exists: true,
			path: primaryPath,
		});
	});

	it("repairs an incomplete bundled model in user data", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-model-bundled-"));
		tempRoots.push(tempRoot);
		const bundledDir = path.join(tempRoot, "bundled", "sensevoice-small");
		const bundledPrimaryPath = path.join(bundledDir, "model.int8.onnx");
		const storageDir = path.join(tempRoot, "user-data", "models", "sensevoice-small");
		const userPrimaryPath = path.join(storageDir, "model.int8.onnx");
		mocks.appGetPath.mockReturnValue(path.join(tempRoot, "user-data"));
		mocks.getBundledModelDir.mockReturnValue(bundledDir);
		mocks.getModelStorageDir.mockReturnValue(storageDir);
		mocks.getModelFilePath.mockReturnValue(bundledPrimaryPath);
		mocks.getModelById.mockReturnValue({
			id: "sensevoice-small",
			fileName: "model.int8.onnx",
			downloadUrl: "https://models.example.com/model",
			auxiliaryFiles: [{ fileName: "tokens.txt", url: "https://models.example.com/tokens" }],
		});
		await fs.mkdir(bundledDir, { recursive: true });
		await fs.writeFile(bundledPrimaryPath, "bundled-primary");
		mocks.httpsGet.mockImplementation((_url, callback) => respond(callback));

		await expect(downloadModel({ send: vi.fn() } as never, "sensevoice-small")).resolves.toBe(
			userPrimaryPath,
		);
		await expect(getModelStatus("sensevoice-small")).resolves.toMatchObject({
			success: true,
			exists: true,
			path: userPrimaryPath,
		});
		expect(await fs.readFile(bundledPrimaryPath, "utf8")).toBe("bundled-primary");
	});

	it("coalesces concurrent downloads of the same model", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-model-concurrent-"));
		tempRoots.push(tempRoot);
		const storageDir = path.join(tempRoot, "sensevoice-small");
		const primaryPath = path.join(storageDir, "model.int8.onnx");
		mocks.appGetPath.mockReturnValue(tempRoot);
		mocks.getModelStorageDir.mockReturnValue(storageDir);
		mocks.getModelFilePath.mockReturnValue(primaryPath);
		mocks.getModelById.mockReturnValue({
			id: "sensevoice-small",
			fileName: "model.int8.onnx",
			downloadUrl: "https://models.example.com/model",
		});

		const releases: Array<() => void> = [];
		mocks.httpsGet.mockImplementation((_url, callback) => {
			const response = new PassThrough() as PassThrough & {
				statusCode: number;
				headers: Record<string, string>;
			};
			response.statusCode = 200;
			response.headers = { "content-length": "5" };
			queueMicrotask(() => callback(response));
			releases.push(() => response.end("model"));

			const request = new EventEmitter() as EventEmitter & {
				setTimeout: ReturnType<typeof vi.fn>;
				destroy: ReturnType<typeof vi.fn>;
			};
			request.setTimeout = vi.fn();
			request.destroy = vi.fn();
			return request;
		});

		const first = downloadModel({ send: vi.fn() } as never, "sensevoice-small");
		const second = downloadModel({ send: vi.fn() } as never, "sensevoice-small");
		await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const requestCount = mocks.httpsGet.mock.calls.length;
		for (const release of releases) release();
		const results = await Promise.allSettled([first, second]);

		expect(requestCount).toBe(1);
		expect(results).toEqual([
			{ status: "fulfilled", value: primaryPath },
			{ status: "fulfilled", value: primaryPath },
		]);
	});

	it("does not expose a partial auxiliary download as the final file", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-model-error-"));
		tempRoots.push(tempRoot);
		const storageDir = path.join(tempRoot, "sensevoice-small");
		const primaryPath = path.join(storageDir, "model.int8.onnx");
		const auxiliaryPath = path.join(storageDir, "tokens.txt");
		mocks.appGetPath.mockReturnValue(tempRoot);
		mocks.getModelStorageDir.mockReturnValue(storageDir);
		mocks.getModelFilePath.mockReturnValue(primaryPath);
		mocks.getModelById.mockReturnValue({
			id: "sensevoice-small",
			fileName: "model.int8.onnx",
			downloadUrl: "https://models.example.com/model",
			auxiliaryFiles: [{ fileName: "tokens.txt", url: "https://models.example.com/tokens" }],
		});
		mocks.httpsGet
			.mockImplementationOnce((_url, callback) => respond(callback, { body: "primary" }))
			.mockImplementationOnce((_url, callback) =>
				respond(callback, { body: "partial", error: new Error("connection reset") }),
			);

		await expect(downloadModel({ send: vi.fn() } as never, "sensevoice-small")).rejects.toThrow(
			"connection reset",
		);
		await expect(fs.access(auxiliaryPath)).rejects.toThrow();
	});
});
