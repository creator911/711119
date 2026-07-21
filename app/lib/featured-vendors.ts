export type FeaturedVendorRow = {
  slot: number;
  industry: string;
  region: string;
  district: string;
  title: string;
  body: string;
  coverKey: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export const isFeaturedVendorSlot = (value: number): value is 1 | 2 | 3 | 4 => Number.isInteger(value) && value >= 1 && value <= 4;

export const featuredVendorCover = (slot: number, key: string | null) => {
  if (key && /^[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(key)) return `/api/media/${key}`;
  return `/images/vendor-${String(slot).padStart(2, "0")}.jpg`;
};

export const publicFeaturedVendor = (row: FeaturedVendorRow, canEdit: boolean) => ({
  slot: row.slot,
  industry: row.industry,
  region: row.region,
  district: row.district,
  title: row.title,
  body: row.body,
  coverImage: featuredVendorCover(row.slot, row.coverKey),
  version: row.version,
  canEdit,
  updatedAt: row.updatedAt,
});
