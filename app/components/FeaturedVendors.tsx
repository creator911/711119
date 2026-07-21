"use client";

import { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { getCoverCropGeometry, moveCoverPositionByDrag } from "../lib/featured-cover-crop";
import { renderRichBody } from "../lib/rich-text";
import { vendorRegionGroups, writableVendorCategories } from "../lib/vendor-regions";
import RichTextEditor from "./RichTextEditor";

export type FeaturedVendorPost = {
  slot: number;
  industry: string;
  region: string;
  district: string;
  title: string;
  body: string;
  coverImage: string;
  version: number;
  canEdit: boolean;
  updatedAt: string;
};

type DistrictOption = { region: string; district: string; value: string; duplicate: boolean };

const districtOptions: DistrictOption[] = (() => {
  const rows = vendorRegionGroups
    .filter((group) => group.label !== "전체")
    .flatMap((group) => group.districts.map((district) => ({ region: group.label, district, value: `${group.label}::${district}` })));
  const counts = new Map<string, number>();
  rows.forEach((row) => counts.set(row.district, (counts.get(row.district) ?? 0) + 1));
  return rows.map((row) => ({ ...row, duplicate: (counts.get(row.district) ?? 0) > 1 }));
})();

const SUPPORTED_COVER_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const COVER_INPUT_LIMIT = 12 * 1024 * 1024;
const COVER_WIDTH = 1600;
const COVER_HEIGHT = 1000;

function drawCoverCrop(canvas: HTMLCanvasElement, image: HTMLImageElement, zoom: number, horizontal: number, vertical: number) {
  const context = canvas.getContext("2d");
  if (!context || !image.naturalWidth || !image.naturalHeight) return;
  const targetRatio = COVER_WIDTH / COVER_HEIGHT;
  const geometry = getCoverCropGeometry(image.naturalWidth, image.naturalHeight, targetRatio, zoom);
  if (!geometry) return;
  const sourceX = geometry.maxSourceX * horizontal / 100;
  const sourceY = geometry.maxSourceY * vertical / 100;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, sourceX, sourceY, geometry.sourceWidth, geometry.sourceHeight, 0, 0, canvas.width, canvas.height);
}

