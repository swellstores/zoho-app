// A "sellable unit" is what becomes one Zoho item: each variant of a product
// with variants, or the product itself when it has none.

interface StandardOption {
  active?: boolean | null;
  price?: number | null;
}

interface PurchaseOptions {
  standard?: StandardOption | null;
  subscription?: { active?: boolean | null; plans?: Array<{ active?: boolean | null; price?: number | null }> } | null;
}

export interface SwellVariant {
  id: string;
  name?: string;
  sku?: string | null;
  /** Legacy mirror of purchase_options.standard.price */
  price?: number | null;
  purchase_options?: { standard?: StandardOption | null } | null;
  stock_level?: number | null;
  active?: boolean;
  archived?: boolean;
}

export interface SwellProduct {
  id: string;
  name?: string;
  sku?: string | null;
  /** Legacy mirror of purchase_options.standard.price */
  price?: number | null;
  purchase_options?: PurchaseOptions | null;
  stock_level?: number | null;
  stock_tracking?: boolean;
  active?: boolean;
  bundle?: boolean;
  type?: string;
  delivery?: string;
  variants?: { results?: SwellVariant[] } | SwellVariant[];
}

export interface SellableUnit {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string | null;
  /** Regular selling price; also values opening stock in Zoho */
  price: number;
  stockLevel: number;
  /** Swell tracks stock for this product */
  tracked: boolean;
  active: boolean;
}

// Zoho item names are limited to 100 characters.
const MAX_NAME = 100;

function truncate(value: string): string {
  return value.length > MAX_NAME ? `${value.slice(0, MAX_NAME - 1)}…` : value;
}

function cleanSku(value: string | null | undefined): string | null {
  const sku = value?.trim();
  return sku ? sku : null;
}

const amount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The regular price: the standard purchase option first (the variant's, then
 * the product's), then the legacy `price` fields that mirror it, then the
 * first active subscription plan for subscription-only products.
 */
export function unitPrice(product: SwellProduct, variant?: SwellVariant): number {
  const standard = product.purchase_options?.standard;
  const standardOn = standard?.active !== false;
  const plan = product.purchase_options?.subscription?.plans?.find((p) => p.active !== false && amount(p.price) !== null);
  return (
    amount(variant?.purchase_options?.standard?.price) ??
    amount(variant?.price) ??
    (standardOn ? amount(standard?.price) : null) ??
    amount(product.price) ??
    amount(plan?.price) ??
    0
  );
}

function variantList(product: SwellProduct): SwellVariant[] {
  const variants = product.variants;
  if (!variants) return [];
  return Array.isArray(variants) ? variants : (variants.results ?? []);
}

/** Bundles and gift cards are not stocked goods; they are left out for now. */
export function isSyncable(product: SwellProduct): boolean {
  return !product.bundle && product.type !== 'giftcard' && product.delivery !== 'giftcard';
}

export function sellableUnits(product: SwellProduct): SellableUnit[] {
  const productName = product.name?.trim() || product.id;
  const tracked = Boolean(product.stock_tracking);
  const variants = variantList(product).filter((v) => !v.archived);

  if (variants.length) {
    return variants.map((v) => ({
      productId: product.id,
      variantId: v.id,
      name: truncate(v.name ? `${productName} — ${v.name}` : productName),
      sku: cleanSku(v.sku),
      price: unitPrice(product, v),
      stockLevel: v.stock_level ?? 0,
      tracked,
      active: Boolean(product.active) && v.active !== false,
    }));
  }

  return [
    {
      productId: product.id,
      variantId: null,
      name: truncate(productName),
      sku: cleanSku(product.sku),
      price: unitPrice(product),
      stockLevel: product.stock_level ?? 0,
      tracked,
      active: Boolean(product.active),
    },
  ];
}
