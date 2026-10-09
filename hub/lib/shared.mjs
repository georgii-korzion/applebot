// Сгенерировано `node build.mjs --hub` из src/shared/*.ts — не править руками.

// src/shared/parts.ts
var CAPS = ["256gb", "512gb", "1tb", "2tb"];
function mk(part, family, model, display, capacity, color) {
  return {
    part,
    family,
    model,
    display,
    capacity,
    color,
    path: `/ae/shop/buy-iphone/${family}/${display}-inch-display-${capacity}-${color}`
  };
}
var DUO = {
  "256gb": ["MK244AH/A", "MK254AH/A"],
  "512gb": ["MK264AH/A", "MK274AH/A"],
  "1tb": ["MK284AH/A", "MK294AH/A"],
  "2tb": ["MK2A4AH/A", "MK2C4AH/A"]
};
var PRO = [
  ["256gb", "black", "MJR54AH/A", "MJX54AH/A"],
  ["256gb", "silver", "MJR64AH/A", "MJX64AH/A"],
  ["256gb", "burgundy", "MJR74AH/A", "MJX74AH/A"],
  ["256gb", "glacier", "MJR84AH/A", "MJX84AH/A"],
  ["512gb", "black", "MJR94AH/A", "MJX94AH/A"],
  ["512gb", "silver", "MJRC4AH/A", "MJXA4AH/A"],
  ["512gb", "burgundy", "MJRD4AH/A", "MJXC4AH/A"],
  ["512gb", "glacier", "MJRE4AH/A", "MJXD4AH/A"],
  ["1tb", "black", "MJRF4AH/A", "MJXE4AH/A"],
  ["1tb", "silver", "MJRG4AH/A", "MJXF4AH/A"],
  ["1tb", "burgundy", "MJRH4AH/A", "MJXG4AH/A"],
  ["1tb", "glacier", "MJRJ4AH/A", "MJXH4AH/A"],
  ["2tb", "black", "MJRK4AH/A", "MJXJ4AH/A"],
  ["2tb", "silver", "MJRL4AH/A", "MJXK4AH/A"],
  ["2tb", "burgundy", "MJRM4AH/A", "MJXL4AH/A"],
  ["2tb", "glacier", "MJRN4AH/A", "MJXM4AH/A"]
];
var PARTS = {};
for (const cap of CAPS) {
  const [white, sky] = DUO[cap];
  PARTS[white] = mk(white, "iphone-duo", "iPhone Duo", "7.6", cap, "star-white");
  PARTS[sky] = mk(sky, "iphone-duo", "iPhone Duo", "7.6", cap, "night-sky");
}
for (const [cap, color, pro, max] of PRO) {
  PARTS[pro] = mk(pro, "iphone-18-pro", "iPhone 18 Pro", "6.3", cap, color);
  PARTS[max] = mk(max, "iphone-18-pro", "iPhone 18 Pro Max", "6.9", cap, color);
}
function normPart(p) {
  return String(p ?? "").trim().toUpperCase();
}
function getPart(p) {
  return PARTS[normPart(p)];
}
function capLabel(cap) {
  return cap.toUpperCase();
}
function colorLabel(color) {
  return color.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
function partLabel(p) {
  const x = getPart(p);
  return x ? `${x.model} ${capLabel(x.capacity)} ${colorLabel(x.color)}` : p;
}
var STORES = [
  { id: "R597", name: "Apple Dubai Mall", city: "Dubai" },
  { id: "R596", name: "Apple Mall of the Emirates", city: "Dubai" },
  { id: "R706", name: "Apple Al Maryah Island", city: "Abu Dhabi" },
  { id: "R595", name: "Apple Yas Mall", city: "Abu Dhabi" },
  { id: "R785", name: "Apple Al Jimi Mall (Al Ain)", city: "Al Ain" }
];
function storeName(id) {
  return STORES.find((s) => s.id === id)?.name ?? id ?? "";
}

// src/shared/config.ts
var IS_DEV_BUILD = typeof process.env.HUB_ALLOW_MOCK !== "undefined" && !!process.env.HUB_ALLOW_MOCK;
var LIVE_BASE = "https://www.apple.com";
var DEFAULT_IP_CHECK_URL = "https://ipinfo.io/json";
function isMockBase(baseUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl.replace(/\/$/, ""));
}
var STRATEGIES = ["refresh", "hold"];
var DEFAULT_TIMING = {
  pollMs: 1200,
  preOpenReloadMs: 3e3,
  postOpenReloadMs: 1500,
  minReloadMs: 1500,
  jitterPct: 30,
  graceSec: 20,
  atbTimeoutMs: 3e4,
  atb404BackoffMs: 1500,
  atb404MaxInRow: 5,
  manualPayTimeoutSec: 1800,
  assistAfterFailures: 3,
  closedReloadMs: 3e4,
  queueMaxWaitSec: 180,
  holdQueueWaitSec: 600,
  holdBusyWaitSec: 120,
  holdFallbackSec: 300,
  hydrateWaitMs: 2e4,
  checkoutErrorRetries: 2,
  cardWaitMs: 9e4,
  checkoutPageWaitMs: 6e4,
  continueWaitMs: 6e4
};
function defaultOrder(id = "A") {
  return {
    id,
    priority: 1,
    profiles: [],
    racersPerProfile: 1,
    targets: ["MK254AH/A", "MK244AH/A"],
    stores: ["R597", "R596", "R706"],
    city: "Dubai",
    slot: { day: null, after: null, before: null },
    payment: "applepay",
    applePayFallback: "manual",
    cardFallback: null,
    applePayClick: "debugger",
    applePayRetries: 3,
    allowApplePayExpress: false,
    contact: { firstName: "", lastName: "", email: "", phone: "05XXXXXXXX" },
    card: { number: "", expiry: "", cvv: "", name: "" },
    billing: { title: "", firstName: "", lastName: "", street: "", area: "", town: "", city: "Dubai" },
    autoPlaceOrder: false,
    autoReview: true,
    deliveryFallback: false,
    address: { street: "", area: "", city: "Dubai" }
  };
}
function defaultConfig() {
  return {
    profileId: "",
    hubUrl: "",
    openAt: "2026-10-16T16:00:00+04:00",
    mode: "auto",
    strategy: "refresh",
    proxy: null,
    autoStart: false,
    version: 0,
    cfgHash: "",
    ipCheckUrl: DEFAULT_IP_CHECK_URL,
    orders: [defaultOrder("A")],
    timing: { ...DEFAULT_TIMING },
    retries: { checkout: 4, slotsPerStore: 4 },
    limits: { maxTabsTotal: 12 },
    baseUrl: true ? "https://www.apple.com" : "https://www.apple.com"
  };
}
function str(v, d = "") {
  return v === null || v === void 0 ? d : String(v).trim();
}
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function strOrNull(v) {
  const s = str(v);
  return s ? s : null;
}
function normalizeProxy(raw) {
  if (!raw || typeof raw !== "object") return null;
  const p = raw;
  const host = str(p.host);
  if (!host && !p.port) return null;
  const out = { scheme: p.scheme === "socks5" ? "socks5" : "http", host, port: Math.round(num(p.port, 0)) };
  if (str(p.username)) out.username = str(p.username);
  if (p.password !== void 0 && p.password !== null && String(p.password) !== "") out.password = String(p.password);
  if (Array.isArray(p.bypass)) out.bypass = p.bypass.map((x) => str(x)).filter(Boolean);
  return out;
}
function normalizeOrder(o, i) {
  const od = defaultOrder(str(o?.id, String.fromCharCode(65 + i)));
  return {
    id: str(o?.id, od.id),
    priority: num(o?.priority, i + 1),
    profiles: Array.isArray(o?.profiles) ? o.profiles.map((x) => str(x)).filter(Boolean) : [],
    racersPerProfile: Math.max(1, Math.round(num(o?.racersPerProfile, od.racersPerProfile))),
    targets: Array.isArray(o?.targets) ? o.targets.map(normPart).filter(Boolean) : od.targets,
    stores: Array.isArray(o?.stores) ? o.stores.map((x) => str(x).toUpperCase()).filter(Boolean) : od.stores,
    city: str(o?.city, od.city),
    slot: {
      day: strOrNull(o?.slot?.day),
      after: strOrNull(o?.slot?.after),
      before: strOrNull(o?.slot?.before)
    },
    payment: o?.payment === "manual" ? "manual" : "applepay",
    applePayFallback: o?.applePayFallback === null ? null : "manual",
    cardFallback: o?.cardFallback === "applepay" ? "applepay" : null,
    applePayClick: o?.applePayClick === "dom" ? "dom" : "debugger",
    applePayRetries: Math.round(num(o?.applePayRetries, od.applePayRetries)),
    allowApplePayExpress: !!o?.allowApplePayExpress,
    contact: {
      firstName: str(o?.contact?.firstName),
      lastName: str(o?.contact?.lastName),
      email: str(o?.contact?.email),
      phone: str(o?.contact?.phone).replace(/[\s-]/g, "")
    },
    card: {
      number: str(o?.card?.number).replace(/[\s-]/g, ""),
      expiry: str(o?.card?.expiry),
      cvv: str(o?.card?.cvv),
      name: str(o?.card?.name)
    },
    billing: {
      title: str(o?.billing?.title),
      firstName: str(o?.billing?.firstName),
      lastName: str(o?.billing?.lastName),
      street: str(o?.billing?.street),
      area: str(o?.billing?.area),
      town: str(o?.billing?.town),
      city: str(o?.billing?.city, "Dubai")
    },
    autoReview: o?.autoReview === void 0 ? true : !!o.autoReview,
    autoPlaceOrder: !!o?.autoPlaceOrder,
    deliveryFallback: !!o?.deliveryFallback,
    address: {
      street: str(o?.address?.street),
      area: str(o?.address?.area),
      city: str(o?.address?.city, "Dubai")
    }
  };
}
function normalizeConfig(raw) {
  const d = defaultConfig();
  const r = raw && typeof raw === "object" ? raw : {};
  const orders = Array.isArray(r.orders) && r.orders.length ? r.orders.map(normalizeOrder) : d.orders;
  const t = r.timing ?? {};
  const timing = { ...DEFAULT_TIMING };
  for (const k of Object.keys(DEFAULT_TIMING)) timing[k] = num(t[k], DEFAULT_TIMING[k]);
  return {
    profileId: str(r.profileId, d.profileId),
    hubUrl: str(r.hubUrl),
    openAt: str(r.openAt, d.openAt),
    mode: r.mode === "assist" ? "assist" : "auto",
    strategy: r.strategy === "hold" ? "hold" : "refresh",
    proxy: normalizeProxy(r.proxy),
    autoStart: !!r.autoStart,
    version: Math.max(0, Math.round(num(r.version, 0))),
    cfgHash: str(r.cfgHash),
    ipCheckUrl: str(r.ipCheckUrl) || d.ipCheckUrl,
    // пустое поле в настройках → адрес по умолчанию
    orders,
    timing,
    retries: {
      checkout: num(r.retries?.checkout, d.retries.checkout),
      slotsPerStore: num(r.retries?.slotsPerStore, d.retries.slotsPerStore)
    },
    limits: { maxTabsTotal: num(r.limits?.maxTabsTotal, d.limits.maxTabsTotal) },
    baseUrl: str(r.baseUrl, d.baseUrl).replace(/\/$/, "")
  };
}
var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function validateConfig(cfg, now = Date.now()) {
  const errors = [];
  const warnings = [];
  if (!cfg.profileId) errors.push("profileId \u043F\u0443\u0441\u0442 \u2014 \u043F\u0440\u043E\u0444\u0438\u043B\u044C \u043D\u0435 \u043D\u0430\u0437\u043D\u0430\u0447\u0435\u043D (\u0437\u0430\u043F\u0443\u0441\u043A \u0441 #drop=<\u0438\u043C\u044F> \u0438\u043B\u0438 \u043F\u043E\u043B\u0435 profileId \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445)");
  if (!cfg.orders.length) errors.push("\u043D\u0435\u0442 \u043D\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u0437\u0430\u043A\u0430\u0437\u0430");
  const ids = /* @__PURE__ */ new Set();
  const profileUse = /* @__PURE__ */ new Map();
  let tabs = 0;
  for (const o of cfg.orders) {
    const p = `\u0417\u0430\u043A\u0430\u0437 ${o.id}:`;
    if (ids.has(o.id)) errors.push(`${p} id \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0435\u0442\u0441\u044F`);
    ids.add(o.id);
    const c = o.contact;
    if (!c.firstName) errors.push(`${p} \u043F\u0443\u0441\u0442\u043E\u0435 \u0438\u043C\u044F`);
    if (!c.lastName) errors.push(`${p} \u043F\u0443\u0441\u0442\u0430\u044F \u0444\u0430\u043C\u0438\u043B\u0438\u044F`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)) errors.push(`${p} \u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 email`);
    if (!/^05\d{8}$/.test(c.phone)) errors.push(`${p} \u0442\u0435\u043B\u0435\u0444\u043E\u043D \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C 05XXXXXXXX`);
    if (!o.targets.length) errors.push(`${p} \u043D\u0435\u0442 targets`);
    for (const t of o.targets) if (!PARTS[t]) errors.push(`${p} \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u043F\u0430\u0440\u0442 ${t}`);
    if (!o.stores.length) errors.push(`${p} \u043D\u0435\u0442 stores`);
    for (const s of o.stores) if (!STORES.some((x) => x.id === s)) errors.push(`${p} \u043C\u0430\u0433\u0430\u0437\u0438\u043D ${s} \u043D\u0435 \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430 \xA72.2`);
    if (o.slot.after && !HHMM.test(o.slot.after)) errors.push(`${p} slot.after \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C HH:MM`);
    if (o.slot.before && !HHMM.test(o.slot.before)) errors.push(`${p} slot.before \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C HH:MM`);
    if (o.slot.day && !/^\d{1,2}$/.test(o.slot.day)) errors.push(`${p} slot.day \u2014 \u0447\u0438\u0441\u043B\u043E \u043C\u0435\u0441\u044F\u0446\u0430`);
    if (o.deliveryFallback && (!o.address.street || !o.address.area)) errors.push(`${p} deliveryFallback \u0442\u0440\u0435\u0431\u0443\u0435\u0442 address.street \u0438 address.area`);
    if (o.card.number && !/^\d{13,19}$/.test(o.card.number)) errors.push(`${p} card.number \u2014 13\u201319 \u0446\u0438\u0444\u0440`);
    if (o.card.number && !luhn(o.card.number)) errors.push(`${p} card.number \u043D\u0435 \u043F\u0440\u043E\u0445\u043E\u0434\u0438\u0442 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443 \u043A\u043E\u043D\u0442\u0440\u043E\u043B\u044C\u043D\u043E\u0439 \u0446\u0438\u0444\u0440\u044B \u2014 \u043E\u043F\u0435\u0447\u0430\u0442\u043A\u0430?`);
    if (o.card.expiry && !/^(0[1-9]|1[0-2])\s?\/\s?(\d{2}|\d{4})$/.test(o.card.expiry)) errors.push(`${p} card.expiry \u2014 MM/YY`);
    if (o.card.cvv && !/^\d{3,4}$/.test(o.card.cvv)) errors.push(`${p} card.cvv \u2014 3\u20134 \u0446\u0438\u0444\u0440\u044B`);
    if (o.applePayRetries < 0 || o.applePayRetries > 10) errors.push(`${p} applePayRetries \u2014 \u043E\u0442 0 \u0434\u043E 10`);
    if (o.card.number && o.payment === "manual") warnings.push(`${p} \u043A\u0430\u0440\u0442\u0430 \u0437\u0430\u0434\u0430\u043D\u0430 \u2014 \u0445\u0440\u0430\u043D\u0438\u0442\u0441\u044F \u0432 \u044D\u0442\u043E\u043C \u043F\u0440\u043E\u0444\u0438\u043B\u0435 Chrome \u043E\u0442\u043A\u0440\u044B\u0442\u044B\u043C \u0442\u0435\u043A\u0441\u0442\u043E\u043C; \u043F\u043E\u0441\u043B\u0435 \u0434\u0440\u043E\u043F\u0430 \u0443\u0434\u0430\u043B\u0438 \u0435\u0451 \u0438\u0437 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043A`);
    if (o.autoPlaceOrder && o.payment === "manual") warnings.push(`${p} autoPlaceOrder \u2014 \u0440\u0430\u0441\u0448\u0438\u0440\u0435\u043D\u0438\u0435 \u043D\u0430\u0436\u043C\u0451\u0442 Place Order \u0441\u0430\u043C\u043E (\u043E\u0434\u0438\u043D \u0440\u0430\u0437); \u0435\u0441\u043B\u0438 \u0431\u0430\u043D\u043A \u043D\u0435 \u0437\u0430\u043F\u0440\u043E\u0441\u0438\u0442 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u0432 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0438, \u0437\u0430\u043A\u0430\u0437 \u043E\u0444\u043E\u0440\u043C\u0438\u0442\u0441\u044F \u0431\u0435\u0437 \u0442\u0435\u0431\u044F`);
    if (o.autoPlaceOrder && !o.autoReview) warnings.push(`${p} autoPlaceOrder \u0431\u0435\u0437 autoReview \u2014 \u0434\u043E Review \u0434\u043E\u0439\u0442\u0438 \u0434\u043E\u043B\u0436\u0435\u043D \u0447\u0435\u043B\u043E\u0432\u0435\u043A`);
    if (o.payment === "manual" && !(o.billing.street || o.address.street) && !(o.billing.area || o.address.area)) warnings.push(`${p} \u043E\u043F\u043B\u0430\u0442\u0430 \u043A\u0430\u0440\u0442\u043E\u0439: Apple \u0442\u0440\u0435\u0431\u0443\u0435\u0442 Billing Address (\u0443\u043B\u0438\u0446\u0430, Area, \u0433\u043E\u0440\u043E\u0434) \u2014 \u0437\u0430\u043F\u043E\u043B\u043D\u0438 \xAB\u041F\u043B\u0430\u0442\u0435\u043B\u044C\u0449\u0438\u043A\xBB \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445, \u0438\u043D\u0430\u0447\u0435 Review \u043D\u0435 \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F`);
    if (o.racersPerProfile > 6) warnings.push(`${p} racersPerProfile=${o.racersPerProfile} \u2014 \u043C\u043D\u043E\u0433\u043E \u0432\u043A\u043B\u0430\u0434\u043E\u043A \u0432 \u043E\u0434\u043D\u043E\u043C \u043F\u0440\u043E\u0444\u0438\u043B\u0435`);
    for (const pr of o.profiles) profileUse.set(pr, [...profileUse.get(pr) ?? [], o.id]);
    tabs += Math.max(1, o.profiles.length) * o.racersPerProfile;
  }
  for (const [pr, os] of profileUse) if (os.length > 1) errors.push(`\u043F\u0440\u043E\u0444\u0438\u043B\u044C ${pr} \u043D\u0430\u0437\u043D\u0430\u0447\u0435\u043D \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u0438\u043C \u0437\u0430\u043A\u0430\u0437\u0430\u043C: ${os.join(", ")}`);
  const mine = profileUse.get(cfg.profileId) ?? [];
  if (!mine.length && cfg.orders.length > 1) errors.push(`\u043F\u0440\u043E\u0444\u0438\u043B\u044C ${cfg.profileId} \u043D\u0435 \u043D\u0430\u0437\u043D\u0430\u0447\u0435\u043D \u043D\u0438 \u043E\u0434\u043D\u043E\u043C\u0443 \u0437\u0430\u043A\u0430\u0437\u0443`);
  if (tabs > cfg.limits.maxTabsTotal) errors.push(`\u0432\u043A\u043B\u0430\u0434\u043E\u043A \u0432\u0441\u0435\u0433\u043E ${tabs} > limits.maxTabsTotal ${cfg.limits.maxTabsTotal}`);
  const openAt = Date.parse(cfg.openAt);
  if (!Number.isFinite(openAt)) errors.push("openAt \u2014 \u043D\u0435 \u0434\u0430\u0442\u0430 ISO");
  else if (openAt <= now) warnings.push("openAt \u0432 \u043F\u0440\u043E\u0448\u043B\u043E\u043C \u2014 \u0441\u0442\u0430\u0440\u0442 \u0441\u0440\u0430\u0437\u0443 \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 \xAB\u043F\u043E\u0441\u043B\u0435 \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u044F\xBB (\u0442\u0430\u043A \u0438 \u043D\u0443\u0436\u043D\u043E \u0434\u043B\u044F \u0442\u0435\u0441\u0442\u043E\u0432 \u043D\u0430 \u0436\u0438\u0432\u043E\u043C \u0442\u043E\u0432\u0430\u0440\u0435)");
  if (!STRATEGIES.includes(cfg.strategy)) errors.push(`strategy \xAB${cfg.strategy}\xBB \u2014 \u0442\u043E\u043B\u044C\u043A\u043E refresh \u0438\u043B\u0438 hold`);
  if (cfg.strategy === "hold" && cfg.timing.holdFallbackSec < 60) warnings.push(`strategy=hold \u043F\u0440\u0438 holdFallbackSec=${cfg.timing.holdFallbackSec} \u2014 \u0447\u0435\u0440\u0435\u0437 ${cfg.timing.holdFallbackSec} \u0441 \u043F\u043E\u0441\u043B\u0435 openAt \u043F\u0440\u043E\u0444\u0438\u043B\u044C \u0432\u0441\u0451 \u0440\u0430\u0432\u043D\u043E \u043F\u0435\u0440\u0435\u0439\u0434\u0451\u0442 \u043D\u0430 refresh`);
  if (cfg.proxy) {
    const p = cfg.proxy;
    if (!p.host) errors.push("proxy.host \u043F\u0443\u0441\u0442");
    if (!(Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535)) errors.push("proxy.port \u2014 \u043E\u0442 1 \u0434\u043E 65535");
    if (!["http", "socks5"].includes(p.scheme)) errors.push("proxy.scheme \u2014 http \u0438\u043B\u0438 socks5");
    if (p.password && !p.username) errors.push("proxy.password \u0431\u0435\u0437 proxy.username");
  }
  if (cfg.timing.minReloadMs < 1500) errors.push("timing.minReloadMs < 1500 \u2014 \u043D\u0435 \u0447\u0430\u0449\u0435 \u0440\u0430\u0437\u0430 \u0432 1,5 \u0441 (\xA70)");
  if (cfg.timing.postOpenReloadMs < cfg.timing.minReloadMs) warnings.push("postOpenReloadMs < minReloadMs \u2014 \u0431\u0443\u0434\u0435\u0442 \u043F\u043E\u0434\u043D\u044F\u0442 \u0434\u043E minReloadMs");
  if (cfg.timing.pollMs < 1e3) errors.push("timing.pollMs < 1000 \u2014 \u043D\u0430\u0431\u043B\u044E\u0434\u0430\u0442\u0435\u043B\u044C \u043D\u0435 \u0447\u0430\u0449\u0435 \u0440\u0430\u0437\u0430 \u0432 \u0441\u0435\u043A\u0443\u043D\u0434\u0443 (\xA77.1)");
  if (cfg.timing.closedReloadMs < 5e3) errors.push("timing.closedReloadMs < 5000 \u2014 \u0437\u0430\u043A\u0440\u044B\u0442\u044B\u0439 \u043C\u0430\u0433\u0430\u0437\u0438\u043D \u0434\u043E \u0441\u0442\u0430\u0440\u0442\u0430 \u043D\u0435 \u0447\u0430\u0449\u0435 \u0440\u0430\u0437\u0430 \u0432 5 \u0441");
  if (cfg.timing.queueMaxWaitSec < 10) errors.push("timing.queueMaxWaitSec < 10 \u2014 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443 \u043E\u0447\u0435\u0440\u0435\u0434\u0438 Apple \u043D\u0435\u043B\u044C\u0437\u044F \u0434\u0451\u0440\u0433\u0430\u0442\u044C \u0447\u0430\u0449\u0435");
  if (cfg.timing.holdQueueWaitSec < 10) errors.push("timing.holdQueueWaitSec < 10 \u2014 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443 \u043E\u0447\u0435\u0440\u0435\u0434\u0438 Apple \u043D\u0435\u043B\u044C\u0437\u044F \u0434\u0451\u0440\u0433\u0430\u0442\u044C \u0447\u0430\u0449\u0435");
  if (cfg.timing.cardWaitMs < 3e3) errors.push("timing.cardWaitMs < 3000 \u2014 \u0431\u043B\u043E\u043A \u043A\u0430\u0440\u0442\u044B \u0443 Apple \u0433\u0440\u0443\u0437\u0438\u0442\u0441\u044F \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0441\u0435\u043A\u0443\u043D\u0434");
  if (cfg.limits.maxTabsTotal > 12) warnings.push("maxTabsTotal > 12 \u2014 \u0432\u044B\u0448\u0435 \u0440\u0435\u043A\u043E\u043C\u0435\u043D\u0434\u043E\u0432\u0430\u043D\u043D\u043E\u0433\u043E (\xA70)");
  if (!/^https?:\/\//.test(cfg.baseUrl)) errors.push("baseUrl \u0434\u043E\u043B\u0436\u0435\u043D \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 http(s)://");
  else if (!IS_DEV_BUILD && cfg.baseUrl !== LIVE_BASE) errors.push(`baseUrl \xAB${cfg.baseUrl}\xBB \u2014 \u0431\u043E\u0435\u0432\u0430\u044F \u0441\u0431\u043E\u0440\u043A\u0430 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0441 ${LIVE_BASE}; \u043C\u043E\u043A-\u0441\u0435\u0440\u0432\u0435\u0440 \u0442\u043E\u043B\u044C\u043A\u043E \u0441 dev-\u0441\u0431\u043E\u0440\u043A\u043E\u0439 (\u043F\u0430\u043F\u043A\u0430 extension-dev) \u0432 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E\u043C \u043F\u0440\u043E\u0444\u0438\u043B\u0435`);
  else if (IS_DEV_BUILD && !isMockBase(cfg.baseUrl) && cfg.baseUrl !== LIVE_BASE) errors.push(`baseUrl \xAB${cfg.baseUrl}\xBB: \u043B\u0438\u0431\u043E ${LIVE_BASE}, \u043B\u0438\u0431\u043E \u0430\u0434\u0440\u0435\u0441 \u043C\u043E\u043A\u0430 http://127.0.0.1:4777`);
  if (cfg.hubUrl && !/^wss?:\/\//.test(cfg.hubUrl)) errors.push("hubUrl \u0434\u043E\u043B\u0436\u0435\u043D \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 ws:// \u0438\u043B\u0438 wss://");
  if (!/^https?:\/\//.test(cfg.ipCheckUrl)) errors.push("ipCheckUrl \u0434\u043E\u043B\u0436\u0435\u043D \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 http(s)://");
  return { errors, warnings };
}
function luhn(num2) {
  let sum = 0;
  let dbl = false;
  for (let i = num2.length - 1; i >= 0; i--) {
    let d = Number(num2[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
function orderFor(cfg, profileId = cfg.profileId) {
  return cfg.orders.find((o) => o.profiles.includes(profileId)) ?? (cfg.orders.length === 1 ? cfg.orders[0] : void 0);
}
function serverOf(profileId) {
  const i = profileId.indexOf("-");
  return i > 0 ? profileId.slice(0, i) : profileId;
}
function parseIdentityHash(hash) {
  const h = (hash ?? "").replace(/^#/, "");
  if (!/(^|&)drop=/.test(h)) return null;
  const sp = new URLSearchParams(h);
  const profileId = (sp.get("drop") ?? "").trim();
  if (!profileId) return null;
  const hubUrl = (sp.get("hub") ?? "").trim();
  return { profileId, hubUrl };
}
function configUrlFromHub(hubUrl, profileId) {
  if (!hubUrl || !profileId) return null;
  let u;
  try {
    u = new URL(hubUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = `/config/${encodeURIComponent(profileId)}`;
  u.hash = "";
  return u.toString();
}

// src/shared/strategy.ts
function phaseMs(phase, t) {
  return { armed: t.closedReloadMs, pre: t.preOpenReloadMs, post: t.postOpenReloadMs }[phase];
}
function waitPlan(strategy, phase, kind, ctx, t) {
  const opened = !!ctx.opened;
  const hold = strategy === "hold" && !opened;
  switch (kind) {
    case "preorder": {
      if (opened) return { reload: t.postOpenReloadMs, reason: "OPEN \u0431\u044B\u043B, \u0444\u043E\u0440\u043C\u044B \u043F\u043E\u043A\u0443\u043F\u043A\u0438 \u0435\u0449\u0451 \u043D\u0435\u0442 \u2014 \u0440\u0435\u0444\u0440\u0435\u0448" };
      if (phase === "armed") return { reload: null, reason: "\u0434\u043E openAt\u221260 \u0441 \u043D\u0435 \u0440\u0435\u0444\u0440\u0435\u0448\u0438\u043C" };
      if (!hold) return { reload: phase === "pre" ? t.preOpenReloadMs : t.postOpenReloadMs, reason: phase === "pre" ? "\u043F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u043C\u0438\u043D\u0443\u0442\u0430 \u2014 \u0440\u0435\u0444\u0440\u0435\u0448" : "\u043F\u043E\u0441\u043B\u0435 openAt \u2014 \u0440\u0435\u0444\u0440\u0435\u0448" };
      if (phase === "post" && (ctx.sinceOpenAt ?? 0) >= t.holdFallbackSec * 1e3) {
        return { reload: t.postOpenReloadMs, reason: `hold \u043D\u0435 \u0434\u043E\u0436\u0434\u0430\u043B\u0441\u044F OPEN \u0437\u0430 ${t.holdFallbackSec} \u0441 \u2014 \u043F\u0435\u0440\u0435\u0445\u043E\u0436\u0443 \u043D\u0430 refresh`, fallback: true };
      }
      return { reload: null, reason: phase === "pre" ? "hold: \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u043C\u0438\u043D\u0443\u0442\u0430, \u0442\u043E\u043B\u044C\u043A\u043E JSON" : "hold: \u043F\u043E\u0441\u043B\u0435 openAt, \u0442\u043E\u043B\u044C\u043A\u043E JSON" };
    }
    case "busy": {
      const n = ctx.busyInRow ?? 0;
      if (hold) {
        if (ctx.metaRefreshSec !== void 0) return { reload: null, reason: `hold: \u0437\u0430\u0433\u043B\u0443\u0448\u043A\u0430 \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0441\u044F \u0441\u0430\u043C\u0430 \u0447\u0435\u0440\u0435\u0437 ${ctx.metaRefreshSec} \u0441 \u2014 \u043D\u0435 \u0442\u0440\u043E\u0433\u0430\u0435\u043C` };
        const left = t.holdBusyWaitSec * 1e3 - (ctx.waitedMs ?? 0);
        if (left <= 0) return { reload: 0, reason: `hold: \u0437\u0430\u0433\u043B\u0443\u0448\u043A\u0430 \u0431\u0435\u0437 meta refresh ${t.holdBusyWaitSec} \u0441 \u2014 \u043E\u0434\u0438\u043D \u0440\u0435\u0444\u0440\u0435\u0448`, fallback: true };
        return { reload: left, reason: `hold: \u0437\u0430\u0433\u043B\u0443\u0448\u043A\u0430 \u0431\u0435\u0437 meta refresh \u2014 \u0440\u0435\u0444\u0440\u0435\u0448 \u0447\u0435\u0440\u0435\u0437 ${Math.round(left / 1e3)} \u0441` };
      }
      const base = phaseMs(opened ? "post" : phase, t);
      if (phase === "post" || opened) {
        const ms = Math.min(Math.max(Math.round(base * 1.2 ** n), t.minReloadMs), 4e3);
        if (ctx.metaRefreshSec !== void 0 && ctx.metaRefreshSec <= 60) return { reload: Math.max((ctx.metaRefreshSec + 5) * 1e3, ms), reason: "\u0437\u0430\u0433\u043B\u0443\u0448\u043A\u0430 \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0441\u044F \u0441\u0430\u043C\u0430 \u2014 \u043D\u0430\u0448 \u0440\u0435\u0444\u0440\u0435\u0448 \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0442\u0440\u0430\u0445\u043E\u0432\u043A\u0430" };
        return { reload: ms, reason: `\u0437\u0430\u0433\u043B\u0443\u0448\u043A\u0430 (${n + 1}), \u0431\u044D\u043A\u043E\u0444\u0444 \u2264 4 \u0441` };
      }
      if (ctx.metaRefreshSec !== void 0 && ctx.metaRefreshSec <= 60) return { reload: Math.max((ctx.metaRefreshSec + 5) * 1e3, base), reason: "\u0437\u0430\u0433\u043B\u0443\u0448\u043A\u0430 \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u0441\u044F \u0441\u0430\u043C\u0430 \u2014 \u043D\u0430\u0448 \u0440\u0435\u0444\u0440\u0435\u0448 \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0442\u0440\u0430\u0445\u043E\u0432\u043A\u0430" };
      return { reload: base, reason: `\u0437\u0430\u0433\u043B\u0443\u0448\u043A\u0430 (${n + 1}), \u0440\u0435\u0444\u0440\u0435\u0448 \u043F\u043E \u0444\u0430\u0437\u0435` };
    }
    case "queue": {
      const limit = (hold ? t.holdQueueWaitSec : t.queueMaxWaitSec) * 1e3;
      const left = limit - (ctx.waitedMs ?? 0);
      if (left <= 0) return { reload: 0, reason: `\u043E\u0447\u0435\u0440\u0435\u0434\u044C \u043D\u0435 \u043F\u0443\u0441\u0442\u0438\u043B\u0430 \u0437\u0430 ${Math.round(limit / 1e3)} \u0441 \u2014 \u0440\u0435\u0444\u0440\u0435\u0448`, fallback: true };
      return { reload: left, reason: `\u043E\u0447\u0435\u0440\u0435\u0434\u044C Apple \u2014 \u043D\u0435 \u0442\u0440\u043E\u0433\u0430\u0435\u043C \u0435\u0449\u0451 ${Math.round(left / 1e3)} \u0441${hold ? " (hold)" : ""}` };
    }
    case "closed": {
      if (opened) return { reload: t.postOpenReloadMs, reason: "OPEN \u0431\u044B\u043B, \u043C\u0430\u0433\u0430\u0437\u0438\u043D/\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0437\u0430\u043A\u0440\u044B\u0442\u044B \u2014 \u0440\u0435\u0444\u0440\u0435\u0448" };
      if (hold) return { reload: t.closedReloadMs, reason: `hold: \u0437\u0430\u043A\u0440\u044B\u0442\u043E \u2014 \u0440\u0435\u0444\u0440\u0435\u0448 \u0440\u0430\u0437 \u0432 ${Math.round(t.closedReloadMs / 1e3)} \u0441 \u043D\u0435\u0437\u0430\u0432\u0438\u0441\u0438\u043C\u043E \u043E\u0442 \u0444\u0430\u0437\u044B` };
      return { reload: phaseMs(phase, t), reason: `\u0437\u0430\u043A\u0440\u044B\u0442\u043E \u2014 \u0440\u0435\u0444\u0440\u0435\u0448 \u043F\u043E \u0444\u0430\u0437\u0435 (${phase})` };
    }
  }
}
export {
  DEFAULT_TIMING,
  PARTS,
  STORES,
  STRATEGIES,
  configUrlFromHub,
  defaultConfig,
  defaultOrder,
  normPart,
  normalizeConfig,
  normalizeOrder,
  normalizeProxy,
  orderFor,
  parseIdentityHash,
  partLabel,
  serverOf,
  storeName,
  validateConfig,
  waitPlan
};