const canvasBlob = (canvas: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", .86));

export function FeaturedVendorGrid({ posts, loading = false, onOpen }: {
  posts: FeaturedVendorPost[];
  loading?: boolean;
  onOpen: (post: FeaturedVendorPost) => void;
}) {
  const rows = [...posts].sort((left, right) => left.slot - right.slot).slice(0, 4);
  return <div className="vendor-grid featured-vendor-grid" aria-label="추천 제휴업체">
    {loading && !rows.length ? Array.from({ length: 4 }, (_, index) => <article className="vendor-card featured-vendor-loading" key={index} aria-hidden="true"><div /><span /><small /></article>) : rows.map((post) => <article className="vendor-card featured-vendor-card" key={post.slot}>
      <button type="button" className="featured-vendor-open" onClick={() => onOpen(post)} aria-label={`${post.title} 업체정보 보기`}>
        <div className="vendor-image"><img src={post.coverImage} alt={`${post.title} 대문`} /><span className="vendor-badge">TOP</span></div>
        <div className="vendor-info"><h3>{post.title}</h3><div className="featured-vendor-meta"><strong>{post.industry}</strong><span>{post.district}</span></div></div>
      </button>
    </article>)}
  </div>;
}

export function FeaturedVendorDetail({ post, onClose, onSaved, showToast }: {
  post: FeaturedVendorPost;
  onClose: () => void;
  onSaved: (post: FeaturedVendorPost) => void;
  showToast: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) return <FeaturedVendorEditor post={post} onCancel={() => setEditing(false)} onSaved={(next) => { onSaved(next); setEditing(false); }} showToast={showToast} />;
  return <article className="featured-vendor-detail">
    <figure className="featured-vendor-detail-cover">
      <img src={post.coverImage} alt={`${post.title} 대문`} />
      <span>TOP</span>
      <button type="button" onClick={onClose}>목록</button>
    </figure>
    <header>
      <h1>{post.title}</h1>
      <div><strong>{post.industry}</strong><span>{post.district}</span></div>
    </header>
    <div className="featured-vendor-detail-body rich-post-body" dangerouslySetInnerHTML={{ __html: renderRichBody(post.body) }} />
    <footer>{post.canEdit && <button type="button" className="primary" onClick={() => setEditing(true)}>수정</button>}<button type="button" onClick={onClose}>목록</button></footer>
  </article>;
}

function FeaturedVendorEditor({ post, onCancel, onSaved, showToast }: {
  post: FeaturedVendorPost;
  onCancel: () => void;
  onSaved: (post: FeaturedVendorPost) => void;
  showToast: (message: string) => void;
}) {
  const [industry, setIndustry] = useState(post.industry);
  const [area, setArea] = useState(`${post.region}::${post.district}`);
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [editorBusy, setEditorBusy] = useState(false);
  const [cover, setCover] = useState<File | null>(null);
  const [coverPending, setCoverPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [districtQuery, setDistrictQuery] = useState("");
  const visibleDistricts = useMemo(() => {
    const keyword = districtQuery.trim().toLocaleLowerCase("ko-KR");
    return keyword ? districtOptions.filter((option) => `${option.district} ${option.region}`.toLocaleLowerCase("ko-KR").includes(keyword)) : districtOptions;
  }, [districtQuery]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || coverPending || editorBusy) return;
    const separator = area.indexOf("::");
    const region = separator > 0 ? area.slice(0, separator) : "";
    const district = separator > 0 ? area.slice(separator + 2) : "";
    if (!region || !district) return showToast("소지역을 하나 선택해 주세요.");
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("industry", industry);
      form.append("region", region);
      form.append("district", district);
      form.append("title", title.trim());
      form.append("body", body);
      form.append("version", String(post.version));
      if (cover) form.append("cover", cover, cover.name);
      const response = await fetch(`/api/featured-vendors/${post.slot}`, { method: "PATCH", body: form });
      const result = await response.json() as { post?: FeaturedVendorPost; error?: string };
      if (!response.ok || !result.post) throw new Error(result.error ?? "제휴업체 글을 수정하지 못했습니다.");
      onSaved(result.post);
      showToast("제휴업체 글을 수정했습니다.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "제휴업체 글을 수정하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  return <section className="featured-vendor-editor">
    <div className="featured-editor-heading"><div><p>FEATURED VENDOR</p><h1>{post.slot}번 제휴업체 수정</h1></div><button type="button" onClick={onCancel}>목록</button></div>
    <form onSubmit={submit}>
      <FeaturedCoverCropper initialUrl={post.coverImage} title={title || post.title} onChange={(file, pending) => { setCover(file); setCoverPending(pending); }} showToast={showToast} />
      <fieldset><legend>업종 <small>하나만 선택</small></legend><div className="vendor-choice-grid categories">{writableVendorCategories.map((item) => <label key={item}><input type="radio" name="featuredIndustry" checked={industry === item} onChange={() => setIndustry(item)} /><span>{item}</span></label>)}</div></fieldset>
      <fieldset className="featured-district-fieldset"><legend>지역 <small>소지역 하나만 선택</small></legend><input className="featured-district-search" value={districtQuery} onChange={(event) => setDistrictQuery(event.target.value)} placeholder="소지역 검색" aria-label="제휴업체 소지역 검색" /><div className="featured-district-grid">{visibleDistricts.map((option) => <label key={option.value}><input type="radio" name="featuredArea" checked={area === option.value} onChange={() => setArea(option.value)} /><span><b>{option.district}</b>{option.duplicate && <small>{option.region}</small>}</span></label>)}</div>{!visibleDistricts.length && <p>검색한 소지역이 없습니다.</p>}</fieldset>
      <input className="vendor-title-input" value={title} onChange={(event) => setTitle(event.target.value)} minLength={2} maxLength={80} placeholder="업체정보 제목을 입력해 주세요." required />
      <RichTextEditor name="featuredVendorBody" value={body} onChange={setBody} onBusyChange={setEditorBusy} allowPoll={false} placeholder="업체 소개와 안내 내용을 입력해 주세요." />
      <div className="vendor-editor-actions"><button type="button" disabled={editorBusy || coverPending} onClick={onCancel}>취소</button><button type="submit" disabled={submitting || coverPending || editorBusy || !industry || !area || !title.trim()}>{editorBusy ? "첨부 중…" : submitting ? "저장 중…" : coverPending ? "사진 적용 필요" : "수정 완료"}</button></div>
    </form>
  </section>;
}

function FeaturedCoverCropper({ initialUrl, title, onChange, showToast }: {
  initialUrl: string;
  title: string;
  onChange: (file: File | null, pending: boolean) => void;
  showToast: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const cropGenerationRef = useRef(0);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    horizontal: number;
    vertical: number;
    viewportWidth: number;
    viewportHeight: number;
  } | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [appliedUrl, setAppliedUrl] = useState("");
  const [sourceName, setSourceName] = useState("cover");
  const [cropping, setCropping] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [applying, setApplying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [horizontal, setHorizontal] = useState(50);
  const [vertical, setVertical] = useState(50);
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);
  useEffect(() => () => { if (appliedUrl) URL.revokeObjectURL(appliedUrl); }, [appliedUrl]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (cropping && canvas && image && imageReady) drawCoverCrop(canvas, image, zoom, horizontal, vertical);
  }, [cropping, horizontal, imageReady, vertical, zoom]);

  const select = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!SUPPORTED_COVER_TYPES.has(file.type)) return showToast("JPG, PNG, GIF, WebP, AVIF, BMP 이미지를 선택해 주세요.");
    if (file.size > COVER_INPUT_LIMIT) return showToast("대문 사진은 12MB 이하 파일을 선택해 주세요.");
    const generation = ++cropGenerationRef.current;
    dragRef.current = null;
    setDragging(false);
    setApplying(false);
    const nextUrl = URL.createObjectURL(file);
    setSourceUrl(nextUrl);
    setSourceName(file.name.replace(/\.[^.]+$/, "") || "cover");
    setAppliedUrl("");
    setZoom(1); setHorizontal(50); setVertical(50); setImageReady(false); setCropping(true);
    onChange(null, true);
    const image = new Image();
    image.onload = () => { if (cropGenerationRef.current !== generation) return; imageRef.current = image; setImageReady(true); };
    image.onerror = () => { if (cropGenerationRef.current !== generation) return; setCropping(false); setSourceUrl(""); onChange(null, false); showToast("선택한 사진을 읽지 못했습니다."); };
    image.src = nextUrl;
  };

  const cancelCrop = () => {
    cropGenerationRef.current += 1;
    dragRef.current = null;
    setDragging(false);
    setApplying(false);
    setCropping(false); setImageReady(false); setSourceUrl(""); setAppliedUrl(""); imageRef.current = null; onChange(null, false);
  };
  const applyCrop = async () => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !imageReady || applying) return;
    const generation = cropGenerationRef.current;
    dragRef.current = null;
    setDragging(false);
    setApplying(true);
    canvas.width = COVER_WIDTH;
    canvas.height = COVER_HEIGHT;
    drawCoverCrop(canvas, image, zoom, horizontal, vertical);
    const blob = await canvasBlob(canvas);
    if (cropGenerationRef.current !== generation) return;
    canvas.width = 800;
    canvas.height = 500;
    drawCoverCrop(canvas, image, zoom, horizontal, vertical);
    if (!blob) { setApplying(false); return showToast("대문 사진을 처리하지 못했습니다."); }
    const file = new File([blob], `${sourceName}.webp`, { type: "image/webp", lastModified: Date.now() });
    const previewUrl = URL.createObjectURL(blob);
    setAppliedUrl(previewUrl);
    setCropping(false);
    setApplying(false);
    onChange(file, false);
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const image = imageRef.current;
    if (!cropping || !imageReady || applying || !image || dragRef.current || event.pointerType === "mouse" && event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      horizontal,
      vertical,
      viewportWidth: bounds.width,
      viewportHeight: bounds.height,
    };
    setDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const image = imageRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !image) return;
    event.preventDefault();
    const position = moveCoverPositionByDrag({
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      targetRatio: COVER_WIDTH / COVER_HEIGHT,
      zoom,
      horizontal: drag.horizontal,
      vertical: drag.vertical,
      deltaX: event.clientX - drag.startX,
      deltaY: event.clientY - drag.startY,
      viewportWidth: drag.viewportWidth,
      viewportHeight: drag.viewportHeight,
    });
    setHorizontal(position.horizontal);
    setVertical(position.vertical);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <fieldset className="featured-cover-fieldset"><legend>대문 사진 <small>16:10 비율</small></legend>
    <div className="featured-cover-layout">
      <div
        className={`featured-cover-preview${cropping && imageReady ? " is-draggable" : ""}${dragging ? " is-dragging" : ""}`}
        title={cropping && imageReady ? "사진을 끌어 원하는 위치로 이동하세요." : undefined}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      >
        {cropping ? <canvas ref={canvasRef} width={800} height={500} aria-label="대문 사진 자르기 미리보기" /> : <img src={appliedUrl || initialUrl} alt={`${title} 대문 미리보기`} />}
        <span>TOP</span>
        {cropping && imageReady && <p className="featured-cover-drag-hint">사진을 끌어 위치 조정</p>}
      </div>
      <div className="featured-cover-controls">
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/bmp" onChange={select} />
        <button type="button" className="featured-cover-select" disabled={applying} onClick={() => inputRef.current?.click()}>{sourceUrl ? "다른 사진 선택" : "대문 사진 선택"}</button>
        {cropping ? <>
          <label><span>확대 <b>{zoom.toFixed(1)}×</b></span><input type="range" min="1" max="3" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
          <label><span>가로 위치 <b>{Math.round(horizontal)}</b></span><input type="range" min="0" max="100" value={horizontal} onChange={(event) => setHorizontal(Number(event.target.value))} /></label>
          <label><span>세로 위치 <b>{Math.round(vertical)}</b></span><input type="range" min="0" max="100" value={vertical} onChange={(event) => setVertical(Number(event.target.value))} /></label>
          <div><button type="button" disabled={applying} onClick={cancelCrop}>선택 취소</button><button type="button" className="apply" disabled={!imageReady || applying} onClick={() => void applyCrop()}>{applying ? "처리 중…" : "이 화면으로 적용"}</button></div>
        </> : <>{sourceUrl && <button type="button" className="featured-cover-recrop" onClick={() => { setAppliedUrl(""); setCropping(true); onChange(null, true); }}>현재 사진 다시 자르기</button>}<p>{appliedUrl ? "잘라낸 사진이 저장 시 함께 업로드됩니다." : "사진을 선택하면 실제 카드 비율로 자를 수 있습니다."}</p></>}
      </div>
    </div>
  </fieldset>;
}
