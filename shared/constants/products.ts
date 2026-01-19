export const DAY_PASS_PRODUCTS = {
  workspace: {
    name: "Workspace",
    priceCents: 2500,
    priceDisplay: "$25.00",
    productType: "workspace",
  },
  golf_sim: {
    name: "Golf Simulator",
    priceCents: 5000,
    priceDisplay: "$50.00",
    productType: "golf_sim",
  },
} as const;

export type DayPassProductType = keyof typeof DAY_PASS_PRODUCTS;
