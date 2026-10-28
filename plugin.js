/*!
 * Resale Sniper — <amazon-sniper> Web Component
 * Zero dependencies. Drop-in:  <script src="plugin.js" defer></script>
 *                              <amazon-sniper></amazon-sniper>
 *
 * Attributes (all optional)
 *   src           URL of the deals JSON written by parser.py   (default: "data.json")
 *   limit         Cards shown when the search box is empty      (default: 6)
 *   max-results   Cap on cards rendered for a search            (default: 60)
 *   tag           Associates tag applied to DEMO links only     (default: "yourtag-20")
 *   no-fonts      Present = don't inject the Google Font link
 *   no-demo       Present = never fall back to built-in demo data
 */
(() => {
  "use strict";

  const TAG_NAME = "amazon-sniper";
  if (customElements.get(TAG_NAME)) return;

  /* ------------------------------------------------------------------ demo data
   * Used automatically when data.json can't be loaded (e.g. opening index.html
   * from disk via file://). Schema is identical to parser.py output.
   * ASINs are placeholders. Swap in real data by running parser.py.            */
  const DEMO_DEALS = [
    ["B0DEMO0001", "Apple AirPods Max Wireless Over-Ear Headphones, Active Noise Cancelling, Space Gray", "Apple", "Used - Like New", "Damaged packaging. Item is in original condition with all accessories.", 549.0, 287.43],
    ["B0DEMO0002", "Sony WH-1000XM5 Wireless Noise Canceling Headphones, 30-Hour Battery, Black", "Sony", "Used - Very Good", "Minor cosmetic scuff on headband. Original box may be damaged.", 399.99, 214.9],
    ["B0DEMO0003", "ASUS TUF Gaming GeForce RTX 4070 Ti SUPER 16GB GDDR6X OC Edition Graphics Card", "ASUS", "Used - Like New", "Item will come in original packaging. Packaging damaged.", 849.99, 497.6],
    ["B0DEMO0004", "Apple iPad Air 11-inch (M2) Wi-Fi 128GB, Space Gray", "Apple", "Used - Very Good", "Small scratch on back casing. Screen flawless. Charger included.", 599.0, 371.2],
    ["B0DEMO0005", "Bose QuietComfort Ultra Wireless Noise Cancelling Earbuds, Black", "Bose", "Used - Like New", "Open box. Ear tips sealed. Packaging slightly crushed.", 299.0, 161.5],
    ["B0DEMO0006", "Samsung 49\" Odyssey G9 OLED Curved Gaming Monitor, 240Hz, 0.03ms", "Samsung", "Used - Very Good", "Stand base has light marks. Panel tested, no dead pixels.", 1299.99, 699.0],
    ["B0DEMO0007", "Sony PlayStation 5 Slim Console – Digital Edition", "Sony", "Used - Like New", "Damaged packaging. All cables and controller included.", 449.99, 288.75],
    ["B0DEMO0008", "MSI Gaming GeForce RTX 4060 8GB GDDR6 Ventus 2X Black OC", "MSI", "Used - Very Good", "Missing outer box. Card securely packaged by Amazon.", 299.99, 189.0],
    ["B0DEMO0009", "Apple MacBook Air 13-inch Laptop, M3 chip, 16GB RAM, 512GB SSD, Midnight", "Apple", "Used - Like New", "Item in original box with minor dents. Battery cycle count < 5.", 1299.0, 819.0],
    ["B0DEMO0010", "Nintendo Switch OLED Model with White Joy-Con", "Nintendo", "Used - Very Good", "Light wear on dock. Joy-Con tested and fully functional.", 349.99, 223.99],
    ["B0DEMO0011", "Logitech G PRO X TKL Lightspeed Wireless Mechanical Gaming Keyboard", "Logitech", "Used - Like New", "Damaged packaging. Keycaps and receiver included.", 199.99, 109.5],
    ["B0DEMO0012", "Sony Alpha 7 IV Full-Frame Mirrorless Camera Body", "Sony", "Used - Very Good", "Shutter count under 2,000. Minor mark on LCD hinge.", 2498.0, 1549.0],
    ["B0DEMO0013", "JBL Charge 5 Portable Waterproof Bluetooth Speaker, Teal", "JBL", "Used - Like New", "Customer return. Damaged retail box.", 179.95, 99.95],
    ["B0DEMO0014", "Apple Watch Series 9 GPS 45mm Midnight Aluminum Case, Sport Band M/L", "Apple", "Used - Very Good", "Faint hairline on case edge. Band unused.", 429.0, 269.0],
  ];

  const buildDemo = (tag) => {
    const deals = DEMO_DEALS.map(([asin, title, brand, condition, note, newPrice, resale]) => ({
      asin, title, brand, image: null, condition, condition_note: note,
      resale_price: resale, new_price: newPrice,
      savings: +(newPrice - resale).toFixed(2),
      discount_pct: +(((newPrice - resale) / newPrice) * 100).toFixed(1),
      currency: "USD", reference: "observed_new_price", merchant: "Amazon Resale",
      url: `https://www.amazon.com/dp/${asin}?tag=${encodeURIComponent(tag)}`,
    })).sort((a, b) => b.discount_pct - a.discount_pct);
    return { schema: 1, updated_at: new Date().toISOString(), marketplace: "www.amazon.com", currency: "USD", min_discount_pct: 35, count: deals.length, deals };
  };

  /* ------------------------------------------------------------------ helpers */
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

  // Only follow https links on an Amazon storefront host.
  const safeAmazonUrl = (raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === "https:" && (/(^|\.)amazon\.[a-z.]{2,8}$/i.test(u.hostname) || /^amzn\.to$/i.test(u.hostname)) ? u.href : null;
    } catch { return null; }
  };
  const safeImageUrl = (raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === "https:" && /(^|\.)(media-amazon|ssl-images-amazon)\.com$/i.test(u.hostname) ? u.href : null;
    } catch { return null; }
  };

  const fmtCache = new Map();
  const money = (amount, currency) => {
    const key = currency || "USD";
    if (!fmtCache.has(key)) {
      try { fmtCache.set(key, new Intl.NumberFormat(undefined, { style: "currency", currency: key })); }
      catch { fmtCache.set(key, new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" })); }
    }
    return fmtCache.get(key).format(Number(amount) || 0);
  };

  const normalize = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

  const sanitizeDeal = (d) => {
    if (!d || typeof d !== "object") return null;
    if (d.pick) {
      const url = safeAmazonUrl(d.url);
      if (!url) return null;
      return {
        pick: true, asin: String(d.asin || ""), title: String(d.title || d.asin || "Hand-picked deal"),
        brand: d.brand ? String(d.brand) : "", image: null,
        condition: String(d.condition || "Used - Like New"), note: d.condition_note ? String(d.condition_note) : "",
        pct: -1, url,
      };
    }
    const resale = Number(d.resale_price), list = Number(d.new_price);
    const url = safeAmazonUrl(d.url);
    if (!url || !(resale > 0) || !(list > resale)) return null;
    const pct = Number.isFinite(+d.discount_pct) ? +d.discount_pct : ((list - resale) / list) * 100;
    return {
      asin: String(d.asin || ""),
      title: String(d.title || d.asin || "Untitled deal"),
      brand: d.brand ? String(d.brand) : "",
      image: d.image ? safeImageUrl(d.image) : null,
      condition: String(d.condition || "Used"),
      note: d.condition_note ? String(d.condition_note) : "",
      resale, list,
      savings: Number.isFinite(+d.savings) ? +d.savings : list - resale,
      pct: Math.round(pct),
      currency: String(d.currency || "USD"),
      url,
    };
  };

  /* ------------------------------------------------------------------ styles */
  const FONT_HREF = "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=JetBrains+Mono:wght@500;700&display=swap";

  const CSS = `
    :host {
      --as-bg: #FBF8F3;          /* ivory */
      --as-panel: #FFFFFF;
      --as-line: #E7E1D6;        /* warm stone */
      --as-text: #1B2A41;        /* deep navy */
      --as-dim: #5B6472;
      --as-gold: #B08D57;        /* muted gold */
      --as-gold-ink: #8A6D3B;
      --as-green: #2F6B4F;       /* forest green: resale price */
      --as-red: #8C2F39;         /* burgundy: discount */
      --as-radius: 12px;
      --as-font: "Chakra Petch", "Rajdhani", "Segoe UI", system-ui, -apple-system, sans-serif;
      --as-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      display: block;
      container-type: inline-size;
      background: var(--as-bg);
      color: var(--as-text);
      font-family: var(--as-font);
      border: 1px solid var(--as-line);
      border-radius: calc(var(--as-radius) + 6px);
      padding: clamp(16px, 3cqi, 32px);
      box-shadow: 0 1px 2px rgba(27,42,65,.04), 0 16px 48px rgba(27,42,65,.07);
      position: relative;
      overflow: hidden;
    }
    *, *::before, *::after { box-sizing: border-box; }

    header { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 12px 24px; padding-bottom: 18px; margin-bottom: 20px; border-bottom: 1px solid var(--as-line); }
    .brand { margin: 0; font-size: clamp(26px, 5cqi, 42px); font-weight: 700; line-height: 1; letter-spacing: -.01em; text-transform: uppercase; color: var(--as-text); }
    .brand .y { color: var(--as-text); }
    .brand .p { color: var(--as-gold); }
    .live { display: inline-flex; align-items: center; gap: 8px; font: 700 11.5px/1 var(--as-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--as-green); }
    .live::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--as-green); animation: pulse 1.8s ease-in-out infinite; }
    .demo { color: var(--as-gold-ink); border: 1px solid var(--as-gold); border-radius: 4px; padding: 3px 7px; margin-left: 6px; }

    .search { position: relative; display: block; margin-bottom: 14px; }
    .search svg { position: absolute; left: 18px; top: 50%; translate: 0 -50%; width: 20px; height: 20px; color: var(--as-gold-ink); pointer-events: none; }
    input[type="search"] {
      width: 100%; padding: 17px 20px 17px 52px;
      font: 600 clamp(16px, 2.4cqi, 19px)/1.2 var(--as-font); color: var(--as-text);
      background: #FFFFFF; border: 1.5px solid var(--as-line); border-radius: var(--as-radius); outline: none;
      box-shadow: 0 1px 2px rgba(27,42,65,.05);
      transition: box-shadow .2s ease, border-color .2s ease;
    }
    input[type="search"]::placeholder { color: #9AA1AC; }
    input[type="search"]:focus { border-color: var(--as-gold); box-shadow: 0 0 0 4px rgba(176,141,87,.18); }

    .status { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; margin: 0 2px 22px; font: 500 12px/1.4 var(--as-mono); color: var(--as-dim); text-transform: uppercase; letter-spacing: .06em; }
    .status b { color: var(--as-gold-ink); font-weight: 700; }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 290px), 1fr)); gap: 22px; }

    .card {
      position: relative; display: flex; flex-direction: column; gap: 12px;
      padding: 18px; background: var(--as-panel);
      border: 1px solid var(--as-line); border-radius: var(--as-radius);
      box-shadow: 0 1px 2px rgba(27,42,65,.05), 0 6px 18px rgba(27,42,65,.05);
      transition: transform .22s cubic-bezier(.2,.8,.2,1), box-shadow .22s ease, border-color .22s ease;
      will-change: transform;
      animation: rise .32s ease both;
    }
    .card:hover, .card:focus-within {
      transform: translateY(-4px) scale(1.015); border-color: var(--as-gold);
      box-shadow: 0 2px 4px rgba(27,42,65,.06), 0 18px 40px rgba(27,42,65,.12);
      z-index: 1;
    }
    .badge {
      position: absolute; top: 14px; left: 14px; z-index: 1; padding: 6px 10px;
      font: 700 13.5px/1 var(--as-mono); letter-spacing: .02em; color: #FFFFFF; text-transform: uppercase;
      background: var(--as-red); border-radius: 4px;
      box-shadow: 0 2px 6px rgba(140,47,57,.3);
    }
    .badge.pick { background: var(--as-gold, #B08D57); box-shadow: 0 2px 6px rgba(0,0,0,.18); }
    .card .pickinfo { margin-top: auto; }
    .thumb {
      height: 150px; border-radius: 8px; display: grid; place-items: center; overflow: hidden;
      background: #F5F1EA; border: 1px solid var(--as-line);
    }
    .thumb img { max-width: 88%; max-height: 132px; object-fit: contain; mix-blend-mode: multiply; }
    .thumb .mono { font: 700 44px/1 var(--as-font); color: var(--as-gold); letter-spacing: -.02em; }
    .brandline { font: 700 11px/1 var(--as-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--as-gold-ink); }
    .title { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.28; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(1.28em * 2); }
    .cond { font-size: 13px; line-height: 1.4; color: var(--as-dim); padding: 9px 11px; border-left: 3px solid var(--as-green); background: #F1F6F3; border-radius: 0 6px 6px 0; }
    .cond strong { color: var(--as-green); font-weight: 700; }

    .prices { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 4px 12px; margin-top: auto; }
    .lbl { font: 500 10.5px/1 var(--as-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--as-dim); }
    .lbl.r { text-align: right; color: var(--as-green); }
    .was { font: 600 18px/1.1 var(--as-mono); color: #8C939E; text-decoration: line-through; text-decoration-color: var(--as-red); text-decoration-thickness: 1.5px; }
    .now { font: 700 clamp(28px, 4.5cqi, 34px)/1 var(--as-mono); color: var(--as-green); text-align: right; letter-spacing: -.03em; }

    .savings { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 6px 8px; padding: 9px 12px; background: #FAF6EE; border: 1px solid #EADFC8; border-radius: 8px; font: 700 12px/1 var(--as-mono); text-transform: uppercase; letter-spacing: .08em; color: var(--as-gold-ink); }
    .savings span { white-space: nowrap; }
    .savings span:last-child { font-size: 15px; color: var(--as-text); letter-spacing: 0; }

    .cta {
      display: block; text-align: center; text-decoration: none; padding: 15px 16px;
      font: 700 17px/1 var(--as-font); letter-spacing: .1em; text-transform: uppercase; color: #FBF8F3;
      background: var(--as-text); border-radius: 8px;
      box-shadow: 0 2px 0 rgba(27,42,65,.25);
      transition: background-color .2s ease, transform .15s ease, box-shadow .2s ease, color .2s ease;
    }
    .cta:hover { background: #24385A; color: #F3E6CC; box-shadow: 0 6px 16px rgba(27,42,65,.25); }
    .cta:active { transform: translateY(1px); }
    .cta:focus-visible { outline: 3px solid var(--as-gold); outline-offset: 3px; }

    .empty, .error { grid-column: 1 / -1; text-align: center; padding: 48px 16px; border: 1px dashed var(--as-line); border-radius: var(--as-radius); color: var(--as-dim); background: #FFFFFF; }
    .empty strong { display: block; font-size: 20px; color: var(--as-text); margin-bottom: 6px; text-transform: uppercase; }
    .skeleton { height: 420px; border-radius: var(--as-radius); background: linear-gradient(90deg, #F3EEE6 25%, #EAE3D7 50%, #F3EEE6 75%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }

    footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--as-line); font-size: 11.5px; line-height: 1.5; color: #7A818C; }

    @keyframes pulse { 50% { opacity: .35; } }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
    @keyframes shimmer { to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
      .card:hover, .card:focus-within { transform: none; }
    }
  `;

  const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

  /* ------------------------------------------------------------------ component */
  class AmazonSniper extends HTMLElement {
    static get observedAttributes() { return ["src"]; }

    #root; #els = {}; #deals = []; #index = []; #cards = new Map();
    #meta = null; #demo = false; #abort = null; #ready = false;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: "open" });
      this.#root.innerHTML = `
        <style>${CSS}</style>
        <header>
          <h2 class="brand"><span class="y">Resale</span> <span class="p">Sniper</span></h2>
          <span class="live" part="live">Live price drops<span class="demo" hidden>Demo data</span></span>
        </header>
        <label class="search">
          ${SEARCH_ICON}
          <input type="search" placeholder="Search Apple, Sony, RTX, headphones…" autocomplete="off" spellcheck="false" aria-label="Search deals" part="search">
        </label>
        <div class="status" aria-live="polite"><span class="count"></span><span class="stamp"></span></div>
        <div class="grid" role="list"></div>
        <footer>
          As an Amazon Associate I earn from qualifying purchases.
          <span class="disclaimer"></span>
        </footer>`;
      const $ = (s) => this.#root.querySelector(s);
      this.#els = { input: $("input"), grid: $(".grid"), count: $(".count"), stamp: $(".stamp"), demo: $(".demo"), disclaimer: $(".disclaimer") };
      this.#els.input.addEventListener("input", () => this.#render());
      this.#els.input.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.target.value = ""; this.#render(); } });
    }

    connectedCallback() {
      if (!this.hasAttribute("no-fonts")) this.#injectFonts();
      if (!this.#ready) { this.#ready = true; this.#load(); }
    }
    disconnectedCallback() { this.#abort?.abort(); }
    attributeChangedCallback(name, oldV, newV) { if (this.#ready && oldV !== newV) this.#load(); }

    /** Public API: replace the dataset at runtime (same shape as data.json). */
    setData(payload) { this.#ingest(payload, false); }
    /** Public API: set the search query programmatically. */
    search(q) { this.#els.input.value = q ?? ""; this.#render(); }

    get #limit() { return Math.max(1, parseInt(this.getAttribute("limit"), 10) || 6); }
    get #maxResults() { return Math.max(1, parseInt(this.getAttribute("max-results"), 10) || 60); }

    #injectFonts() {
      if (document.querySelector(`link[data-amazon-sniper-font]`)) return;
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: FONT_HREF });
      link.dataset.amazonSniperFont = "";
      document.head.append(link);
    }

    async #load() {
      this.#abort?.abort();
      this.#abort = new AbortController();
      this.#els.grid.innerHTML = `<div class="skeleton"></div>`.repeat(3);
      this.#els.count.textContent = "Scanning warehouse…";
      const src = this.getAttribute("src") || "data.json";
      const picksSrc = this.getAttribute("picks") || "picks.json";
      const get = async (url) => {
        const res = await fetch(url, { signal: this.#abort.signal, cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      };
      try {
        const [data, picks] = await Promise.allSettled([get(src), get(picksSrc)]);
        if (data.reason?.name === "AbortError" || picks.reason?.name === "AbortError") return;
        if (data.status === "rejected" && picks.status === "rejected") throw data.reason;
        const base = data.status === "fulfilled" ? data.value : {};
        const deals = Array.isArray(base) ? base : (base?.deals || []);
        const pickList = picks.status === "fulfilled" ? (Array.isArray(picks.value) ? picks.value : picks.value?.picks || []) : [];
        const meta = Array.isArray(base) ? {} : base || {};
        this.#ingest({ ...meta, deals: [...deals, ...pickList.map((p) => ({ ...p, pick: true }))] }, false);
      } catch (err) {
        if (err.name === "AbortError") return;
        if (this.hasAttribute("no-demo")) {
          this.#els.grid.innerHTML = `<div class="error">Couldn't load deals (${esc(err.message)}). Try again shortly.</div>`;
          this.#els.count.textContent = "Offline";
          return;
        }
        console.info(`[amazon-sniper] ${src} unavailable (${err.message}); showing demo data.`);
        this.#ingest(buildDemo(this.getAttribute("tag") || "yourtag-20"), true);
      }
    }

    #ingest(payload, isDemo) {
      const raw = Array.isArray(payload) ? payload : payload?.deals;
      this.#meta = Array.isArray(payload) ? {} : payload || {};
      this.#demo = isDemo;
      this.#deals = (Array.isArray(raw) ? raw : []).map(sanitizeDeal).filter(Boolean).sort((a, b) => b.pct - a.pct);
      // Pre-computed search haystack: one normalized string per deal => O(n) substring scan per keystroke.
      this.#index = this.#deals.map((d) => normalize(`${d.brand} ${d.title} ${d.condition} ${d.note} ${d.asin}`));
      this.#cards.clear();
      this.#els.demo.hidden = !isDemo;
      const updated = this.#meta.updated_at ? new Date(this.#meta.updated_at) : null;
      const when = updated && !isNaN(updated) ? updated.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
      const priced = this.#deals.some((d) => !d.pick);
      this.#root.querySelector(".live").firstChild.textContent = priced || isDemo ? "Live price drops" : "Hand-picked deals";
      this.#els.stamp.textContent = when && priced ? `Updated ${when}` : "";
      this.#els.disclaimer.textContent = isDemo
        ? "Demo listings with sample prices for layout testing only."
        : !priced
        ? "Hand-picked open-box and like-new deals. Check the current price and condition on Amazon before you buy."
        : `Prices and availability are accurate as of ${when ?? "the time indicated"} and are subject to change. Any price and availability information displayed on Amazon at the time of purchase will apply.`;
      this.#render();
    }

    #render() {
      const t0 = performance.now();
      const q = normalize(this.#els.input.value).trim();
      let list;
      if (!q) {
        list = this.#deals.slice(0, this.#limit);
      } else {
        const terms = q.split(/\s+/);
        list = [];
        for (let i = 0; i < this.#deals.length && list.length < this.#maxResults; i++) {
          const hay = this.#index[i];
          if (terms.every((t) => hay.includes(t))) list.push(this.#deals[i]);
        }
      }

      const frag = document.createDocumentFragment();
      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.innerHTML = this.#deals.length
          ? `<strong>No targets acquired</strong>Nothing matches “${esc(this.#els.input.value.trim())}”. Try a brand or product type.`
          : `<strong>No deals right now</strong>Nothing hit the discount threshold this scan. Check back in a few hours.`;
        frag.append(empty);
      } else {
        for (const d of list) frag.append(this.#card(d));
      }
      this.#els.grid.replaceChildren(frag);

      const ms = performance.now() - t0;
      this.#els.count.innerHTML = q
        ? `<b>${list.length}</b> match${list.length === 1 ? "" : "es"} · ${ms.toFixed(1)} ms`
        : this.#deals.some((d) => !d.pick)
          ? `Top <b>${list.length}</b> deepest drops of ${this.#deals.length}`
          : `<b>${list.length}</b> hand-picked deal${list.length === 1 ? "" : "s"}${this.#deals.length > list.length ? ` of ${this.#deals.length}` : ""}`;
    }

    // Cards are built once per dataset and re-used across searches.
    #card(d) {
      const key = d.asin || d.url;
      let el = this.#cards.get(key);
      if (el) return el;
      el = document.createElement("article");
      el.className = "card";
      el.setAttribute("role", "listitem");
      el.setAttribute("part", "card");
      const initials = esc((d.brand || d.title).replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "★");
      if (d.pick) {
        el.innerHTML = `
        <span class="badge pick">Hand-picked</span>
        <div class="thumb"><span class="mono" aria-hidden="true">${initials}</span></div>
        ${d.brand ? `<div class="brandline">${esc(d.brand)}</div>` : ""}
        <h3 class="title" title="${esc(d.title)}">${esc(d.title)}</h3>
        <div class="cond"><strong>Condition: ${esc(d.condition)}.</strong>${d.note ? ` ${esc(d.note)}` : ""}</div>
        <div class="savings pickinfo"><span>Open-box savings</span><span>See today's price on Amazon</span></div>
        <a class="cta" part="cta" href="${esc(d.url)}" target="_blank" rel="nofollow sponsored noopener">CHECK PRICE ⚡</a>`;
        this.#cards.set(key, el);
        return el;
      }
      el.innerHTML = `
        <span class="badge">-${d.pct}% OFF!</span>
        <div class="thumb">${d.image ? `<img src="${esc(d.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : `<span class="mono" aria-hidden="true">${initials}</span>`}</div>
        ${d.brand ? `<div class="brandline">${esc(d.brand)}</div>` : ""}
        <h3 class="title" title="${esc(d.title)}">${esc(d.title)}</h3>
        <div class="cond"><strong>Condition: ${esc(d.condition)}.</strong>${d.note ? ` ${esc(d.note)}` : ""}</div>
        <div class="prices">
          <span class="lbl">New price</span><span class="lbl r">Resale price</span>
          <span class="was">${money(d.list, d.currency)}</span><span class="now">${money(d.resale, d.currency)}</span>
        </div>
        <div class="savings"><span>Calculate Savings</span><span>You save ${money(d.savings, d.currency)}</span></div>
        <a class="cta" part="cta" href="${esc(d.url)}" target="_blank" rel="nofollow sponsored noopener">SNIPE DEAL ⚡</a>`;
      this.#cards.set(key, el);
      return el;
    }
  }

  customElements.define(TAG_NAME, AmazonSniper);
})();
