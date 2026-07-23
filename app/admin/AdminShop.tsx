"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminShopProduct = {
  id: number;
  name: string;
  description: string;
  price: number;
  stock: number;
  minLevel: number;
  imageUrl: string;
  availableVouchers: number;
  pendingPurchases: number;
  deliveredPurchases: number;
  active: boolean;
  version: number;
};

type ShopResponse = {
  products?: AdminShopProduct[];
  product?: AdminShopProduct;
  lowStockCount?: number;
  error?: string;
};

type AdminVoucher = {
  id: number;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  imageUrl: string;
};

type VoucherResponse = ShopResponse & {
  vouchers?: AdminVoucher[];
  hasMore?: boolean;
  nextCursor?: number | null;
  deleted?: number;
  skipped?: number;
  remainingAvailable?: number;
  storageCleanupPending?: number;
};

type ProductDraft = {
  name: string;
  description: string;
  price: string;
  stock: string;
  minLevel: string;
  active: boolean;
  version: number;
};

const draftOf = (product: AdminShopProduct): ProductDraft => ({
  name: product.name,
  description: product.description,
  price: String(product.price),
  stock: String(product.stock),
  minLevel: String(product.minLevel),
  active: product.active,
  version: product.version,
});

const lowStockProductCount = (products: AdminShopProduct[]) => products.filter(
  (product) => product.active && product.availableVouchers <= 5,
).length;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const COVER_IMAGE_LIMIT = 8 * 1024 * 1024;
const VOUCHER_IMAGE_LIMIT = 5 * 1024 * 1024;
const VOUCHER_TOTAL_LIMIT = 100 * 1024 * 1024;

const compactBytes = (size: number) => size >= 1024 * 1024
  ? `${(size / (1024 * 1024)).toFixed(1)}MB`
  : `${Math.max(1, Math.round(size / 1024))}KB`;

const productFromResponse = (result: ShopResponse | AdminShopProduct) => {
  if ("product" in result && result.product) return result.product;
  if ("id" in result && typeof result.id === "number") return result;
  return null;
};

const errorMessage = async (response: Response, fallback: string) => {
  try {
    const result = await response.json() as { error?: string };
    return result.error ?? fallback;
  } catch {
    return fallback;
  }
};

