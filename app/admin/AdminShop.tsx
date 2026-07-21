"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";

export type AdminShopProduct = {
  id: number;
  name: string;
  description: string;
  price: number;
  stock: number;
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

type ProductDraft = {
  name: string;
  description: string;
  price: string;
  stock: string;
  active: boolean;
  version: number;
};

const draftOf = (product: AdminShopProduct): ProductDraft => ({
  name: product.name,
  description: product.description,
  price: String(product.price),
  stock: String(product.stock),
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
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "vouchers" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

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
    const nextId = expandedId === product.id ? null : product.id;
    setExpandedId(nextId);
    setDraft(nextId === null ? null : draftOf(product));
    setImageFile(null);
    setVoucherFiles([]);
    setError("");
    setStatus("");
  };

  const applyProduct = (product: AdminShopProduct) => {
    const next = products.map((item) => item.id === product.id ? product : item);
    setProducts(next);
    setLowStockCount(lowStockProductCount(next));
    setDraft(draftOf(product));
  };

  const saveProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProduct || !draft || busyId !== null) return;
    const name = draft.name.trim();
    const price = Number(draft.price);
    const stock = Number(draft.stock);
    if (name.length < 2 || name.length > 60) return setError("상품명은 2~60자로 입력해 주세요.");
    if (draft.description.trim().length > 160) return setError("상품 설명은 160자 이하로 입력해 주세요.");
    if (!Number.isSafeInteger(price) || price < 1 || price > 100_000_000) return setError("가격은 1~100,000,000P 사이의 정수로 입력해 주세요.");
    if (!Number.isSafeInteger(stock) || stock < 0 || stock > 1_000_000) return setError("판매수량은 0~1,000,000개 사이의 정수로 입력해 주세요.");

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
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "자동상품 지급 이미지를 등록하지 못했습니다.");
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
        const stockEmpty = product.stock === 0;
        const stockLow = product.stock > 0 && product.stock <= 5;
        const vouchersEmpty = product.availableVouchers === 0;
        const vouchersLow = product.availableVouchers > 0 && product.availableVouchers <= 5;
        return <article className={`shop-product-card${expanded ? " expanded" : ""}${product.active ? "" : " inactive"}`} key={product.id}>
          <button className="shop-product-summary" type="button" aria-expanded={expanded} aria-controls={`shop-product-editor-${product.id}`} disabled={busyId !== null && busyId !== product.id} onClick={() => openProduct(product)}>
            <span className="shop-product-thumbnail">{product.imageUrl ? <img src={product.imageUrl} alt={`${product.name} 대표사진`} /> : <span aria-hidden="true">NO IMAGE</span>}</span>
            <span className="shop-product-name"><b>{product.name}</b><small>{product.active ? "공개 중" : "숨김"}</small></span>
            <span><small>가격</small><b>{product.price.toLocaleString()}P</b></span>
            <span className={stockEmpty || stockLow ? "low" : ""}><small>판매수량</small><b>{product.stock.toLocaleString()}개</b></span>
            <span className={vouchersEmpty || vouchersLow ? "low" : ""}><small>지급이미지</small><b>{product.availableVouchers.toLocaleString()}개</b></span>
            <span className="shop-product-toggle" aria-hidden="true">{expanded ? "접기 −" : "수정 +"}</span>
          </button>

          {(vouchersEmpty || vouchersLow) && <div className="shop-product-warnings" role="status">
            {vouchersEmpty ? <p className="critical">자동상품 지급 이미지가 모두 소진되었습니다.</p> : vouchersLow && <p>자동상품 지급 이미지가 {product.availableVouchers.toLocaleString()}개 남았습니다. 재고를 추가해 주세요.</p>}
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
                <strong className={product.availableVouchers <= 5 ? "low" : ""}>{product.availableVouchers.toLocaleString()}개 사용 가능</strong>
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
            </section>
          </div>}
        </article>;
      }) : <p className="admin-empty">등록된 상점 상품이 없습니다.</p>}
    </div>
  </section>;
}
