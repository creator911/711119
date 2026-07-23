"use client";

import { ChangeEvent, MouseEvent, useEffect, useRef, useState } from "react";
import { uploadMediaFile } from "../lib/client-media-upload";

type RichTextEditorProps = {
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  compact?: boolean;
  allowPoll?: boolean;
  onBusyChange?: (busy: boolean) => void;
};

type UploadResult = { url: string; mediaType: "image" | "video"; name: string; size: number };
type PollBuilder = { question: string; options: string[] };

const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textLength = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().length;
const TABLE_PICKER_SIZE = 8;
export const IMAGE_UPLOAD_LIMIT = 12 * 1024 * 1024;
const VIDEO_UPLOAD_LIMIT = 50 * 1024 * 1024;
const VIDEO_OPTIMIZE_THRESHOLD = 18 * 1024 * 1024;

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
const encodePollConfig = (poll: PollBuilder) => {
  const bytes = new TextEncoder().encode(JSON.stringify(poll));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const youtubeVideoId = (input: string) => {
  try {
    const trimmed = input.trim();
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let id = "";
    if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    else if (["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
      if (url.pathname === "/watch") id = url.searchParams.get("v") ?? "";
      else if (/^\/(?:shorts|live|embed)\//.test(url.pathname)) id = url.pathname.split("/").filter(Boolean)[1] ?? "";
    } else if (host === "youtube-nocookie.com" && url.pathname.startsWith("/embed/")) id = url.pathname.split("/").filter(Boolean)[1] ?? "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
  } catch { return ""; }
};

export async function optimizeImageFile(file: File) {
  if (file.type === "image/gif" || file.type === "image/webp") return file;
  if (!/^image\/(?:jpeg|png|avif|bmp)$/i.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1920 / bitmap.width, 1920 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) { bitmap.close(); return file; }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const outputType = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const blob = await canvasBlob(canvas, outputType, .82);
    if (!blob || blob.size >= file.size && scale === 1) return file;
    const extension = outputType === "image/jpeg" ? "jpg" : "webp";
    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    return new File([blob], `${base}.${extension}`, { type: outputType, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

async function optimizeVideoFile(file: File, onStatus: (message: string) => void) {
  if (file.size <= VIDEO_OPTIMIZE_THRESHOLD) return file;
  const video = document.createElement("video") as HTMLVideoElement & { captureStream?: () => MediaStream };
  const sourceUrl = URL.createObjectURL(file);
  video.src = sourceUrl;
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("동영상을 읽지 못했습니다."));
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 120) {
      if (file.size <= VIDEO_UPLOAD_LIMIT) return file;
      throw new Error("2분 이하, 50MB 이하 동영상을 첨부해 주세요.");
    }
    const mimeType = typeof MediaRecorder !== "undefined"
      ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type))
      : undefined;
    if (!mimeType || !video.captureStream) {
      if (file.size <= VIDEO_UPLOAD_LIMIT) return file;
      throw new Error("이 브라우저에서는 큰 동영상 압축을 지원하지 않습니다. 50MB 이하 파일을 사용해 주세요.");
    }
    onStatus(`동영상 용량 최적화 중 · 약 ${Math.ceil(video.duration)}초`);
    const stream = video.captureStream();
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_800_000, audioBitsPerSecond: 128_000 });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error("동영상 최적화에 실패했습니다."));
    });
    const ended = new Promise<void>((resolve, reject) => {
      video.onended = () => resolve();
      video.onerror = () => reject(new Error("동영상 재생 정보를 읽지 못했습니다."));
    });
    recorder.start(1000);
    await video.play();
    await ended;
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: "video/webm" });
    if (!blob.size || blob.size >= file.size) return file;
    const base = file.name.replace(/\.[^.]+$/, "") || "video";
    return new File([blob], `${base}.webm`, { type: "video/webm", lastModified: file.lastModified });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(sourceUrl);
  }
}

