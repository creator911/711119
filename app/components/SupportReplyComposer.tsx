"use client";

import { ChangeEvent, DragEvent, FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { uploadMediaFile } from "../lib/client-media-upload";
import { IMAGE_UPLOAD_LIMIT, optimizeImageFile } from "./RichTextEditor";

type Attachment = { previewUrl: string; protectedUrl: string; name: string };
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const MAX_IMAGES = 4;
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const protectedMediaUrl = (url: string) => url.replace(/^\/api\/media\//, "/api/support/media/");

export default function SupportReplyComposer({
  submitting,
  onSend,
  placeholder = "추가 문의 내용을 입력해 주세요.",
  submitLabel = "등록",
  variant = "member",
  secondaryAction,
}: {
  submitting: boolean;
  onSend: (body: string) => Promise<boolean>;
  placeholder?: string;
  submitLabel?: string;
  variant?: "member" | "admin";
  secondaryAction?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dragDepthRef = useRef(0);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => () => abortRef.current?.abort(), []);

  const addFiles = async (incoming: File[]) => {
    if (uploading || submitting || !incoming.length) return;
    const remaining = MAX_IMAGES - attachments.length;
    if (remaining < 1) { setMessage(`사진은 답변당 최대 ${MAX_IMAGES}장까지 첨부할 수 있습니다.`); return; }
    const files = incoming.filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type)).slice(0, remaining);
    if (!files.length) { setMessage("JPG, PNG, GIF, WEBP, AVIF, BMP 이미지만 첨부할 수 있습니다."); return; }
    if (incoming.length > remaining) setMessage(`사진은 답변당 최대 ${MAX_IMAGES}장까지만 첨부됩니다.`);
    else setMessage("");
    setUploading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const uploaded: Attachment[] = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        setMessage(`사진 최적화 및 첨부 중 ${index + 1}/${files.length}`);
        const optimized = await optimizeImageFile(files[index]);
        if (optimized.size > IMAGE_UPLOAD_LIMIT) throw new Error("이미지는 최적화 후 12MB 이하여야 합니다.");
        const result = await uploadMediaFile(optimized, { signal: controller.signal, admin: variant === "admin" });
        if (!result.url || result.mediaType !== "image") throw new Error("사진을 첨부하지 못했습니다.");
        uploaded.push({ previewUrl: result.url, protectedUrl: protectedMediaUrl(result.url), name: result.name ?? optimized.name });
      }
      setAttachments((current) => [...current, ...uploaded]);
      setMessage(`${uploaded.length}장 첨부 완료`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setMessage(error instanceof Error ? error.message : "사진을 첨부하지 못했습니다.");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setUploading(false);
    }
  };

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void addFiles(files);
  };

  const acceptsFiles = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files");
  const dragEnter = (event: DragEvent<HTMLElement>) => {
    if (!acceptsFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  };
  const dragOver = (event: DragEvent<HTMLElement>) => {
    if (!acceptsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const dragLeave = (event: DragEvent<HTMLElement>) => {
    if (!acceptsFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (!dragDepthRef.current) setDragging(false);
  };
  const drop = (event: DragEvent<HTMLElement>) => {
    if (!acceptsFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = text.trim();
    if ((!content && !attachments.length) || submitting || uploading) return;
    const textBody = content ? `<p>${escapeHtml(content).replace(/\r?\n/g, "<br />")}</p>` : "";
    const imageBody = attachments.map((image) => `<p class="editor-media-block"><img src="${escapeHtml(image.protectedUrl)}" alt="첨부 이미지" /></p>`).join("");
    if (await onSend(`${textBody}${imageBody}`)) {
      setText("");
      setAttachments([]);
      setMessage("");
    }
  };

  return <form
    className={`support-reply-composer ${variant} ${dragging ? "dragging" : ""}`}
    onSubmit={submit}
    onDragEnter={dragEnter}
    onDragOver={dragOver}
    onDragLeave={dragLeave}
    onDrop={drop}
  >
    {dragging && <div className="support-reply-dropzone" aria-hidden="true">여기에 사진을 놓으세요</div>}
    {attachments.length > 0 && <div className="support-reply-previews" aria-label="첨부 사진 미리보기">
      {attachments.map((image, index) => <figure key={`${image.protectedUrl}-${index}`}>
        <img src={image.previewUrl} alt={`${index + 1}번 첨부 사진 미리보기`} />
        <button type="button" onClick={() => setAttachments((current) => current.filter((_, target) => target !== index))} aria-label={`${index + 1}번 첨부 사진 제거`}>×</button>
      </figure>)}
    </div>}
    <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={1000} placeholder={placeholder} disabled={submitting} />
    <div className="support-reply-toolbar">
      <div className="support-reply-attach">
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/bmp" multiple onChange={chooseFiles} />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={submitting || uploading || attachments.length >= MAX_IMAGES}>▣ 사진 첨부</button>
        <small>최대 4장 · PC는 끌어놓기 가능</small>
      </div>
      <div className="support-reply-actions">{secondaryAction}<button type="submit" disabled={submitting || uploading || (!text.trim() && !attachments.length)}>{uploading ? "첨부 중…" : submitting ? "저장 중…" : submitLabel}</button></div>
    </div>
    <div className="support-reply-meta"><span>{text.length} / 1000</span><em aria-live="polite">{message}</em></div>
  </form>;
}
