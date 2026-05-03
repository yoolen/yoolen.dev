<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import {
  calcPurchasePrice,
  calcNumPeriods,
  calcShares,
  calcPriorFmvConsumed,
  calcIrsRemainingFmv,
  calcIrsMaxCost,
  calcRecommendedPct,
  calcGain,
  calcGainPct,
  calcAnnualizedGainPct,
  type PayFrequency,
  type PriorPeriod,
} from "../utils/espp";

const STORAGE_KEY = "espp-calculator-state";
const PRICE_CACHE_KEY = "espp-price-cache";
const AV_KEY_STORAGE = "espp-av-key";
const CURRENT_PRICE_TTL_MS = 60 * 60 * 1000;

// ── Form state ───────────────────────────────────────────────────────────────
const ticker = ref("");
const offeringStartDate = ref("");
const offeringStartPrice = ref<number | null>(null);
const currentEndPrice = ref<number | null>(null);
const paycheckGross = ref<number | null>(null);
const payFrequency = ref<PayFrequency>("biweekly");
const offeringMonths = ref<3 | 6 | 12 | 24>(6);
const contributionPct = ref(5);
const discountPct = ref(15);
const lookback = ref(true);
const actualContributions = ref<number | null>(null);
const priorPeriods = ref<Array<{
  date: string;
  contributions: number | null;
  endPrice: number | null;
  fetching: boolean;
  fetchError: string;
}>>([]);
const avApiKey = ref("");

// ── Fetch / error state ──────────────────────────────────────────────────────
const fetchingStart = ref(false);
const fetchingCurrent = ref(false);
const startFetchError = ref("");
const currentFetchError = ref("");

// ── Core calculations ────────────────────────────────────────────────────────
const numPeriods = computed(() =>
  calcNumPeriods(offeringMonths.value, payFrequency.value),
);

const perPaycheck = computed(() => {
  if (!paycheckGross.value) return null;
  return paycheckGross.value * (contributionPct.value / 100);
});

const totalContributions = computed(() => {
  if (actualContributions.value !== null) return actualContributions.value;
  if (!perPaycheck.value) return null;
  return perPaycheck.value * numPeriods.value;
});

const purchasePrice = computed(() => {
  if (!offeringStartPrice.value) return null;
  const endPrice = currentEndPrice.value ?? offeringStartPrice.value;
  return calcPurchasePrice(
    offeringStartPrice.value,
    endPrice,
    discountPct.value,
    lookback.value,
  );
});

const sharesEstimate = computed(() => {
  if (!totalContributions.value || !purchasePrice.value) return null;
  return calcShares(totalContributions.value, purchasePrice.value);
});

// IRS calculations
const priorFmvConsumed = computed(() => {
  if (!offeringStartPrice.value) return 0;
  const validPeriods: PriorPeriod[] = priorPeriods.value
    .filter((p) => p.contributions != null && p.contributions > 0 && p.endPrice != null)
    .map((p) => ({ contributions: p.contributions!, endPrice: p.endPrice! }));
  return calcPriorFmvConsumed(validPeriods, discountPct.value, offeringStartPrice.value, lookback.value);
});

const irsRemainingFmv = computed(() =>
  calcIrsRemainingFmv(priorFmvConsumed.value),
);

const irsMaxShares = computed(() => {
  if (!offeringStartPrice.value) return null;
  return irsRemainingFmv.value / offeringStartPrice.value;
});

const irsMaxCost = computed(() => {
  if (irsMaxShares.value === null || !purchasePrice.value) return null;
  return calcIrsMaxCost(
    irsRemainingFmv.value,
    offeringStartPrice.value!,
    purchasePrice.value,
  );
});

const recommendedMaxPct = computed(() => {
  if (!irsMaxCost.value || !paycheckGross.value) return null;
  return calcRecommendedPct(
    irsMaxCost.value,
    paycheckGross.value,
    numPeriods.value,
  );
});

const exceedsIrsLimit = computed(() => {
  if (recommendedMaxPct.value === null) return false;
  return contributionPct.value > recommendedMaxPct.value;
});

// Gain estimates (requires end price)
const immediateGain = computed(() => {
  if (!sharesEstimate.value || !currentEndPrice.value || !totalContributions.value)
    return null;
  return calcGain(sharesEstimate.value, currentEndPrice.value, totalContributions.value);
});