export default function AdminShop({ onChanged }: { onChanged: () => void }) {
  const [products, setProducts] = useState<AdminShopProduct[]>([]);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [voucherFiles, setVoucherFiles] = useState<File[]>([]);
  const [voucherListOpen, setVoucherListOpen] = useState(false);
  const [vouchers, setVouchers] = useState<AdminVoucher[]>([]);
  const [voucherCursor, setVoucherCursor] = useState<number | null>(null);
  const [voucherHasMore, setVoucherHasMore] = useState(false);
  const [voucherListLoading, setVoucherListLoading] = useState(false);
  const [selectedVoucherIds, setSelectedVoucherIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "vouchers" | "delete-vouchers" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [unconfirmedProductIds, setUnconfirmedProductIds] = useState<number[]>([]);
  const voucherRequestSequence = useRef(0);

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === expandedId) ?? null,
    [expandedId, products],
  );

  const imagePreview = useMemo(
    () => imageFile ? URL.createObjectURL(imageFile) : selectedProduct?.imageUrl ?? "",
    [imageFile, selectedProduct?.imageUrl],
  );

  useEffect(() => {
    if (!imageFile || !imagePreview.startsWith("blob:")) return;
    return () => URL.revokeObjectURL(imagePreview);
  }, [imageFile, imagePreview]);

  const loadProducts = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/shop", { cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response, "상점 상품을 불러오지 못했습니다."));
      const result = await response.json() as ShopResponse;
      const nextProducts = Array.isArray(result.products) ? result.products : [];
      setProducts(nextProducts);
      setLowStockCount(typeof result.lowStockCount === "number" ? result.lowStockCount : lowStockProductCount(nextProducts));
      setExpandedId(null);
      setDraft(null);
      setImageFile(null);
      setVoucherFiles([]);
      setVoucherListOpen(false);
      setVouchers([]);
      setVoucherCursor(null);
      setVoucherHasMore(false);
      setSelectedVoucherIds([]);
      setUnconfirmedProductIds([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "상점 상품을 불러오지 못했습니다.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProducts(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProducts]);

  const openProduct = (product: AdminShopProduct) => {
    if (busyId !== null) return;
    voucherRequestSequence.current += 1;
    const nextId = expandedId === product.id ? null : product.id;
    setExpandedId(nextId);
    setDraft(nextId === null ? null : draftOf(product));
    setImageFile(null);
    setVoucherFiles([]);
    setVoucherListOpen(false);
    setVouchers([]);
    setVoucherCursor(null);
    setVoucherHasMore(false);
    setSelectedVoucherIds([]);
    setError("");
    setStatus("");
  };

  const applyProduct = (product: AdminShopProduct) => {
    setProducts((current) => {
      const next = current.map((item) => item.id === product.id ? product : item);
      setLowStockCount(lowStockProductCount(next));
      return next;
    });
    setUnconfirmedProductIds((current) => current.filter((id) => id !== product.id));
    setDraft(draftOf(product));
  };

  const refreshProduct = async (productId: number) => {
    const response = await fetch("/api/admin/shop", { cache: "no-store" });
    if (!response.ok) throw new Error(await errorMessage(response, "상품 현황을 다시 확인하지 못했습니다."));
    const result = await response.json() as ShopResponse;
    const nextProducts = Array.isArray(result.products) ? result.products : [];
    const product = nextProducts.find((item) => item.id === productId) ?? null;
    if (!product) throw new Error("상품 현황을 다시 확인하지 못했습니다.");
    setProducts(nextProducts);
    setLowStockCount(typeof result.lowStockCount === "number" ? result.lowStockCount : lowStockProductCount(nextProducts));
    setUnconfirmedProductIds((current) => current.filter((id) => id !== productId));
    setDraft(draftOf(product));
    return product;
  };

  const saveProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProduct || !draft || busyId !== null) return;
    const name = draft.name.trim();
    const price = Number(draft.price);
    const stock = Number(draft.stock);
    const minLevel = Number(draft.minLevel);
    if (name.length < 2 || name.length > 60) return setError("상품명은 2~60자로 입력해 주세요.");
    if (draft.description.trim().length > 160) return setError("상품 설명은 160자 이하로 입력해 주세요.");
    if (!Number.isSafeInteger(price) || price < 1 || price > 100_000_000) return setError("가격은 1~100,000,000P 사이의 정수로 입력해 주세요.");
    if (!Number.isSafeInteger(stock) || stock < 0 || stock > 1_000_000) return setError("판매수량은 0~1,000,000개 사이의 정수로 입력해 주세요.");
    if (!Number.isSafeInteger(minLevel) || minLevel < 1 || minLevel > 9) return setError("이용 가능 레벨은 Lv.1~Lv.9 중에서 선택해 주세요.");

    setBusyId(selectedProduct.id);
    setBusyAction("save");
    setError("");
    setStatus("");
    try {
      const form = new FormData();
      form.append("name", name);
      form.append("description", draft.description.trim());
      form.append("price", String(price));
      form.append("stock", String(stock));
      form.append("minLevel", String(minLevel));
      form.append("active", String(draft.active));
      form.append("version", String(draft.version));
      form.append("expectedStock", String(selectedProduct.stock));
      if (imageFile) form.append("cover", imageFile, imageFile.name);
      const response = await fetch(`/api/admin/shop/${selectedProduct.id}`, { method: "PATCH", body: form });
      if (!response.ok) throw new Error(await errorMessage(response, "상품을 저장하지 못했습니다."));
      const result = await response.json() as ShopResponse | AdminShopProduct;
      const product = productFromResponse(result);
      if (!product) throw new Error("저장된 상품 정보를 확인하지 못했습니다.");
      applyProduct(product);
      setImageFile(null);
      setStatus("상품 정보를 저장했습니다.");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "상품을 저장하지 못했습니다.");
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const selectProductImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (!IMAGE_TYPES.has(file.type)) {
      setImageFile(null);
      setStatus("");
      return setError("대표사진은 JPG, PNG, GIF, WebP 이미지만 선택할 수 있습니다.");
    }
    if (file.size > COVER_IMAGE_LIMIT) {
      setImageFile(null);
      setStatus("");
      return setError("대표사진은 8MB 이하로 선택해 주세요.");
    }
    setImageFile(file);
    setError("");
    setStatus(`${file.name} 파일을 대표사진으로 선택했습니다.`);
  };

  const selectVoucherFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    const rejectFiles = (message: string) => {
      setVoucherFiles([]);
      setStatus("");
      setError(message);
    };
    if (files.length > 30) return rejectFiles("지급 이미지는 한 번에 30개까지 선택할 수 있습니다.");
    if (files.some((file) => !IMAGE_TYPES.has(file.type))) return rejectFiles("지급 이미지는 JPG, PNG, GIF, WebP 형식만 선택할 수 있습니다.");
    if (files.some((file) => file.size > VOUCHER_IMAGE_LIMIT)) return rejectFiles("지급 이미지는 한 장당 5MB 이하여야 합니다.");
    if (files.reduce((sum, file) => sum + file.size, 0) > VOUCHER_TOTAL_LIMIT) return rejectFiles("한 번에 선택하는 지급 이미지의 전체 용량은 100MB 이하여야 합니다.");
    setError("");
    setVoucherFiles(files);
    setStatus(`${files.length.toLocaleString()}개 지급 이미지를 선택했습니다.`);
  };

  const uploadVouchers = async () => {
    if (!selectedProduct || !voucherFiles.length || busyId !== null) return;
    setBusyId(selectedProduct.id);
    setBusyAction("vouchers");
    setError("");
    setStatus("");
    try {
      const form = new FormData();
      voucherFiles.forEach((file) => form.append("files", file, file.name));
      const response = await fetch(`/api/admin/shop/${selectedProduct.id}/vouchers`, { method: "POST", body: form });
      if (!response.ok) throw new Error(await errorMessage(response, "자동상품 지급 이미지를 등록하지 못했습니다."));
      const result = await response.json() as ShopResponse | AdminShopProduct;
      const product = productFromResponse(result);
      if (!product) throw new Error("갱신된 재고 정보를 확인하지 못했습니다.");
      applyProduct(product);
      const uploadedCount = voucherFiles.length;
      setVoucherFiles([]);
      setStatus(`자동상품 지급 이미지 ${uploadedCount.toLocaleString()}개를 등록했습니다.`);
      if (voucherListOpen) await loadVoucherList(selectedProduct.id, false);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "자동상품 지급 이미지를 등록하지 못했습니다.");
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const loadVoucherList = async (productId: number, append: boolean) => {
    const requestSequence = ++voucherRequestSequence.current;
    setVoucherListLoading(true);
    setError("");
    try {
      const cursor = append ? voucherCursor ?? 0 : 0;
      const response = await fetch(`/api/admin/shop/${productId}/vouchers?cursor=${cursor}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response, "기존 지급 이미지 목록을 불러오지 못했습니다."));
      const result = await response.json() as VoucherResponse;
      if (requestSequence !== voucherRequestSequence.current) return;
      const incoming = Array.isArray(result.vouchers) ? result.vouchers : [];
      const product = productFromResponse(result);
      if (product) applyProduct(product);
      setVouchers((current) => append
        ? [...current, ...incoming.filter((voucher) => !current.some((item) => item.id === voucher.id))]
        : incoming);
      setVoucherCursor(typeof result.nextCursor === "number" ? result.nextCursor : null);
      setVoucherHasMore(result.hasMore === true);
      if (!append) setSelectedVoucherIds([]);
      return true;
    } catch (caught) {
      if (requestSequence === voucherRequestSequence.current) {
        setError(caught instanceof Error ? caught.message : "기존 지급 이미지 목록을 불러오지 못했습니다.");
      }
      return false;
    } finally {
      if (requestSequence === voucherRequestSequence.current) setVoucherListLoading(false);
    }
  };

  const toggleVoucherList = () => {
    if (!selectedProduct || busyId !== null) return;
    if (voucherListOpen) {
      voucherRequestSequence.current += 1;
      setVoucherListOpen(false);
      setVoucherListLoading(false);
      setSelectedVoucherIds([]);
      return;
    }
    setVoucherListOpen(true);
    void loadVoucherList(selectedProduct.id, false);
  };

  const toggleVoucher = (voucherId: number) => {
    setSelectedVoucherIds((current) => current.includes(voucherId)
      ? current.filter((id) => id !== voucherId)
      : [...current, voucherId]);
  };

  const toggleLoadedVouchers = () => {
    const loadedIds = vouchers.map((voucher) => voucher.id);
    const allSelected = loadedIds.length > 0 && loadedIds.every((id) => selectedVoucherIds.includes(id));
    setSelectedVoucherIds(allSelected ? [] : loadedIds);
  };

  const deleteVouchers = async (mode: "selected" | "all") => {
    if (!selectedProduct || busyId !== null) return;
    const ids = mode === "selected" ? selectedVoucherIds : [];
    if (mode === "selected" && !ids.length) return;
    const confirmation = mode === "all"
      ? `사용 가능한 지급 이미지 ${selectedProduct.availableVouchers.toLocaleString()}개를 전부 삭제할까요? 이미 지급됐거나 지급 대상으로 지정된 이미지는 삭제되지 않습니다.`
      : `선택한 지급 이미지 ${ids.length.toLocaleString()}개를 삭제할까요?`;
    if (!window.confirm(confirmation)) return;

    const productId = selectedProduct.id;
    setBusyId(productId);
    setBusyAction("delete-vouchers");
    setError("");
    setStatus("");
    let deletedTotal = 0;
    let skippedTotal = 0;
    let cleanupPendingTotal = 0;
    let latestProduct: AdminShopProduct | null = null;
    const selectedChunks = mode === "selected"
      ? Array.from({ length: Math.ceil(ids.length / 80) }, (_, index) => ids.slice(index * 80, (index + 1) * 80))
      : [];
    let selectedChunkIndex = 0;
    try {
      do {
        const requestIds = mode === "selected" ? selectedChunks[selectedChunkIndex] : [];
        const response = await fetch(`/api/admin/shop/${productId}/vouchers`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, ids: requestIds }),
        });
        if (!response.ok) throw new Error(await errorMessage(response, "지급 이미지를 삭제하지 못했습니다."));
        const result = await response.json() as VoucherResponse;
        deletedTotal += Number(result.deleted ?? 0);
        skippedTotal += Number(result.skipped ?? 0);
        cleanupPendingTotal += Number(result.storageCleanupPending ?? 0);
        const product = productFromResponse(result);
        if (product) {
          latestProduct = product;
          applyProduct(product);
        }
        if (mode === "selected") {
          selectedChunkIndex += 1;
          if (selectedChunkIndex >= selectedChunks.length) break;
        } else if (result.hasMore !== true || Number(result.deleted ?? 0) < 1) {
          break;
        }
        setStatus(`지급 이미지 ${deletedTotal.toLocaleString()}개를 삭제하는 중입니다…`);
      } while (true);

      if (latestProduct) applyProduct(latestProduct);
      setSelectedVoucherIds([]);
      await loadVoucherList(productId, false);
      const skippedText = skippedTotal > 0 ? ` 지급 처리된 ${skippedTotal.toLocaleString()}개는 제외했습니다.` : "";
      const cleanupText = cleanupPendingTotal > 0 ? ` 저장소 정리 대기 ${cleanupPendingTotal.toLocaleString()}건은 다음 확인 때 자동 재시도됩니다.` : "";
      setStatus(`사용 가능한 지급 이미지 ${deletedTotal.toLocaleString()}개를 삭제했습니다.${skippedText}${cleanupText}`);
      onChanged();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "지급 이미지를 삭제하지 못했습니다.";
      const [productRefresh, listRefresh] = await Promise.allSettled([
        refreshProduct(productId),
        loadVoucherList(productId, false),
      ]);
      const reconciled = productRefresh.status === "fulfilled"
        || (listRefresh.status === "fulfilled" && listRefresh.value === true);
      if (!reconciled) {
        setUnconfirmedProductIds((current) => current.includes(productId) ? current : [...current, productId]);
      }
      onChanged();
      setError(reconciled
        ? `${message} 현재 상품 수량은 다시 확인했습니다.`
        : `${message} 상품 수량을 다시 확인하지 못했습니다. 새로고침해 주세요.`);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  return <section className="admin-panel shop-admin" aria-labelledby="shop-admin-title">
    <div className="panel-title shop-admin-title">
      <div>
        <h2 id="shop-admin-title">상점 상품 관리</h2>
        <p>상품 정보와 판매수량을 수정하고 자동 지급용 코드 이미지를 등록합니다.</p>
      </div>
      <div>
        {unconfirmedProductIds.length > 0 && <strong className="shop-low-stock-count" role="status">현황 확인 필요 {unconfirmedProductIds.length.toLocaleString()}건</strong>}
        {lowStockCount > 0 && <strong className="shop-low-stock-count" role="status">지급 이미지 확인 {lowStockCount.toLocaleString()}건</strong>}
        <button type="button" disabled={loading || busyId !== null} onClick={() => void loadProducts()}>{loading ? "불러오는 중…" : "새로고침"}</button>
      </div>
    </div>

    {error && <p className="shop-admin-error" role="alert">{error}</p>}
    {status && <p className="shop-admin-status" role="status">{status}</p>}

    <div className="shop-product-list" aria-busy={loading}>
      {loading ? <p className="admin-empty">상점 상품을 불러오는 중입니다.</p> : products.length ? products.map((product) => {
        const expanded = expandedId === product.id;
        const saving = busyId === product.id && busyAction === "save";
        const uploading = busyId === product.id && busyAction === "vouchers";
        const deletingVouchers = busyId === product.id && busyAction === "delete-vouchers";
        const stockEmpty = product.stock === 0;
        const stockLow = product.stock > 0 && product.stock <= 5;
        const vouchersUnconfirmed = unconfirmedProductIds.includes(product.id);
        const vouchersEmpty = !vouchersUnconfirmed && product.availableVouchers === 0;
        const vouchersLow = !vouchersUnconfirmed && product.availableVouchers > 0 && product.availableVouchers <= 5;
        return <article className={`shop-product-card${expanded ? " expanded" : ""}${product.active ? "" : " inactive"}`} key={product.id}>
          <button className="shop-product-summary" type="button" aria-expanded={expanded} aria-controls={`shop-product-editor-${product.id}`} disabled={busyId !== null && busyId !== product.id} onClick={() => openProduct(product)}>
            <span className="shop-product-thumbnail">{product.imageUrl ? <img src={product.imageUrl} alt={`${product.name} 대표사진`} /> : <span aria-hidden="true">NO IMAGE</span>}</span>
            <span className="shop-product-name"><b>{product.name}</b><small>{product.active ? "공개 중" : "숨김"}</small></span>
            <span><small>가격</small><b>{product.price.toLocaleString()}P</b></span>
            <span><small>레벨 제한</small><b>Lv.{product.minLevel} 이상</b></span>
            <span className={stockEmpty || stockLow ? "low" : ""}><small>판매수량</small><b>{product.stock.toLocaleString()}개</b></span>
            <span className={vouchersUnconfirmed || vouchersEmpty || vouchersLow ? "low" : ""}><small>지급이미지</small><b>{vouchersUnconfirmed ? "확인 필요" : `${product.availableVouchers.toLocaleString()}개`}</b></span>
            <span className="shop-product-toggle" aria-hidden="true">{expanded ? "접기 −" : "수정 +"}</span>
          </button>

          {(vouchersUnconfirmed || vouchersEmpty || vouchersLow) && <div className="shop-product-warnings" role="status">
            {vouchersUnconfirmed ? <p className="critical">지급 이미지 현황을 다시 확인해 주세요.</p> : vouchersEmpty ? <p className="critical">자동상품 지급 이미지가 모두 소진되었습니다.</p> : vouchersLow && <p>자동상품 지급 이미지가 {product.availableVouchers.toLocaleString()}개 남았습니다. 재고를 추가해 주세요.</p>}
          </div>}

          {expanded && draft && <div className="shop-product-editor" id={`shop-product-editor-${product.id}`}>
            <form onSubmit={saveProduct}>
              <fieldset disabled={busyId !== null}>
                <legend>상품 정보 수정</legend>
                <div className="shop-product-image-field">
                  <div className="shop-product-image-preview">{imagePreview ? <img src={imagePreview} alt={`${draft.name || product.name} 대표사진 미리보기`} /> : <span>대표사진 없음</span>}</div>
                  <label className="shop-file-button">대표사진 선택<input className="shop-file-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={selectProductImage} /></label>
                  {imageFile && <small>{imageFile.name}</small>}
                </div>
                <div className="shop-product-fields">
                  <label>상품명<input value={draft.name} required minLength={2} maxLength={60} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                  <label>가격(P)<input type="number" inputMode="numeric" min="1" max="100000000" step="1" required value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} /></label>
                  <label>판매수량<input type="number" inputMode="numeric" min="0" max="1000000" step="1" required value={draft.stock} onChange={(event) => setDraft({ ...draft, stock: event.target.value })} /></label>
                  <label>이용 가능 레벨<select value={draft.minLevel} onChange={(event) => setDraft({ ...draft, minLevel: event.target.value })}>{Array.from({ length: 9 }, (_, index) => <option key={index + 1} value={index + 1}>Lv.{index + 1} 이상</option>)}</select></label>
                  <label className="shop-product-active"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>{draft.active ? "상품 공개" : "상품 숨김"}</span></label>
                  <label className="shop-product-description">상품 설명<textarea value={draft.description} maxLength={160} rows={5} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                </div>
              </fieldset>
              <div className="shop-product-save-actions">
                <span>버전 {draft.version.toLocaleString()}</span>
                <button type="submit" disabled={busyId !== null}>{saving ? "저장 중…" : "변경 저장"}</button>
              </div>
            </form>

            <section className="shop-voucher-manager" aria-labelledby={`shop-vouchers-title-${product.id}`}>
              <header>
                <div><h3 id={`shop-vouchers-title-${product.id}`}>자동상품 지급 이미지</h3><p>판매수량과 별도로 관리되며, 지급 대기 중인 회원에게 등록 순서대로 전달됩니다.</p></div>
                <strong className={vouchersUnconfirmed || product.availableVouchers <= 5 ? "low" : ""}>{vouchersUnconfirmed ? "현황 확인 필요" : `${product.availableVouchers.toLocaleString()}개 사용 가능`}</strong>
              </header>
              <div className="shop-purchase-counts">
                <span>지급 대기 <b>{product.pendingPurchases.toLocaleString()}</b></span>
                <span>지급 완료 <b>{product.deliveredPurchases.toLocaleString()}</b></span>
              </div>
              <div className="shop-voucher-upload">
                <label className="shop-file-button">자동상품 지급 이미지 추가<input className="shop-file-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple disabled={busyId !== null} onChange={selectVoucherFiles} /></label>
                <span>{voucherFiles.length ? `${voucherFiles.length.toLocaleString()}개 선택됨` : "여러 이미지를 한 번에 선택할 수 있습니다."}</span>
                <button type="button" disabled={busyId !== null || !voucherFiles.length} onClick={() => void uploadVouchers()}>{uploading ? "등록 중…" : voucherFiles.length ? `${voucherFiles.length.toLocaleString()}개 등록` : "이미지 선택 필요"}</button>
              </div>
              <div className="shop-voucher-library">
                <div className="shop-voucher-library-title">
                  <button type="button" aria-expanded={voucherListOpen} disabled={busyId !== null} onClick={toggleVoucherList}>
                    {voucherListOpen ? "기존 이미지 접기" : "기존 이미지 펼쳐보기"}
                  </button>
                  <small>사용 가능한 이미지만 표시되며, 지급 완료·예약 이미지는 삭제할 수 없습니다.</small>
                </div>
                {voucherListOpen && <div className="shop-voucher-library-body" aria-busy={voucherListLoading || deletingVouchers}>
                  <div className="shop-voucher-library-actions">
                    <label>
                      <input type="checkbox" checked={vouchers.length > 0 && vouchers.every((voucher) => selectedVoucherIds.includes(voucher.id))} disabled={!vouchers.length || busyId !== null} onChange={toggleLoadedVouchers} />
                      <span>현재 목록 전체</span>
                    </label>
                    <span>{selectedVoucherIds.length.toLocaleString()}개 선택</span>
                    <button type="button" disabled={vouchersUnconfirmed || !selectedVoucherIds.length || busyId !== null} onClick={() => void deleteVouchers("selected")}>선택 삭제</button>
                    <button className="danger" type="button" disabled={vouchersUnconfirmed || product.availableVouchers < 1 || busyId !== null} onClick={() => void deleteVouchers("all")}>{deletingVouchers ? "삭제 중…" : "전부 지우기"}</button>
                  </div>
                  {voucherListLoading && !vouchers.length ? <p className="shop-voucher-empty">지급 이미지 목록을 불러오는 중입니다.</p> : vouchers.length ? <div className="shop-voucher-thumbnails">
                    {vouchers.map((voucher) => <label className={selectedVoucherIds.includes(voucher.id) ? "selected" : ""} key={voucher.id}>
                      <input type="checkbox" checked={selectedVoucherIds.includes(voucher.id)} disabled={busyId !== null} onChange={() => toggleVoucher(voucher.id)} />
                      <img src={voucher.imageUrl} alt={voucher.originalName || `지급 이미지 ${voucher.id}`} loading="lazy" />
                      <span title={voucher.originalName}>{voucher.originalName || `이미지 ${voucher.id}`}</span>
                      <small>{compactBytes(voucher.sizeBytes)}</small>
                    </label>)}
                  </div> : <p className="shop-voucher-empty">삭제할 수 있는 지급 이미지가 없습니다.</p>}
                  {voucherHasMore && <button className="shop-voucher-more" type="button" disabled={voucherListLoading || busyId !== null} onClick={() => void loadVoucherList(product.id, true)}>{voucherListLoading ? "불러오는 중…" : "이미지 더 보기"}</button>}
                </div>}
              </div>
            </section>
          </div>}
        </article>;
      }) : <p className="admin-empty">등록된 상점 상품이 없습니다.</p>}
    </div>
  </section>;
}
