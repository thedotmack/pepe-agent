export type FeeSharePlatform =
  | "twitter"
  | "tiktok"
  | "github"
  | "moltbook"
  | "solana"
  | "kick";

export type FeeShareEntry = {
  allocationBps: number;
  platform: FeeSharePlatform;
  username: string;
};

export type LaunchIntent = {
  name?: string;
  ticker?: string;
  description?: string;
  website?: string;
  twitter?: string;
  image?: string;
  initialBuy?: string | number;
  feeMode?:
    | "DEFAULT"
    | "BPS100PRE_BPS25POST_5000_COMPOUNDING"
    | "BPS1000PRE_BPS1000POST"
    | "BPS25PRE_BPS100POST_5000_COMPOUNDING"
    | "BPS1000PRE_BPS1000POST_5000_COMPOUNDING";
  feeShareEnabled?: boolean;
  feeShareType?: "multi" | "csv";
  feeShare?: FeeShareEntry[];
  admin?: string;
  partner?: string;
  partnerConfig?: string;
  showSocial?: boolean;
};

export function normalizeTicker(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 10);
}

export function trimTokenName(value: string): string {
  return value.trim().slice(0, 32);
}

export function buildLaunchIntentUrl(
  intent: LaunchIntent,
  origin = "https://bags.fm",
): string {
  const url = new URL("/launch", origin);
  const params = url.searchParams;
  params.set("intent", "true");

  const setIf = (key: string, value: string | number | undefined) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  };
  const setBool = (key: string, value: boolean | undefined) => {
    if (value === undefined) return;
    params.set(key, value ? "true" : "false");
  };
  const setJson = (key: string, value: unknown) => {
    if (value === undefined) return;
    params.set(key, JSON.stringify(value));
  };

  setIf("name", trimTokenName(intent.name ?? ""));
  setIf("ticker", normalizeTicker(intent.ticker ?? ""));
  setIf("description", intent.description?.trim());
  setIf("website", intent.website);
  setIf("twitter", intent.twitter);
  setIf("image", intent.image);
  setIf("initialBuy", intent.initialBuy);
  setIf("feeMode", intent.feeMode);
  setBool("feeShareEnabled", intent.feeShareEnabled);
  setIf("feeShareType", intent.feeShareType);
  if (intent.feeShare && intent.feeShare.length > 0) {
    setJson("feeShare", intent.feeShare);
  }
  setIf("admin", intent.admin);
  if (intent.partner && intent.partnerConfig) {
    params.set("partner", intent.partner);
    params.set("partnerConfig", intent.partnerConfig);
  }
  setBool("showSocial", intent.showSocial);

  return url.toString();
}