const immediateGainPct = computed(() => {
  if (immediateGain.value === null || !totalContributions.value) return null;
  return calcGainPct(immediateGain.value, totalContributions.value);
});

const annualizedGainPct = computed(() => {
  if (!immediateGainPct.value) return null;
  return calcAnnualizedGainPct(immediateGainPct.value, offeringMonths.value);
});

// IRS progress bar (prior periods consumed)
const irsCapUsedPct = computed(() =>
  Math.min(100, (priorFmvConsumed.value / 25000) * 100),
);

// ── Prior period helpers ─────────────────────────────────────────────────────
function addPriorPeriod() {
  priorPeriods.value.push({ date: "", contributions: null, endPrice: null, fetching: false, fetchError: "" });
}

function removePriorPeriod(index: number) {
  priorPeriods.value.splice(index, 1);
}

// ── Stock price fetching ─────────────────────────────────────────────────────
interface PriceCacheEntry {
  price: number;
  timestamp?: number;
}

function getPriceCache(): Record<string, PriceCacheEntry> {
  try {
    return JSON.parse(localStorage.getItem(PRICE_CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function setPriceCache(key: string, price: number, withTtl = false) {
  const cache = getPriceCache();
  cache[key] = withTtl ? { price, timestamp: Date.now() } : { price };
  localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
}

function getCachedPrice(key: string): number | null {
  const entry = getPriceCache()[key];
  if (!entry) return null;
  if (entry.timestamp && Date.now() - entry.timestamp > CURRENT_PRICE_TTL_MS) return null;
  return entry.price;
}

function findClosestTradingDay(
  series: Record<string, Record<string, string>>,
  targetDate: string,
): { price: number; date: string } | null {
  const d = new Date(targetDate + "T00:00:00Z");
  for (let i = 0; i < 10; i++) {
    const key = d.toISOString().slice(0, 10);
    if (series[key]) return { price: parseFloat(series[key]["4. close"]), date: key };
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return null;
}

async function fetchHistoricalPrice(t: string, date: string): Promise<number> {
  const cacheKey = `${t}:${date}`;
  const cached = getCachedPrice(cacheKey);
  if (cached !== null) return cached;

  let price: number;
  if (avApiKey.value) {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${t}&apikey=${avApiKey.value}&outputsize=compact`;
    const data = await fetch(url).then((r) => r.json());
    const series = data["Time Series (Daily)"];
    if (!series) {
      const msg = data["Error Message"] ?? data["Note"] ?? data["Information"];
      throw new Error(msg ?? "No time series data returned — check ticker and API key");
    }
    const result = findClosestTradingDay(series, date);
    if (!result) throw new Error("No trading data found near that date");
    price = result.price;
  } else {
    const res = await fetch(`/api/stock?ticker=${encodeURIComponent(t)}&date=${date}`);
    if (!res.ok) throw new Error("No API key set — enter a price manually or add your Alpha Vantage key in ⚙ Settings below");
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    price = data.price;
  }
  setPriceCache(cacheKey, price);
  return price;
}

async function fetchStartPrice() {
  if (!ticker.value || !offeringStartDate.value) return;
  fetchingStart.value = true;
  startFetchError.value = "";
  try {
    offeringStartPrice.value = await fetchHistoricalPrice(ticker.value, offeringStartDate.value);
  } catch (e: unknown) {
    startFetchError.value = e instanceof Error ? e.message : "Network error";
  } finally {
    fetchingStart.value = false;
  }
}

async function fetchPriorPeriodPrice(index: number) {
  const period = priorPeriods.value[index];
  if (!ticker.value || !period.date) return;
  period.fetching = true;
  period.fetchError = "";
  try {
    period.endPrice = await fetchHistoricalPrice(ticker.value, period.date);
  } catch (e: unknown) {
    period.fetchError = e instanceof Error ? e.message : "Network error";
  } finally {
    period.fetching = false;
  }
}

async function fetchCurrentPrice() {
  if (!ticker.value) return;
  const cacheKey = `${ticker.value}:current`;
  const cached = getCachedPrice(cacheKey);
  if (cached !== null) {
    currentEndPrice.value = cached;
    return;
  }

  fetchingCurrent.value = true;
  currentFetchError.value = "";
  try {
    let price: number;

    if (avApiKey.value) {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker.value}&apikey=${avApiKey.value}`;
      const data = await fetch(url).then((r) => r.json());
      const quote = data["Global Quote"];
      if (!quote || !quote["05. price"]) throw new Error("Invalid ticker or API limit reached");
      price = parseFloat(quote["05. price"]);
    } else {
      const res = await fetch(
        `/api/stock?ticker=${encodeURIComponent(ticker.value)}`,
      );
      if (!res.ok) throw new Error("No API key set — enter a price manually or add your Alpha Vantage key in ⚙ Settings below");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      price = data.price;
    }

    currentEndPrice.value = price;
    setPriceCache(cacheKey, price, true);
  } catch (e: unknown) {
    currentFetchError.value = e instanceof Error ? e.message : "Network error";
  } finally {
    fetchingCurrent.value = false;
  }
}


// ── localStorage persistence ─────────────────────────────────────────────────
const formState = computed(() => ({
  ticker: ticker.value,
  offeringStartDate: offeringStartDate.value,
  offeringStartPrice: offeringStartPrice.value,
  currentEndPrice: currentEndPrice.value,
  paycheckGross: paycheckGross.value,
  payFrequency: payFrequency.value,
  offeringMonths: offeringMonths.value,
  contributionPct: contributionPct.value,
  discountPct: discountPct.value,
  lookback: lookback.value,
  actualContributions: actualContributions.value,
  priorPeriods: priorPeriods.value.map(({ date, contributions, endPrice }) => ({ date, contributions, endPrice })),
}));

watch(formState, (s) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s)), { deep: true });
watch(avApiKey, (k) => localStorage.setItem(AV_KEY_STORAGE, k));

onMounted(() => {
  avApiKey.value = localStorage.getItem(AV_KEY_STORAGE) ?? "";
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!s) return;
    if (s.ticker) ticker.value = s.ticker;
    if (s.offeringStartDate) offeringStartDate.value = s.offeringStartDate;
    if (s.offeringStartPrice != null) offeringStartPrice.value = s.offeringStartPrice;
    if (s.currentEndPrice != null) currentEndPrice.value = s.currentEndPrice;
    if (s.paycheckGross != null) paycheckGross.value = s.paycheckGross;
    if (s.payFrequency) payFrequency.value = s.payFrequency;
    if (s.offeringMonths) offeringMonths.value = s.offeringMonths;
    if (s.contributionPct != null) contributionPct.value = s.contributionPct;
    if (s.discountPct != null) discountPct.value = s.discountPct;
    if (s.lookback != null) lookback.value = s.lookback;
    if (s.actualContributions != null) actualContributions.value = s.actualContributions;
    if (Array.isArray(s.priorPeriods)) {
      priorPeriods.value = s.priorPeriods.map((p: { date?: string; contributions?: number | null; endPrice?: number | null }) => ({
        date: p.date ?? "",
        contributions: p.contributions ?? null,
        endPrice: p.endPrice ?? null,
        fetching: false,
        fetchError: "",
      }));
    }
  } catch {
    // ignore malformed storage
  }
});

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmt$(n: number | null, decimals = 2): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtN(n: number | null, decimals = 2): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPct(n: number | null, decimals = 1): string {
  if (n === null) return "—";
  return n.toFixed(decimals) + "%";
}
</script>

