// Composer image attachments: file picker, paste handling, thumbnail pills,
// and the lightweight preview overlay shared by sent/hydrated messages.
import { attachImageEl, attachmentTrayEl, composerEl, imageInputEl, inputEl } from "./dom";
import { escapeHtml, uid } from "./util";
import type { ImageAttachment } from "../protocol";
import type { UiImageAttachment } from "./types";

const EXTENSION_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

let pendingAttachments: UiImageAttachment[] = [];
let onChange: (() => void) | undefined;

export function initImageAttachments(changeHandler: () => void): void {
  onChange = changeHandler;
  attachImageEl.addEventListener("click", () => imageInputEl.click());
  imageInputEl.addEventListener("change", () => {
    if (imageInputEl.files?.length) void addImageFiles(Array.from(imageInputEl.files));
    imageInputEl.value = "";
  });
  composerEl.addEventListener("paste", (event) => {
    const files = imageFilesFromPaste(event);
    if (files.length === 0) return;
    event.preventDefault();
    void addImageFiles(files);
  });
  attachmentTrayEl.addEventListener("click", handleTrayClick);
  attachmentTrayEl.addEventListener("keydown", handleTrayKeydown);
  renderAttachmentTray();
}

export function hasPendingImageAttachments(): boolean {
  return pendingAttachments.length > 0;
}

export function getPendingImageAttachments(): UiImageAttachment[] {
  return pendingAttachments.map((attachment) => ({ ...attachment }));
}

export function consumePendingImageAttachments(): UiImageAttachment[] {
  const consumed = getPendingImageAttachments();
  pendingAttachments = [];
  renderAttachmentTray();
  notifyChange();
  return consumed;
}

export function imageDataUrl(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function imageMeta(image: ImageAttachment): string {
  return image.width && image.height ? `${image.width}×${image.height}` : "";
}

export function showImagePreview(image: ImageAttachment, label = image.name || "Image"): void {
  const overlay = document.createElement("div");
  overlay.className = "image-preview-overlay";
  overlay.innerHTML =
    '<div class="image-preview-container">' +
    '<img class="image-preview-img" alt="' + escapeHtml(label) + '" src="' + escapeHtml(imageDataUrl(image)) + '" />' +
    '<button class="image-preview-close" type="button" title="Close preview (Esc)" aria-label="Close preview">×</button>' +
    "</div>";

  function close(): void {
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector("button")?.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown, true);
  document.body.appendChild(overlay);
  (overlay.querySelector("button") as HTMLButtonElement | null)?.focus();
}

async function addImageFiles(files: File[]): Promise<void> {
  const attachments = (await Promise.all(files.map((file) => attachmentFromFile(file)))).filter(
    (attachment): attachment is UiImageAttachment => Boolean(attachment),
  );
  if (attachments.length === 0) return;
  pendingAttachments = [...pendingAttachments, ...attachments];
  renderAttachmentTray();
  notifyChange();
  inputEl.focus();
}

async function attachmentFromFile(file: File): Promise<UiImageAttachment | undefined> {
  const mimeType = detectImageMimeType(file);
  if (!mimeType) return undefined;

  const data = await readFileBase64(file);
  if (!data) return undefined;
  const dataUrl = `data:${mimeType};base64,${data}`;
  const dimensions = await readImageDimensions(dataUrl);
  return {
    id: uid("image"),
    name: file.name || defaultImageName(mimeType),
    data,
    mimeType,
    width: dimensions?.width,
    height: dimensions?.height,
  };
}

function imageFilesFromPaste(event: ClipboardEvent): File[] {
  const clipboard = event.clipboardData;
  if (!clipboard) return [];

  const files = Array.from(clipboard.files).filter((file) => Boolean(detectImageMimeType(file)));
  if (files.length > 0) return dedupeFiles(files);

  const itemFiles: File[] = [];
  for (const item of Array.from(clipboard.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file && detectImageMimeType(file)) itemFiles.push(file);
  }
  return dedupeFiles(itemFiles);
}

function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const result: File[] = [];
  for (const file of files) {
    const key = [file.name, file.type, file.size, file.lastModified].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }
  return result;
}

function detectImageMimeType(file: File): string | undefined {
  const mimeType = file.type.toLowerCase();
  if (Object.values(EXTENSION_TO_MIME).includes(mimeType)) return mimeType;
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return EXTENSION_TO_MIME[extension];
}

function readFileBase64(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.split(",")[1] : undefined);
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

function readImageDimensions(dataUrl: string): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(undefined);
    image.src = dataUrl;
  });
}

function defaultImageName(mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "png";
  return `pasted-image.${extension}`;
}

function renderAttachmentTray(): void {
  attachmentTrayEl.hidden = pendingAttachments.length === 0;
  attachmentTrayEl.innerHTML = pendingAttachments.map(attachmentPillHtml).join("");
}

function attachmentPillHtml(attachment: UiImageAttachment): string {
  const meta = imageMeta(attachment);
  return (
    '<div class="attachment-pill" role="button" tabindex="0" data-preview-attachment="' + escapeHtml(attachment.id) + '">' +
    '<img class="attachment-thumb" alt="" src="' + escapeHtml(imageDataUrl(attachment)) + '" />' +
    '<span class="attachment-label" title="' + escapeHtml(attachment.name) + '">' + escapeHtml(attachment.name) + "</span>" +
    (meta ? '<span class="attachment-meta">' + escapeHtml(meta) + "</span>" : "") +
    '<button class="attachment-remove" type="button" title="Remove attachment" aria-label="Remove attachment" data-remove-attachment="' + escapeHtml(attachment.id) + '">×</button>' +
    "</div>"
  );
}

function handleTrayClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  handleTrayAction(target);
}

function handleTrayKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target as HTMLElement | null;
  if (!target?.closest("[data-preview-attachment]")) return;
  event.preventDefault();
  handleTrayAction(target);
}

function handleTrayAction(target: HTMLElement | null): void {
  const remove = target?.closest("[data-remove-attachment]") as HTMLElement | null;
  if (remove) {
    const id = remove.dataset.removeAttachment;
    pendingAttachments = pendingAttachments.filter((attachment) => attachment.id !== id);
    renderAttachmentTray();
    notifyChange();
    return;
  }

  const preview = target?.closest("[data-preview-attachment]") as HTMLElement | null;
  const attachment = pendingAttachments.find((item) => item.id === preview?.dataset.previewAttachment);
  if (attachment) showImagePreview(attachment);
}

function notifyChange(): void {
  onChange?.();
}
