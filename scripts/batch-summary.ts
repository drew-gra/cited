/**
 * Ad-hoc batch summary — runs Layer 1 (robots.txt) across a hardcoded list of
 * outlets and prints aggregate discoverability stats (no DB, no Inngest). Same
 * fetchAndParseRobots() the production pipeline uses.
 *
 *   npx tsx scripts/batch-summary.ts
 */

import { fetchAndParseRobots } from "../src/lib/layers/robots";
import { PLATFORMS, PLATFORM_LABELS, type AiPlatform } from "../src/lib/ai-platforms";

type Access = "allowed" | "blocked" | "unknown";
type Posture = "open" | "mixed" | "blocked" | "unknown";

const URLS = [
  "https://www.mmm-online.com/",
  "https://www.prweek.com/",
  "https://www.campaignlive.com/",
  "https://www.gothamgazette.com/",
  "https://www.fiercehealthcare.com/",
  "https://www.buzzfeednews.com/",
  "https://hightimes.com/",
  "https://elplanteo.com/",
  "https://hempgazette.com/",
  "https://www.thewellnews.com/",
  "https://www.marijuanamoment.net/",
  "https://ohiocapitaljournal.com/",
  "https://www.citybeat.com/",
  "https://www.cleveland.com/",
  "https://www.fastcompany.com/",
  "https://www.crainscleveland.com/",
  "https://www.greenstate.com/",
  "https://www.ganjapreneur.com/",
  "https://www.cultivated.news/",
  "https://www.forbes.com/",
  "https://www.cannabisnews.org/",
  "https://www.mycannabis.com/",
  "https://www.benzinga.com/",
  "https://abq.news/",
  "https://www.jdsupra.com/",
  "https://patch.com/",
  "https://cannabismusings.substack.com/",
  "https://www.lexology.com/",
  "https://cannabislaw.report/",
  "https://www.cannabisnewswire.com/",
  "https://tokeativity.com/",
  "https://dabbin-dad.com/",
  "https://www.regulatoryoversight.com/",
  "https://cannabiscmo.substack.com/",
  "https://www.cannabisbusinessexecutive.com/",
  "https://toddharrison.substack.com/",
  "https://www.weedweek.com/",
  "https://cannabis.net/",
  "https://ofwlaw.com/",
  "https://thecapitolist.com/",
  "https://stopthedrugwar.org/",
  "https://talkingjointsmemo.com/",
  "https://www.msn.com/",
  "https://www.statnews.com/",
  "https://420intel.com/",
  "https://www.iheart.com/",
  "https://www.streetinsider.com/",
  "https://marijuanaindex.com/",
  "https://norml.org/",
  "https://weedmaps.com/",
  "https://enjoythefarm.com/blog",
  "https://www.barneysfarm.com/",
  "https://mjbizdaily.com/",
  "https://www.leafie.co.uk/",
  "https://subscriber.politicopro.com/",
  "https://www.dallasobserver.com/",
  "https://insightfulaccountant.com/",
  "https://businessofcannabis.com/",
  "https://www.pittsburghmagazine.com/",
  "https://www.greenmarketreport.com/",
  "https://www.mmjdaily.com/",
  "https://www.fool.com/",
  "https://www.theglobeandmail.com/",
  "https://finance.yahoo.com/",
  "https://www.nasdaq.com/",
  "https://newsletter.thedalesreport.com/",
  "https://thefreshtoast.com/",
  "https://www.investingdaily.com/",
  "https://nicotinepolicy.net/",
  "https://www.stickybits.news/",
  "https://1045theteam.com/",
  "https://weednews.home.blog/",
  "https://investorshangout.com/",
  "https://mitechnews.com/",
  "https://www.dentons.com/",
  "https://micia.org/",
  "https://www.pyramidseeds.com/",
  "https://filtermag.org/",
  "https://investingnews.com/",
  "https://www.citybuzz.co/",
  "https://www.cannabisculture.com/",
  "https://www.youtube.com/@SeniorSavvyCannabis",
  "https://internationalhighlife.com/",
  "https://newsletteremail.benzinga.com/",
  "https://www.readblunt.com/",
  "https://born2invest.com/",
  "https://thedalesreport.com/",
  "https://breeza.com.br/",
  "https://www.thcfarmer.com/",
  "https://www.cannabinoidsandthepeople.whitewhalecreations.com/",
  "https://headynj.com/",
  "https://outlawreport.com/",
  "https://greenpharms.com/",
  "https://brobible.com/",
  "https://investor.wedbush.com/",
  "https://www.businessinsurance.com/",
  "https://workmansrelief.com/",
  "https://www.afslaw.com/",
  "https://apnews.com/",
  "https://vaping360.com/",
  "https://themarijuanaherald.com/",
  "https://www.tokersguide.com/",
  "https://www.dailykos.com/",
  "https://beardbrospharms.com/",
  "https://canamo.net/",
  "https://droghe.aduc.it/",
  "https://moderncannabislifestyle.com/",
  "https://sechat.com.br/",
  "https://cultivatelv.com/",
  "https://newsbudz.com/",
  "https://www.youtube.com/@CultivatedMedia",
  "https://www.cannabisindustrydata.com/",
  "https://cardinalnews.org/",
  "https://www.youtube.com/@TheDalesReport",
  "https://www.beneschlaw.com/",
  "https://www.dsquaredworldwide.com/",
  "https://www.newsbreak.com/",
  "https://www.cabotwealth.com/",
  "https://budscannacorner.ca/",
  "https://reportwire.org/",
  "https://cannabisterpenes.com/",
  "https://www.thestreet.com/",
  "https://www.theguardian.com/",
  "https://www.aol.com/",
];

