import { createWriteStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { app, type WebContents } from "electron";
import { getBundledModelDir, getModelById, getModelStorageDir } from "./models";

// ─── IPC Event Helpers ──────────────────────────────────────────────────

export type ModelDownloadStatus = "idle" | "downloading" | "downloaded" | "error";

export interface ModelDownloadProgressPayload {
	modelId: string;
	status: ModelDownloadStatus;
	progress: number;
	path?: string | null;
	error?: string;
}

const inFlightModelDownloads = new Map<string, Promise<string>>();

/**
 * Send model download progress to the renderer.
 * Event name is per-model so the UI can track multiple models independently.
 */
export function sendModelDownloadProgress(
	webContents: WebContents,
	payload: ModelDownloadProgressPayload,
) {
	webContents.send("model-download-progress", payload);
}

// ─── Model Status ───────────────────────────────────────────────────────

async function isCompleteModelAt(
	primaryPath: string,
	auxiliaryFiles: Array<{ fileName: string }> | undefined,
): Promise<boolean> {
	try {
		await fs.access(primaryPath, fsConstants.R_OK);
		await Promise.all(
			(auxiliaryFiles ?? []).map((aux) =>
				fs.access(path.join(path.dirname(primaryPath), aux.fileName), fsConstants.R_OK),
			),
		);
		return true;
	} catch {
		return false;
	}
}

export async function getModelStatus(modelId: string): Promise<{
	success: boolean;
	exists: boolean;
	path?: string | null;
}> {
	const model = getModelById(modelId);
	if (!model) return { success: false, exists: false };

	const userDataPath = app.getPath("userData");
	const candidates = [
		path.join(getBundledModelDir(model), model.fileName),
		path.join(getModelStorageDir(model, userDataPath), model.fileName),
	];
	for (const filePath of new Set(candidates)) {
		if (await isCompleteModelAt(filePath, model.auxiliaryFiles)) {
			return { success: true, exists: true, path: filePath };
		}
	}
	return { success: true, exists: false, path: null };
}

// ─── File Download ──────────────────────────────────────────────────────

export function downloadFileWithProgress(
	url: string,
	destinationPath: string,
	onProgress: (progress: number) => void,
): Promise<void> {
	const request = (currentUrl: string, redirectCount = 0): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			if (redirectCount >= 5) {
				reject(new Error("Too many redirects while downloading model."));
				return;
			}

			const req = httpsGet(currentUrl, (response) => {
				const statusCode = response.statusCode ?? 0;

				if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
					response.resume();
					const nextUrl = new URL(response.headers.location, currentUrl).toString();
					return request(nextUrl, redirectCount + 1).then(resolve, reject);
				}

				if (statusCode !== 200) {
					response.resume();
					reject(new Error(`Model download failed with status ${statusCode}.`));
					return;
				}

				const totalBytes = Number.parseInt(response.headers["content-length"] ?? "0", 10);
				let downloadedBytes = 0;

				const fileStream = createWriteStream(destinationPath);

				response.on("data", (chunk: Buffer) => {
					downloadedBytes += chunk.length;
					if (totalBytes > 0) {
						onProgress((downloadedBytes / totalBytes) * 100);
					}
				});

				response.pipe(fileStream);

				fileStream.on("finish", () => {
					fileStream.close();
					onProgress(100);
					resolve();
				});

				fileStream.on("error", (error) => {
					fileStream.close();
					reject(error);
				});

				response.on("error", (error) => {
					fileStream.close();
					reject(error);
				});
			});

			req.on("error", reject);
			req.on("timeout", () => {
				req.destroy(new Error("Model download timed out."));
			});
			req.setTimeout(30_000);
		});

	return request(url);
}

// ─── Model Download ─────────────────────────────────────────────────────

/**
 * Download a model (and its auxiliary files) by model ID.
 * Reports progress via IPC to the renderer.
 */
async function performModelDownload(webContents: WebContents, modelId: string): Promise<string> {
	const model = getModelById(modelId);
	if (!model) throw new Error(`Unknown model: ${modelId}`);

	const storageDir = getModelStorageDir(model, app.getPath("userData"));
	await fs.mkdir(storageDir, { recursive: true });

	const primaryPath = path.join(storageDir, model.fileName);
	const tempPath = `${primaryPath}.download`;

	sendModelDownloadProgress(webContents, {
		modelId,
		status: "downloading",
		progress: 0,
		path: null,
	});

	try {
		// Clean up any stale temp file
		await fs.rm(tempPath, { force: true });

		// Download primary model file
		await downloadFileWithProgress(model.downloadUrl, tempPath, (progress) => {
			sendModelDownloadProgress(webContents, {
				modelId,
				status: "downloading",
				progress: progress * 0.9, // Reserve 10% for auxiliary files
				path: null,
			});
		});
		await fs.rename(tempPath, primaryPath);

		// Download auxiliary files (tokenizer.json, etc.)
		if (model.auxiliaryFiles) {
			for (const aux of model.auxiliaryFiles) {
				const auxPath = path.join(storageDir, aux.fileName);
				const tempAuxPath = `${auxPath}.download`;
				try {
					await fs.access(auxPath, fsConstants.R_OK);
					continue; // Already exists
				} catch {
					await fs.rm(tempAuxPath, { force: true }).catch(() => undefined);
					try {
						await downloadFileWithProgress(aux.url, tempAuxPath, () => undefined);
						await fs.rename(tempAuxPath, auxPath);
					} catch (error) {
						await fs.rm(tempAuxPath, { force: true }).catch(() => undefined);
						throw error;
					}
				}
			}
		}

		sendModelDownloadProgress(webContents, {
			modelId,
			status: "downloaded",
			progress: 100,
			path: primaryPath,
		});
		return primaryPath;
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		sendModelDownloadProgress(webContents, {
			modelId,
			status: "error",
			progress: 0,
			path: null,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export function downloadModel(webContents: WebContents, modelId: string): Promise<string> {
	const inFlight = inFlightModelDownloads.get(modelId);
	if (inFlight) {
		sendModelDownloadProgress(webContents, {
			modelId,
			status: "downloading",
			progress: 0,
			path: null,
		});
		return inFlight.then(
			(modelPath) => {
				sendModelDownloadProgress(webContents, {
					modelId,
					status: "downloaded",
					progress: 100,
					path: modelPath,
				});
				return modelPath;
			},
			(error) => {
				sendModelDownloadProgress(webContents, {
					modelId,
					status: "error",
					progress: 0,
					path: null,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			},
		);
	}

	const download = performModelDownload(webContents, modelId);
	const trackedDownload = download.finally(() => {
		if (inFlightModelDownloads.get(modelId) === trackedDownload) {
			inFlightModelDownloads.delete(modelId);
		}
	});
	inFlightModelDownloads.set(modelId, trackedDownload);
	return trackedDownload;
}

// ─── Model Deletion ─────────────────────────────────────────────────────

/**
 * Delete a downloaded model and its auxiliary files.
 */
export async function deleteModel(modelId: string): Promise<void> {
	const model = getModelById(modelId);
	if (!model) throw new Error(`Unknown model: ${modelId}`);

	const storageDir = getModelStorageDir(model, app.getPath("userData"));
	await fs.rm(storageDir, { recursive: true, force: true });
}