export default function RichTextEditor({ name, value, onChange, placeholder = "내용을 입력해 주세요.", maxLength = 3000, compact = false, allowPoll = true, onBusyChange }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tablePreview, setTablePreview] = useState({ rows: 1, columns: 1 });
  const [textColor, setTextColor] = useState("#e24841");
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [youtubeError, setYoutubeError] = useState("");
  const [pollOptionCount, setPollOptionCount] = useState<number | null>(null);
  const [pollBuilder, setPollBuilder] = useState<PollBuilder | null>(null);
  const [pollBuilderError, setPollBuilderError] = useState("");
  const currentLength = textLength(value);
  const uploading = Boolean(uploadStatus);
  const hasPoll = /class=["'][^"']*(?:editor-poll-card|post-poll-slot)[^"']*["']/i.test(value);

  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) editorRef.current.innerHTML = value;
  }, [value]);

  useEffect(() => {
    onBusyChange?.(uploading);
    return () => onBusyChange?.(false);
  }, [onBusyChange, uploading]);

  useEffect(() => {
    if (!uploading) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [uploading]);

  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  const sync = () => {
    const next = editorRef.current?.innerHTML ?? "";
    onChange(next);
  };

  const rememberSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    selectionRef.current = range.cloneRange();
  };

  const restoreSelection = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    if (selectionRef.current) {
      selection.addRange(selectionRef.current);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.addRange(range);
    selectionRef.current = range.cloneRange();
  };

  const command = (commandName: string, argument?: string) => {
    restoreSelection();
    document.execCommand(commandName, false, argument);
    rememberSelection();
    sync();
  };

  const insertHtml = (html: string) => {
    restoreSelection();
    document.execCommand("insertHTML", false, html);
    rememberSelection();
    sync();
  };

  const startYouTube = () => {
    rememberSelection();
    setYoutubeUrl("");
    setYoutubeError("");
    setYoutubeOpen(true);
  };

  const addYouTube = () => {
    const videoId = youtubeVideoId(youtubeUrl);
    if (!videoId) { setYoutubeError("올바른 유튜브 동영상 주소를 입력해 주세요."); return; }
    setUploadError("");
    setYoutubeOpen(false);
    setYoutubeUrl("");
    setYoutubeError("");
    insertHtml(`<div class="editor-youtube-block" contenteditable="false"><iframe src="https://www.youtube-nocookie.com/embed/${escapeAttr(videoId)}" title="유튜브 동영상" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen="allowfullscreen"></iframe></div><p><br /></p>`);
  };

  const uploadFile = async (file: File, signal: AbortSignal) => {
    return uploadMediaFile(file, { signal }) as Promise<UploadResult>;
  };

  const addImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).slice(0, 8);
    event.target.value = "";
    if (!files.length || uploading) return;
    rememberSelection();
    setUploadError("");
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const source = files[index];
        setUploadStatus(`이미지 최적화 중 ${index + 1}/${files.length}`);
        const optimized = await optimizeImageFile(source);
        if (optimized.size > IMAGE_UPLOAD_LIMIT) throw new Error("이미지는 최적화 후 12MB 이하여야 합니다.");
        setUploadStatus(`이미지 첨부 중 ${index + 1}/${files.length}`);
        const uploaded = await uploadFile(optimized, controller.signal);
        insertHtml(`<p class="editor-media-block"><img src="${escapeAttr(uploaded.url)}" alt="첨부 이미지" /></p><p><br /></p>`);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setUploadError(error instanceof Error ? error.message : "이미지를 첨부하지 못했습니다.");
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      setUploadStatus("");
    }
  };

  const addVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const source = event.target.files?.[0];
    event.target.value = "";
    if (!source || uploading) return;
    rememberSelection();
    setUploadError("");
    setUploadStatus("동영상 확인 중");
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    try {
      const optimized = await optimizeVideoFile(source, setUploadStatus);
      if (optimized.size > VIDEO_UPLOAD_LIMIT) throw new Error("동영상은 최적화 후 50MB 이하여야 합니다.");
      setUploadStatus("동영상 첨부 중");
      const uploaded = await uploadFile(optimized, controller.signal);
      insertHtml(`<p class="editor-media-block"><video src="${escapeAttr(uploaded.url)}" controls="controls" preload="metadata" playsinline="playsinline"></video></p><p><br /></p>`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setUploadError(error instanceof Error ? error.message : "동영상을 첨부하지 못했습니다.");
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      setUploadStatus("");
    }
  };

  const addTable = (rows: number, columns: number) => {
    const tableRows = Array.from({ length: rows }, () => `<tr>${Array.from({ length: columns }, () => "<td><br /></td>").join("")}</tr>`).join("");
    insertHtml(`<table class="editor-table"><tbody>${tableRows}</tbody></table><p><br /></p>`);
    setTablePickerOpen(false);
  };

  const startPoll = () => {
    rememberSelection();
    if (hasPoll) { setUploadError("게시글 하나에는 투표를 하나만 넣을 수 있습니다."); return; }
    setUploadError("");
    setPollBuilderError("");
    setPollOptionCount(2);
  };

  const beginPollBuilder = () => {
    if (pollOptionCount === null) return;
    setPollBuilder({ question: "", options: Array.from({ length: pollOptionCount }, () => "") });
    setPollOptionCount(null);
  };

  const insertPoll = () => {
    if (!pollBuilder) return;
    const question = pollBuilder.question.trim().replace(/\s+/g, " ");
    const options = pollBuilder.options.map((option) => option.trim().replace(/\s+/g, " "));
    if (question.length < 2 || question.length > 100) { setPollBuilderError("투표 질문을 2–100자로 입력해 주세요."); return; }
    if (options.some((option) => !option || option.length > 60)) { setPollBuilderError("모든 선택지를 1–60자로 입력해 주세요."); return; }
    if (new Set(options.map((option) => option.toLocaleLowerCase("ko-KR"))).size !== options.length) { setPollBuilderError("같은 선택지는 중복해서 사용할 수 없습니다."); return; }
    const poll = { question, options };
    const config = encodePollConfig(poll);
    insertHtml(`<blockquote class="editor-poll-card" data-poll-config="${config}" contenteditable="false"><strong>VOTE · 투표</strong><h4>${escapeAttr(question)}</h4><ol>${options.map((option) => `<li>${escapeAttr(option)}</li>`).join("")}</ol><p>계정당 한 번만 참여할 수 있으며, 투표 후 결과가 표시됩니다.</p></blockquote><p><br /></p>`);
    setPollBuilder(null);
    setPollOptionCount(null);
    setPollBuilderError("");
  };

  const closePollBuilder = () => {
    setPollBuilder(null);
    setPollOptionCount(null);
    setPollBuilderError("");
  };

  const keepEditorFocus = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) event.preventDefault();
  };

  return <div className={`rich-editor ${compact ? "compact" : ""}`}>
    <div className="rich-editor-shell">
      <div className="rich-media-bar" onMouseDown={keepEditorFocus}>
        <button type="button" disabled={uploading} onClick={() => { rememberSelection(); imageInputRef.current?.click(); }}><span>▣</span>이미지 첨부</button>
        <button type="button" disabled={uploading} onClick={() => { rememberSelection(); videoInputRef.current?.click(); }}><span>▶</span>동영상 첨부</button>
        <button type="button" disabled={uploading} onClick={startYouTube}><span>▣</span>유튜브</button>
        {allowPoll && <button type="button" disabled={uploading || hasPoll} onClick={startPoll}><span>▥</span>{hasPoll ? "투표 추가됨" : "투표"}</button>}
        <input ref={imageInputRef} className="rich-file-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/bmp" multiple onChange={addImages} />
        <input ref={videoInputRef} className="rich-file-input" type="file" accept="video/mp4,video/webm,video/ogg,video/quicktime" onChange={addVideo} />
      </div>
      <div className="rich-format-bar" aria-label="글 편집 도구" onMouseDown={keepEditorFocus}>
        <select defaultValue="맑은 고딕" onChange={(event) => command("fontName", event.target.value)} aria-label="글꼴">
          <option>맑은 고딕</option><option>굴림</option><option>돋움</option><option>Arial</option>
        </select>
        <select defaultValue="3" onChange={(event) => command("fontSize", event.target.value)} aria-label="글자 크기">
          <option value="2">12</option><option value="3">14</option><option value="4">16</option><option value="5">20</option>
        </select>
        <button type="button" title="굵게" aria-label="굵게" onClick={() => command("bold")}><b>가</b></button>
        <button type="button" title="기울임" aria-label="기울임" onClick={() => command("italic")}><i>가</i></button>
        <button type="button" title="밑줄" aria-label="밑줄" onClick={() => command("underline")}><u>가</u></button>
        <button type="button" title="취소선" aria-label="취소선" onClick={() => command("strikeThrough")}><s>가</s></button>
        <label className="rich-color-tool" title="글자색"><span style={{ color: textColor, textShadow: textColor.toLowerCase() === "#ffffff" ? "0 0 1px #111, 0 0 1px #111" : undefined }}>가</span><input type="color" value={textColor} aria-label="글자색 선택" onChange={(event) => { setTextColor(event.target.value); command("foreColor", event.target.value); }} /></label>
        <button type="button" title="배경색" aria-label="배경색" onClick={() => command("backColor", "#fff1b8")}>배경</button>
        <button type="button" title="표 삽입" aria-label="표 삽입" aria-expanded={tablePickerOpen} onClick={() => setTablePickerOpen((open) => !open)}>표</button>
        <button type="button" title="왼쪽 정렬" aria-label="왼쪽 정렬" onClick={() => command("justifyLeft")}>좌</button>
        <button type="button" title="가운데 정렬" aria-label="가운데 정렬" onClick={() => command("justifyCenter")}>중</button>
        <button type="button" title="오른쪽 정렬" aria-label="오른쪽 정렬" onClick={() => command("justifyRight")}>우</button>
        <button type="button" title="실행 취소" aria-label="실행 취소" onClick={() => command("undo")}>↶</button>
        <button type="button" title="다시 실행" aria-label="다시 실행" onClick={() => command("redo")}>↷</button>
      </div>
      {tablePickerOpen && <div className="rich-table-picker" onMouseDown={keepEditorFocus}>
        <div className="rich-table-picker-label">표 크기 <b>{tablePreview.rows} × {tablePreview.columns}</b></div>
        <div className="rich-table-picker-grid" role="grid" aria-label="표 크기 선택">
          {Array.from({ length: TABLE_PICKER_SIZE }, (_, rowIndex) => Array.from({ length: TABLE_PICKER_SIZE }, (_, columnIndex) => {
            const rows = rowIndex + 1;
            const columns = columnIndex + 1;
            const selected = rows <= tablePreview.rows && columns <= tablePreview.columns;
            return <button type="button" role="gridcell" className={selected ? "selected" : ""} aria-label={`${rows}행 ${columns}열 표 만들기`} key={`${rows}-${columns}`} onMouseEnter={() => setTablePreview({ rows, columns })} onFocus={() => setTablePreview({ rows, columns })} onClick={() => addTable(rows, columns)} />;
          }))}
        </div>
      </div>}
      <div ref={editorRef} className="rich-editable" contentEditable role="textbox" aria-multiline="true" data-placeholder={placeholder} onInput={() => { sync(); window.setTimeout(rememberSelection, 0); }} onKeyUp={rememberSelection} onMouseUp={rememberSelection} onFocus={rememberSelection} onBlur={() => { sync(); rememberSelection(); }} suppressContentEditableWarning />
      <div className="rich-helper-row"><span className={uploadError ? "rich-upload-error" : "rich-upload-status"}>{uploadError || uploadStatus || "이미지·GIF 자동 최적화 · 동영상 최대 50MB"}</span><b>{currentLength.toLocaleString()} / {maxLength.toLocaleString()}</b></div>
      <input type="hidden" name={name} value={value} />
    </div>
    {youtubeOpen && <div className="rich-poll-backdrop" onMouseDown={() => setYoutubeOpen(false)}>
      <section className="rich-poll-builder rich-youtube-builder" role="dialog" aria-modal="true" aria-labelledby="youtube-builder-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span>YOUTUBE</span><h3 id="youtube-builder-title">유튜브 동영상 넣기</h3></div><button type="button" onClick={() => setYoutubeOpen(false)} aria-label="유튜브 동영상 넣기 닫기">×</button></header>
        <label className="rich-poll-question"><b>동영상 주소</b><input value={youtubeUrl} autoFocus inputMode="url" placeholder="https://www.youtube.com/watch?v=..." onChange={(event) => { setYoutubeUrl(event.target.value); setYoutubeError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addYouTube(); } }} /></label>
        <p className={youtubeError ? "rich-poll-builder-error" : "rich-poll-builder-note"}>{youtubeError || "유튜브 영상 주소를 붙여 넣으면 본문에 미리보기로 삽입됩니다."}</p>
        <footer><button type="button" onClick={() => setYoutubeOpen(false)}>취소</button><button type="button" onClick={addYouTube}>본문에 동영상 넣기</button></footer>
      </section>
    </div>}
    {(pollOptionCount !== null || pollBuilder) && <div className="rich-poll-backdrop" onMouseDown={closePollBuilder}>
      <section className="rich-poll-builder" role="dialog" aria-modal="true" aria-labelledby="poll-builder-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span>VOTE BUILDER</span><h3 id="poll-builder-title">투표 만들기</h3></div><button type="button" onClick={closePollBuilder} aria-label="투표 만들기 닫기">×</button></header>
        {pollBuilder ? <>
          <label className="rich-poll-question"><b>투표 질문</b><input value={pollBuilder.question} maxLength={100} autoFocus placeholder="무엇을 물어볼까요?" onChange={(event) => setPollBuilder((current) => current ? { ...current, question: event.target.value } : current)} /><small>{pollBuilder.question.length} / 100</small></label>
          <div className="rich-poll-options"><b>선택지 {pollBuilder.options.length}개</b>{pollBuilder.options.map((option, index) => <label key={index}><span>{index + 1}</span><input value={option} maxLength={60} placeholder={`선택지 ${index + 1}`} onChange={(event) => setPollBuilder((current) => current ? { ...current, options: current.options.map((item, itemIndex) => itemIndex === index ? event.target.value : item) } : current)} /></label>)}</div>
          <p className={pollBuilderError ? "rich-poll-builder-error" : "rich-poll-builder-note"}>{pollBuilderError || "게시 후 회원 계정당 한 번만 참여할 수 있고, 참여 즉시 결과가 공개됩니다."}</p>
          <footer><button type="button" onClick={closePollBuilder}>취소</button><button type="button" onClick={insertPoll}>본문에 투표 넣기</button></footer>
        </> : <>
          <div className="rich-poll-count"><b>선택지는 몇 개로 만들까요?</b><div>{Array.from({ length: 9 }, (_, index) => index + 2).map((count) => <button type="button" className={pollOptionCount === count ? "active" : ""} aria-pressed={pollOptionCount === count} key={count} onClick={() => setPollOptionCount(count)}>{count}개</button>)}</div><p>2개부터 10개까지 선택할 수 있습니다.</p></div>
          <footer><button type="button" onClick={closePollBuilder}>취소</button><button type="button" onClick={beginPollBuilder}>다음</button></footer>
        </>}
      </section>
    </div>}
  </div>;
}