function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

function summarize(states: Access[]): Access {
  if (states.length === 0) return "unknown";
  if (states.every((s) => s === "allowed")) return "allowed";
  if (states.every((s) => s === "blocked")) return "blocked";
  return "unknown";
}

function derivePosture(t: Access, r: Access, s: Access): Posture {
  const known = [t, r, s].filter((x): x is "allowed" | "blocked" => x !== "unknown");
  if (known.length === 0) return "unknown";
  if (known.every((x) => x === "allowed")) return "open";
  if (known.every((x) => x === "blocked")) return "blocked";
  return "mixed";
}

// Outlet-level aggregate posture across all 5 platforms.
function outletAggregate(perPlatform: Record<AiPlatform, Posture>): Posture {
  const values = Object.values(perPlatform);
  if (values.every((v) => v === "unknown")) return "unknown";
  const known = values.filter((v) => v !== "unknown");
  if (known.every((v) => v === "open")) return "open";
  if (known.every((v) => v === "blocked")) return "blocked";
  return "mixed";
}

type Row = {
  domain: string;
  fetchStatus: "ok" | "not_found" | "error";
  errorMessage?: string;
  perPlatform: Record<AiPlatform, Posture>;
  outletPosture: Posture;
};

async function probeOne(domain: string): Promise<Row> {
  const result = await fetchAndParseRobots(domain);
  const perPlatform: Record<string, Posture> = {};
  for (const p of PLATFORMS) {
    const bots = result.perBot.filter((b) => b.platform === p);
    const t = summarize(bots.filter((b) => b.purpose === "training").map((b) => b.rootAccess));
    const r = summarize(bots.filter((b) => b.purpose === "realtime").map((b) => b.rootAccess));
    const s = summarize(bots.filter((b) => b.purpose === "search").map((b) => b.rootAccess));
    perPlatform[p] = derivePosture(t, r, s);
  }
  return {
    domain,
    fetchStatus: result.status,
    errorMessage: result.errorMessage,
    perPlatform: perPlatform as Record<AiPlatform, Posture>,
    outletPosture: outletAggregate(perPlatform as Record<AiPlatform, Posture>),
  };
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function main() {
  const unique = Array.from(new Set(URLS.map(normalizeDomain)));
  console.log(`# Cited batch summary — ${unique.length} unique outlets`);
  console.log(`(${URLS.length} URLs submitted; ${URLS.length - unique.length} duplicates collapsed)\n`);

  const rows: Row[] = [];
  for (let i = 0; i < unique.length; i++) {
    const d = unique[i];
    process.stderr.write(`  [${i + 1}/${unique.length}] ${d} ... `);
    try {
      const row = await probeOne(d);
      rows.push(row);
      process.stderr.write(`${row.outletPosture}${row.fetchStatus !== "ok" ? ` (${row.fetchStatus})` : ""}\n`);
    } catch (err) {
      rows.push({
        domain: d,
        fetchStatus: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        perPlatform: Object.fromEntries(PLATFORMS.map((p) => [p, "unknown"])) as Record<AiPlatform, Posture>,
        outletPosture: "unknown",
      });
      process.stderr.write(`THREW: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // ---- Aggregate per-outlet ----
  const total = rows.length;
  const counts = { open: 0, mixed: 0, blocked: 0, unknown: 0 };
  for (const r of rows) counts[r.outletPosture]++;

  console.log("\n## Per-outlet aggregate posture (across all 5 AI platforms)");
  console.log(`  open      ${String(counts.open).padStart(3)}   ${pct(counts.open, total).padStart(6)}   open to every platform`);
  console.log(`  mixed     ${String(counts.mixed).padStart(3)}   ${pct(counts.mixed, total).padStart(6)}   open to some, blocked from others`);
  console.log(`  blocked   ${String(counts.blocked).padStart(3)}   ${pct(counts.blocked, total).padStart(6)}   blocked from every platform`);
  console.log(`  unknown   ${String(counts.unknown).padStart(3)}   ${pct(counts.unknown, total).padStart(6)}   robots.txt unreachable or no signal`);

  // Headline framing: discoverable / not / uncertain
  const discoverable = counts.open;
  const notDiscoverable = counts.blocked;
  const partial = counts.mixed;
  const uncertain = counts.unknown;
  console.log("\n## Headline (discoverability framing)");
  console.log(`  fully discoverable           ${pct(discoverable, total)}   (${discoverable}/${total})`);
  console.log(`  partially discoverable       ${pct(partial, total)}   (${partial}/${total})`);
  console.log(`  not discoverable             ${pct(notDiscoverable, total)}   (${notDiscoverable}/${total})`);
  console.log(`  uncertain (no signal)        ${pct(uncertain, total)}   (${uncertain}/${total})`);

  // ---- Per-platform breakdown ----
  console.log("\n## Per-platform breakdown");
  console.log(`  ${"platform".padEnd(14)} ${"open".padStart(8)} ${"mixed".padStart(8)} ${"blocked".padStart(8)} ${"unknown".padStart(8)}`);
  for (const p of PLATFORMS) {
    const c = { open: 0, mixed: 0, blocked: 0, unknown: 0 };
    for (const r of rows) c[r.perPlatform[p]]++;
    console.log(
      `  ${PLATFORM_LABELS[p].padEnd(14)} ${(`${c.open} (${pct(c.open, total)})`).padStart(15)} ${(`${c.mixed} (${pct(c.mixed, total)})`).padStart(13)} ${(`${c.blocked} (${pct(c.blocked, total)})`).padStart(13)} ${(`${c.unknown} (${pct(c.unknown, total)})`).padStart(13)}`,
    );
  }

  // ---- Per-outlet detail table ----
  console.log("\n## Per-outlet (one row each)");
  const header = `  ${"domain".padEnd(50)} ${"overall".padEnd(9)} ${PLATFORMS.map((p) => PLATFORM_LABELS[p].padEnd(11)).join(" ")}`;
  console.log(header);
  console.log("  " + "-".repeat(header.length - 2));
  for (const r of rows) {
    const cells = PLATFORMS.map((p) => r.perPlatform[p].padEnd(11)).join(" ");
    const flag = r.fetchStatus !== "ok" ? ` !${r.fetchStatus}` : "";
    console.log(`  ${r.domain.padEnd(50)} ${r.outletPosture.padEnd(9)} ${cells}${flag}`);
  }

  // ---- Errors block ----
  const errors = rows.filter((r) => r.fetchStatus !== "ok");
  if (errors.length > 0) {
    console.log(`\n## Fetch issues (${errors.length})`);
    for (const e of errors) {
      console.log(`  ${e.domain.padEnd(50)} ${e.fetchStatus}${e.errorMessage ? ` — ${e.errorMessage}` : ""}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
