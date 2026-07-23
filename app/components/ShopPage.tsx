"use client";

import NextImage from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

export type ShopProduct = {
  id: number;
  name: string;
  description: string;
  price: number;
  stock: number;
  minLevel: number;
  imageUrl: string | null;
  availableVouchers: number;
  active: boolean;
};

export type ShopViewer = {
  points: number;
  level: number;
};

export type ShopPurchase = {
  id: number;
  delivered: boolean;
};

export type ShopPageProps = {
  viewer: ShopViewer | null;
  onLoginRequired: () => void;
  onSessionExpired: () => void;
  onPointsChange: (points: number) => void;
  showToast: (message: string) => void;
};

type ShopResponse = {
  products?: ShopProduct[];
  user?: { points: number } | null;
  error?: string;
};

type PurchaseResponse = {
  purchase?: ShopPurchase;
  product?: ShopProduct;
  points?: number;
  error?: string;
};

type ModalStage = "confirm" | "success";

export const SHOP_PURCHASE_SUCCESS_MESSAGE = "상품을 구매 하셨습니다.\n고객센터에서 확인이 가능 합니다.\n혹시 확인이 되지 않으시면 고객센터로 문의 주세요.";

function isAvailable(product: ShopProduct, viewerLevel = 10) {
  return product.active && product.stock > 0 && viewerLevel >= product.minLevel;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function ShopPage({ viewer, onLoginRequired, onSessionExpired, onPointsChange, showToast }: ShopPageProps) {
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<ShopProduct | null>(null);
  const [modalStage, setModalStage] = useState<ModalStage>("confirm");
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState("");
  const requestKeyRef = useRef("");
  const purchaseLockRef = useRef(false);
  const loadRequestRef = useRef(0);
  const onPointsChangeRef = useRef(onPointsChange);
  const onSessionExpiredRef = useRef(onSessionExpired);
  const showToastRef = useRef(showToast);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const successButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const purchaseTriggerRef = useRef<HTMLButtonElement | null>(null);
  const shopHeadingRef = useRef<HTMLHeadingElement>(null);
  const viewerRef = useRef(viewer);

  useEffect(() => { onPointsChangeRef.current = onPointsChange; }, [onPointsChange]);
  useEffect(() => { onSessionExpiredRef.current = onSessionExpired; }, [onSessionExpired]);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);
  useEffect(() => { viewerRef.current = viewer; }, [viewer]);

  const restorePurchaseFocus = useCallback(() => {
    window.setTimeout(() => {
      const trigger = purchaseTriggerRef.current;
      if (trigger && document.contains(trigger) && !trigger.disabled) trigger.focus();
      else shopHeadingRef.current?.focus();
    }, 0);
  }, []);

  const loadProducts = useCallback(async (silent = false) => {
    const requestId = ++loadRequestRef.current;
    if (!silent) {
      setLoading(true);
      setLoadError("");
    }

    try {
      const response = await fetch("/api/shop", { cache: "no-store" });
      const result = await response.json() as ShopResponse;
      if (!response.ok) throw new Error(result.error ?? "상품을 불러오지 못했습니다.");
      if (!Array.isArray(result.products)) throw new Error("상품 정보를 확인하지 못했습니다.");
      if (loadRequestRef.current !== requestId) return;
      const nextProducts = result.products.slice(0, 10);
      setProducts(nextProducts);
      setSelectedProduct((current) => {
        if (!current) return current;
        const refreshed = nextProducts.find((product) => product.id === current.id) ?? null;
        if (!refreshed) {
          requestKeyRef.current = "";
          restorePurchaseFocus();
        }
        return refreshed;
      });
      if (result.user && Number.isFinite(result.user.points)) onPointsChangeRef.current(result.user.points);
      else if (viewerRef.current) onSessionExpiredRef.current();
    } catch (error) {
      if (loadRequestRef.current !== requestId) return;
      if (!silent) {
        const message = errorMessage(error, "상품을 불러오지 못했습니다.");
        setLoadError(message);
        showToastRef.current(message);
      }
    } finally {
      if (!silent && loadRequestRef.current === requestId) setLoading(false);
    }
  }, [restorePurchaseFocus]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProducts(), 0);
    return () => {
      window.clearTimeout(timer);
      loadRequestRef.current += 1;
    };
  }, [loadProducts]);

  useEffect(() => {
    if (!selectedProduct) return;
    const timer = window.setTimeout(() => {
      const preferred = modalStage === "success" ? successButtonRef.current : confirmButtonRef.current;
      if (preferred && !preferred.disabled) {
        preferred.focus();
        return;
      }
      modalRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      )?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [modalStage, selectedProduct]);

  useEffect(() => {
    if (!selectedProduct) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && modalStage === "confirm" && !purchaseLockRef.current) {
        event.preventDefault();
        setSelectedProduct(null);
        setPurchaseError("");
        requestKeyRef.current = "";
        window.setTimeout(() => purchaseTriggerRef.current?.focus(), 0);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!modalRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalStage, selectedProduct]);

  const openPurchase = (product: ShopProduct, trigger: HTMLButtonElement) => {
    if (!viewer) {
      onLoginRequired();
      return;
    }
    if (!isAvailable(product, viewer.level)) return;
    purchaseTriggerRef.current = trigger;
    requestKeyRef.current = crypto.randomUUID();
    setPurchaseError("");
    setModalStage("confirm");
    setSelectedProduct(product);
  };

  const closeConfirmation = () => {
    if (purchaseLockRef.current) return;
    setSelectedProduct(null);
    setPurchaseError("");
    requestKeyRef.current = "";
    restorePurchaseFocus();
  };

  const closeSuccess = () => {
    setSelectedProduct(null);
    setPurchaseError("");
    setModalStage("confirm");
    requestKeyRef.current = "";
    restorePurchaseFocus();
  };

  const purchase = async () => {
    if (!selectedProduct || purchaseLockRef.current) return;
    if (!viewer) {
      closeConfirmation();
      onLoginRequired();
      return;
    }
    if (!isAvailable(selectedProduct, viewer.level) || viewer.points < selectedProduct.price) return;

    purchaseLockRef.current = true;
    setPurchasing(true);
    setPurchaseError("");
    try {
      const response = await fetch("/api/shop/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: selectedProduct.id, requestKey: requestKeyRef.current }),
      });
      const result = await response.json() as PurchaseResponse;
      if (response.status === 401) {
        setSelectedProduct(null);
        requestKeyRef.current = "";
        onSessionExpiredRef.current();
        return;
      }
      if (!response.ok || !result.purchase || !result.product || !Number.isFinite(result.points)) {
        throw new Error(result.error ?? "상품을 구매하지 못했습니다.");
      }

      setProducts((current) => current.map((product) => product.id === result.product!.id ? result.product! : product));
      onPointsChange(result.points!);
      setModalStage("success");
      void loadProducts(true);
    } catch (error) {
      const message = errorMessage(error, "상품을 구매하지 못했습니다.");
      setPurchaseError(message);
      showToast(message);
      void loadProducts(true);
    } finally {
      purchaseLockRef.current = false;
      setPurchasing(false);
    }
  };

  const balance = viewer?.points ?? 0;

  return <section className="shop-page page-width" aria-labelledby="shop-title">
    <header className="shop-heading">
      <div><p className="eyebrow">POINT SHOP</p><h1 ref={shopHeadingRef} tabIndex={-1} id="shop-title">포인트 상점</h1><p>보유한 포인트로 원하는 상품을 구매할 수 있습니다.</p></div>
      <div className="shop-balance" aria-label={`보유 포인트 ${balance.toLocaleString()}P`}><span>보유 포인트</span><strong>{balance.toLocaleString()}P</strong></div>
    </header>

    {loading ? <div className="shop-state" role="status">상품을 불러오는 중입니다.</div>
      : loadError ? <div className="shop-state shop-error" role="alert"><p>{loadError}</p><button type="button" onClick={() => void loadProducts()}>다시 불러오기</button></div>
        : products.length ? <div className="shop-product-grid" aria-label="포인트 상품 목록">
          {products.map((product) => {
            const inStock = product.active && product.stock > 0;
            const levelAllowed = !viewer || viewer.level >= product.minLevel;
            return <article className={`shop-product-card${inStock ? "" : " sold-out"}${levelAllowed ? "" : " level-locked"}`} key={product.id}>
              <div className="shop-product-image">
                {product.imageUrl ? <NextImage src={product.imageUrl} alt={`${product.name} 상품 이미지`} width={800} height={600} unoptimized /> : <span aria-hidden="true">POINT SHOP</span>}
                {!inStock && <em>품절</em>}
              </div>
              <div className="shop-product-content">
                <span className="shop-product-stock">{inStock ? `남은 수량 ${product.stock.toLocaleString()}개` : "품절"}</span>
                <h2>{product.name}</h2>
                <p>{product.description}</p>
                <span className="shop-product-level">Lv.{product.minLevel} 이상</span>
                <div><strong>{product.price.toLocaleString()}P</strong><button type="button" disabled={!inStock || (!!viewer && !levelAllowed)} onClick={(event) => openPurchase(product, event.currentTarget)}>{!inStock ? "품절" : viewer && !levelAllowed ? "레벨 부족" : "구매하기"}</button></div>
              </div>
            </article>;
          })}
        </div> : <div className="shop-state">등록된 상품이 없습니다.</div>}

    {selectedProduct && <div className="modal-backdrop shop-modal-backdrop">
      <section ref={modalRef} className={`modal shop-purchase-modal ${modalStage === "success" ? "success" : "confirm"}`} role="dialog" aria-modal="true" aria-labelledby="shop-modal-title" aria-describedby="shop-modal-description">
        {modalStage === "confirm" ? <>
          <button type="button" className="modal-close" aria-label="구매 확인 닫기" disabled={purchasing} onClick={closeConfirmation}>×</button>
          <p className="eyebrow">PURCHASE</p>
          <h2 id="shop-modal-title">구매하시겠습니까?</h2>
          <p className="modal-lead" id="shop-modal-description">구매할 상품과 사용 포인트를 확인해 주세요.</p>
          <div className="shop-purchase-product"><span>상품</span><strong>{selectedProduct.name}</strong></div>
          <dl className="shop-purchase-summary">
            <div><dt>보유 포인트</dt><dd>{balance.toLocaleString()}P</dd></div>
            <div><dt>상품 가격</dt><dd>-{selectedProduct.price.toLocaleString()}P</dd></div>
            <div><dt>구매 후 포인트</dt><dd>{Math.max(0, balance - selectedProduct.price).toLocaleString()}P</dd></div>
          </dl>
          {balance < selectedProduct.price && <p className="shop-purchase-warning" role="alert">포인트가 부족합니다.</p>}
          {purchaseError && <p className="shop-purchase-error" role="alert">{purchaseError}</p>}
          <div className="shop-modal-actions"><button type="button" disabled={purchasing} onClick={closeConfirmation}>취소</button><button ref={confirmButtonRef} type="button" disabled={purchasing || balance < selectedProduct.price || !isAvailable(selectedProduct, viewer?.level ?? 0)} onClick={() => void purchase()}>{purchasing ? "구매 중…" : "구매 확인"}</button></div>
        </> : <>
          <p className="eyebrow">PURCHASE COMPLETE</p>
          <h2 id="shop-modal-title">구매가 완료되었습니다.</h2>
          <p className="shop-purchase-success-message" id="shop-modal-description" role="alert">
            {SHOP_PURCHASE_SUCCESS_MESSAGE.split("\n").map((line, index) => <span key={line}>{line}{index < 2 && <br />}</span>)}
          </p>
          <div className="shop-modal-actions single"><button ref={successButtonRef} type="button" onClick={closeSuccess}>확인</button></div>
        </>}
      </section>
    </div>}
  </section>;
}