<template>
  <div class="space-y-5">

    <!-- ── Plan Details ──────────────────────────────────────────────────── -->
    <div class="bg-white p-6 rounded-lg border border-gray-200">
      <h2 class="text-lg font-bold text-gray-900 mb-5 flex items-center gap-2">
        <span class="w-2 h-2 bg-blue-600 rounded-full"></span>
        Plan Details
      </h2>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        <!-- Ticker -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Stock Ticker</label>
          <input
            v-model="ticker"
            type="text"
            placeholder="e.g. NVDA"
            @input="ticker = ticker.toUpperCase()"
            class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 uppercase"
          />
        </div>

        <!-- Offering start date -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Offering Start Date</label>
          <input
            v-model="offeringStartDate"
            type="date"
            class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <!-- Start price -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Price at Offering Start ($)</label>
          <div class="flex gap-2">
            <input
              v-model.number="offeringStartPrice"
              type="number"
              step="0.01"
              min="0"
              placeholder="Enter manually or fetch"
              class="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              @click="fetchStartPrice"
              :disabled="!ticker || !offeringStartDate || fetchingStart"
              class="px-3 py-2 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded-md text-xs text-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {{ fetchingStart ? "…" : "Fetch" }}
            </button>
          </div>
          <p v-if="fetchingStart" class="text-xs text-blue-500 mt-1">Fetching price…</p>
          <p v-else-if="startFetchError" class="text-xs text-red-500 mt-1">{{ startFetchError }}</p>
          <p v-else-if="offeringStartPrice" class="text-xs text-gray-400 mt-1">Uses prior trading day close if date falls on a weekend or holiday — check your plan documents for the exact method used.</p>
        </div>

        <!-- Current / end price -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Current / Expected End Price ($)
            <span class="text-gray-400 font-normal">(optional)</span>
          </label>
          <div class="flex gap-2">
            <input
              v-model.number="currentEndPrice"
              type="number"
              step="0.01"
              min="0"
              placeholder="For gain estimate"
              class="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              @click="fetchCurrentPrice"
              :disabled="!ticker || fetchingCurrent"
              class="px-3 py-2 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded-md text-xs text-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {{ fetchingCurrent ? "…" : "Fetch" }}
            </button>
          </div>
          <p v-if="currentFetchError" class="text-xs text-red-500 mt-1">{{ currentFetchError }}</p>
        </div>

        <!-- Discount % -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">ESPP Discount (%)</label>
          <input
            v-model.number="discountPct"
            type="number"
            step="1"
            min="1"
            max="15"
            class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <!-- Lookback -->
        <div class="flex items-center gap-3 pt-5">
          <input v-model="lookback" id="lookback" type="checkbox" class="w-4 h-4 accent-blue-600" />
          <label for="lookback" class="text-sm text-gray-700">
            Lookback provision
            <span class="text-gray-500">(use lower of start vs. end price)</span>
          </label>
        </div>
      </div>
    </div>

    <!-- ── Prior Periods This Year ───────────────────────────────────────── -->
    <div class="bg-white p-6 rounded-lg border border-gray-200">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold text-gray-900 flex items-center gap-2">
          <span class="w-2 h-2 bg-orange-500 rounded-full"></span>
          Prior Periods This Calendar Year
        </h2>
        <button
          @click="addPriorPeriod"
          class="flex items-center gap-1 px-3 py-1.5 bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded-md text-xs text-orange-700 font-medium transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          Add period
        </button>
      </div>

      <!-- IRS cap progress -->
      <div class="mb-4">
        <div class="flex justify-between text-xs text-gray-500 mb-1">
          <span>IRS annual cap used by prior periods</span>
          <span>{{ fmt$(priorFmvConsumed, 0) }} of $25,000 ({{ fmtPct(irsCapUsedPct, 0) }})</span>
        </div>
        <div class="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all"
            :class="irsCapUsedPct > 80 ? 'bg-red-400' : irsCapUsedPct > 50 ? 'bg-yellow-400' : 'bg-green-400'"
            :style="{ width: irsCapUsedPct + '%' }"
          ></div>
        </div>
        <p class="text-xs text-gray-400 mt-1">
          Remaining: <strong class="text-gray-600">{{ fmt$(irsRemainingFmv, 0) }}</strong>
        </p>
      </div>

      <!-- Prior period entries -->
      <div v-if="priorPeriods.length > 0" class="space-y-4 mb-3">
        <div v-for="(period, i) in priorPeriods" :key="i" class="space-y-1.5">
          <div class="flex items-center gap-2">
            <span class="text-xs text-gray-500 w-16 shrink-0">Period {{ i + 1 }}</span>
            <div class="flex gap-2 flex-1">
              <div class="flex-1">
                <label class="block text-xs text-gray-400 mb-0.5">Purchase date</label>
                <input
                  v-model="period.date"
                  type="date"
                class="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>
              <div class="flex flex-col justify-end">
                <div class="h-4 mb-0.5"></div>
                <button
                @click="fetchPriorPeriodPrice(i)"
                :disabled="!ticker || !period.date || period.fetching"
                class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded-md text-xs text-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {{ period.fetching ? "…" : "Fetch" }}
                </button>
              </div>
            </div>
            <button
              @click="removePriorPeriod(i)"
              class="text-gray-400 hover:text-red-500 transition-colors shrink-0"
              aria-label="Remove period"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div class="flex items-center gap-2 pl-[4.5rem]">
            <input
              v-model.number="period.contributions"
              type="number"
              step="1"
              min="0"
              placeholder="Contributions ($)"
              class="flex-1 border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
            <input
              v-model.number="period.endPrice"
              type="number"
              step="0.01"
              min="0"
              placeholder="Price at purchase ($)"
              class="flex-1 border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
            <span v-if="period.contributions && period.endPrice && offeringStartPrice" class="text-xs text-gray-500 whitespace-nowrap">
              → {{ fmt$(calcShares(period.contributions, calcPurchasePrice(offeringStartPrice, period.endPrice, discountPct, lookback)) * offeringStartPrice, 0) }} FMV
            </span>
          </div>
          <p v-if="period.fetchError" class="text-xs text-red-500 pl-[4.5rem]">{{ period.fetchError }}</p>
          <p v-else-if="period.endPrice" class="text-xs text-gray-400 pl-[4.5rem]">Uses prior trading day close if date falls on a weekend or holiday — check your plan documents for the exact method used.</p>
        </div>
      </div>

      <p v-else class="text-sm text-gray-400 mb-3">
        No prior periods — full $25,000 cap available for this period.
      </p>

      <p class="text-xs text-gray-400">
        Enter the total contributions and price at purchase for each prior period in the same calendar year. FMV is calculated exactly: shares × offering start price.
      </p>
    </div>

    <!-- ── Paycheck & Contribution ────────────────────────────────────────── -->
    <div class="bg-white p-6 rounded-lg border border-gray-200">
      <h2 class="text-lg font-bold text-gray-900 mb-5 flex items-center gap-2">
        <span class="w-2 h-2 bg-green-600 rounded-full"></span>
        Paycheck & Contribution
      </h2>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        <!-- Gross paycheck -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Gross Paycheck ($)
            <span class="text-gray-400 font-normal">(before taxes)</span>
          </label>
          <input
            v-model.number="paycheckGross"
            type="number"
            step="1"
            min="0"
            placeholder="e.g. 7500"
            class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p class="text-xs text-gray-400 mt-1">
            Post-tax deduction — contribution comes out of your take-home
          </p>
        </div>

        <!-- Pay frequency -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Pay Frequency</label>
          <select
            v-model="payFrequency"
            class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="weekly">Weekly (52×/yr)</option>
            <option value="biweekly">Bi-weekly (26×/yr)</option>
            <option value="semimonthly">Semi-monthly (24×/yr)</option>
            <option value="monthly">Monthly (12×/yr)</option>
          </select>
        </div>

        <!-- Purchase period -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Purchase Period</label>
          <select
            v-model.number="offeringMonths"
            class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option :value="3">3 months (quarterly)</option>
            <option :value="6">6 months</option>
            <option :value="12">12 months</option>
            <option :value="24">24 months</option>
          </select>
          <p class="text-xs text-gray-500 mt-1">
            {{ numPeriods }} paychecks in this purchase period.
            For multi-period offerings (e.g., 24-month offering with 6-month purchases), set this to the purchase period length.
          </p>
        </div>

        <!-- Actual contributions override -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Actual contributions to date
            <span class="text-gray-400 font-normal">(optional override)</span>
          </label>
          <input
            v-model.number="actualContributions"
            type="number"
            step="1"
            min="0"
            placeholder="Leave blank to compute from % above"
            class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p class="text-xs text-gray-400 mt-1">
            Use this if you're mid-period and know your ESPP account balance
          </p>
        </div>
      </div>

      <!-- Contribution slider -->
      <div class="mt-5" :class="actualContributions !== null ? 'opacity-50 pointer-events-none' : ''">
        <label class="block text-sm font-medium text-gray-700 mb-2">
          Contribution:
          <span class="text-blue-600 font-bold">{{ contributionPct }}%</span>
          <span v-if="perPaycheck !== null" class="text-gray-500 font-normal ml-2">
            ({{ fmt$(perPaycheck) }} / paycheck)
          </span>
          <span v-if="actualContributions !== null" class="text-gray-400 font-normal ml-2 text-xs">
            — overridden by actual amount
          </span>
        </label>
        <input
          v-model.number="contributionPct"
          type="range"
          min="0"
          max="15"
          step="0.5"
          class="w-full accent-blue-600"
        />
        <div class="flex justify-between text-xs text-gray-400 mt-1">
          <span>0%</span>
          <span v-if="recommendedMaxPct !== null" class="text-green-600 font-medium">
            Recommended max: {{ fmtPct(recommendedMaxPct) }}
          </span>
          <span>15%</span>
        </div>
        <button
          v-if="recommendedMaxPct !== null"
          @click="contributionPct = Math.round(recommendedMaxPct * 2) / 2"
          class="mt-2 text-xs text-blue-600 hover:text-blue-700 underline"
        >
          Set to recommended max ({{ fmtPct(recommendedMaxPct) }})
        </button>
      </div>
    </div>

    <!-- ── IRS Warning ────────────────────────────────────────────────────── -->
    <div
      v-if="exceedsIrsLimit"
      class="bg-yellow-50 border border-yellow-300 rounded-lg p-4 flex items-start gap-3"
    >
      <svg class="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
      <div class="flex-1">
        <p class="text-sm font-medium text-yellow-800">
          Exceeds IRS limit — contributions above {{ fmtPct(recommendedMaxPct) }} won't buy more shares
        </p>
        <div class="mt-2 text-xs text-yellow-700 font-mono bg-yellow-100 rounded p-3 space-y-1">
          <div>Remaining IRS cap:   {{ fmt$(irsRemainingFmv, 0) }} FMV</div>
          <div>Max shares:          {{ fmt$(irsRemainingFmv, 0) }} ÷ {{ fmt$(offeringStartPrice) }} = <strong>{{ fmtN(irsMaxShares) }} shares</strong></div>
          <div>Max contributions:   {{ fmtN(irsMaxShares) }} × {{ fmt$(purchasePrice) }} = <strong>{{ fmt$(irsMaxCost) }}</strong></div>
          <div class="pt-1 border-t border-yellow-200">
            Your total: {{ fmt$(paycheckGross) }} × {{ contributionPct }}% × {{ numPeriods }} paychecks = <strong class="text-yellow-900">{{ fmt$(totalContributions) }}</strong>
            ({{ fmt$((totalContributions ?? 0) - (irsMaxCost ?? 0)) }} over limit)
          </div>
        </div>
        <button
          @click="contributionPct = Math.round(recommendedMaxPct! * 2) / 2"
          class="mt-2 text-xs text-yellow-800 hover:text-yellow-900 underline font-medium"
        >
          Set to max ({{ fmtPct(recommendedMaxPct) }})
        </button>
      </div>
    </div>

    <!-- ── Results ─────────────────────────────────────────────────────────── -->
    <div
      v-if="offeringStartPrice && (paycheckGross || actualContributions !== null)"
      class="bg-white p-6 rounded-lg border border-gray-200"
    >
      <h2 class="text-lg font-bold text-gray-900 mb-5 flex items-center gap-2">
        <span class="w-2 h-2 bg-purple-600 rounded-full"></span>
        Results
      </h2>

      <!-- Primary cards -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
          <div class="text-2xl font-bold text-blue-700">{{ fmt$(perPaycheck) }}</div>
          <div class="text-xs text-blue-600 mt-1">per paycheck</div>
        </div>
        <div
          class="rounded-lg p-4 text-center border"
          :class="exceedsIrsLimit ? 'bg-yellow-50 border-yellow-300' : 'bg-green-50 border-green-200'"
        >
          <div class="text-2xl font-bold" :class="exceedsIrsLimit ? 'text-yellow-700' : 'text-green-700'">
            {{ fmt$(totalContributions) }}
          </div>
          <div class="text-xs mt-1" :class="exceedsIrsLimit ? 'text-yellow-600' : 'text-green-600'">
            this purchase period
          </div>
        </div>
        <div class="bg-purple-50 border border-purple-200 rounded-lg p-4 text-center">
          <div class="text-2xl font-bold text-purple-700">{{ fmt$(purchasePrice) }}</div>
          <div class="text-xs text-purple-600 mt-1">purchase price / share</div>
        </div>
      </div>

      <!-- Detail rows -->
      <div class="text-sm divide-y divide-gray-100">
        <div class="flex justify-between py-2">
          <span class="text-gray-600">Estimated shares purchased</span>
          <span class="font-medium text-gray-900">{{ fmtN(sharesEstimate) }}</span>
        </div>
        <div class="flex justify-between py-2">
          <span class="text-gray-600">IRS max contributions (this period)</span>
          <span class="font-medium" :class="exceedsIrsLimit ? 'text-yellow-600' : 'text-gray-900'">
            {{ fmt$(irsMaxCost) }}
          </span>
        </div>
        <div class="flex justify-between py-2">
          <span class="text-gray-600">Recommended max contribution %</span>
          <span class="font-medium" :class="exceedsIrsLimit ? 'text-yellow-600' : 'text-green-700'">
            {{ fmtPct(recommendedMaxPct) }}
          </span>
        </div>

        <template v-if="currentEndPrice">
          <div class="flex justify-between py-2">
            <span class="text-gray-600">Value at purchase date</span>
            <span class="font-medium text-gray-900">
              {{ fmt$(sharesEstimate !== null ? sharesEstimate * currentEndPrice : null) }}
            </span>
          </div>
          <div class="flex justify-between py-2">
            <span class="text-gray-600">Immediate gain (sell at purchase)</span>
            <span class="font-medium" :class="(immediateGain ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'">
              {{ fmt$(immediateGain) }} ({{ fmtPct(immediateGainPct) }})
            </span>
          </div>
          <div class="flex justify-between py-2">
            <span class="text-gray-600">Annualized return</span>
            <span class="font-medium" :class="(annualizedGainPct ?? 0) >= 0 ? 'text-green-700' : 'text-red-600'">
              {{ fmtPct(annualizedGainPct) }}
            </span>
          </div>
        </template>
      </div>

      <!-- Math breakdown -->
      <details class="mt-5">
        <summary class="text-xs text-gray-400 cursor-pointer hover:text-gray-600 select-none">
          Show IRS limit math
        </summary>
        <div class="mt-3 text-xs font-mono bg-gray-50 border border-gray-200 rounded p-4 space-y-1 text-gray-600 leading-relaxed">
          <div class="font-sans font-semibold text-gray-700 mb-2">IRS cap (Section 423)</div>
          <div>Annual cap:                 $25,000 FMV</div>
          <div>Prior periods consumed:     {{ fmt$(priorFmvConsumed, 0) }} FMV (shares × offering start price)</div>
          <div>Remaining this period:      <strong>{{ fmt$(irsRemainingFmv, 0) }}</strong></div>
          <div>Max shares:                 {{ fmt$(irsRemainingFmv, 0) }} ÷ {{ fmt$(offeringStartPrice) }} = {{ fmtN(irsMaxShares) }}</div>
          <div>Max contributions:          {{ fmtN(irsMaxShares) }} × {{ fmt$(purchasePrice) }} = <strong>{{ fmt$(irsMaxCost) }}</strong></div>
          <div>Recommended max %:          {{ fmt$(irsMaxCost) }} ÷ ({{ fmt$(paycheckGross) }} × {{ numPeriods }}) = <strong>{{ fmtPct(recommendedMaxPct) }}</strong></div>
          <div class="pt-2 border-t border-gray-200 font-sans font-semibold text-gray-700">Your numbers</div>
          <div>Per paycheck:               {{ fmt$(paycheckGross) }} × {{ contributionPct }}% = {{ fmt$(perPaycheck) }}</div>
          <div>
            This period:
            <template v-if="actualContributions !== null">
              <strong>{{ fmt$(actualContributions) }}</strong> (actual override)
            </template>
            <template v-else>
              {{ fmt$(perPaycheck) }} × {{ numPeriods }} periods = <strong :class="exceedsIrsLimit ? 'text-yellow-700' : 'text-green-700'">{{ fmt$(totalContributions) }}</strong>
            </template>
          </div>
        </div>
      </details>
    </div>

    <!-- Empty state -->
    <div v-else class="bg-white p-8 rounded-lg border border-gray-200 text-center text-gray-400">
      <p class="text-sm">Fill in your plan details and paycheck amount to see results.</p>
    </div>

    <!-- ── Settings ────────────────────────────────────────────────────────── -->
    <details class="bg-white rounded-lg border border-gray-200">
      <summary class="p-4 text-sm text-gray-500 cursor-pointer hover:text-gray-700 select-none flex items-center gap-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        Settings
      </summary>
      <div class="p-4 pt-0 border-t border-gray-100">
        <div class="mt-3">
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Alpha Vantage API Key
            <span class="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            v-model="avApiKey"
            type="password"
            placeholder="Free key from alphavantage.co"
            class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p class="text-xs text-gray-400 mt-1">
            Price fetching uses Yahoo Finance by default — no key needed.
            Add an Alpha Vantage key to fetch prices directly from your browser without going through the server.
            Get a free key at <a href="https://www.alphavantage.co/" target="_blank" rel="noopener noreferrer" class="underline hover:text-blue-500">alphavantage.co</a>.
            Stored locally in your browser.
          </p>
        </div>
      </div>
    </details>

  </div>
</template>
