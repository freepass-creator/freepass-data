import { stableDigest } from '../shared/stable-digest.js';
import {
  vehicleMasterBackfillPolicy,
  type VehicleMasterBackfillSourceKey,
  type VehicleMasterBackfillTask,
  type VehicleMasterDiscoveredPage,
} from '../domain/vehicle-master-backfill.js';

function decodeHtml(value: string) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function anchors(html: string) {
  const rows: Array<{ href: string; label: string; index: number; end: number }> = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    if (!match[1]) continue;
    rows.push({
      href: match[1],
      label: decodeHtml(match[2] ?? ''),
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return rows;
}

function yearHint(
  html: string,
  index: number,
  floor = 0,
  ceiling = html.length
) {
  const context = decodeHtml(
    html.slice(Math.max(floor, index - 1200), Math.min(ceiling, index + 300))
  );
  const years = [
    ...[...context.matchAll(/(?<!\d)(20\d{2})\s*년형/g)]
      .map((match) => Number(match[1])),
    ...[...context.matchAll(/(?<!\d)(\d{2})\s*년형/g)]
      .map((match) => 2000 + Number(match[1])),
  ].filter((value) => Number.isInteger(value) && value >= 1990 && value <= 2200);
  if (years.length) return Math.max(...years);

  const loose = [...context.matchAll(/\b(20\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value >= 1990 && value <= 2200);
  return loose.length ? Math.max(...loose) : null;
}

function modelHint(
  label: string,
  html: string,
  index: number,
  floor = 0
) {
  const generic = /^(상세\s*보기|견적\s*내기|신차\s*견적내기|Image)$/i;
  if (label && !generic.test(label)) return label;

  const context = decodeHtml(html.slice(Math.max(floor, index - 500), index));
  const chunks = context.split(/\s{2,}|\n/).map((value) => value.trim()).filter(Boolean);
  return chunks.at(-1)?.slice(-100) ?? null;
}

function acceptedDetailUrl(sourceKey: VehicleMasterBackfillSourceKey, url: URL) {
  if (sourceKey === 'CARNOON') {
    return /\/newcar\/vehicle\/\d+\/?$/.test(url.pathname);
  }
  if (sourceKey === 'DANAWA') {
    return (
      (url.hostname === 'auto.danawa.com' || url.hostname === 'mauto.danawa.com') &&
      url.pathname.startsWith('/newcar/') &&
      (
        url.searchParams.get('Work') === 'estimate' ||
        url.searchParams.has('Code') ||
        url.searchParams.has('Model')
      )
    );
  }
  if (sourceKey === 'CARISYOU') {
    return /^\/car\/\d+\/?$/.test(url.pathname);
  }
  return false;
}

export function discoverVehicleMasterPages(input: {
  sourceKey: VehicleMasterBackfillSourceKey;
  inventoryUrl: string;
  bytes: Buffer;
}): VehicleMasterDiscoveredPage[] {
  const policy = vehicleMasterBackfillPolicy(input.sourceKey);
  const html = input.bytes.toString('utf8');
  const discovered = new Map<string, VehicleMasterDiscoveredPage>();

  const accepted: Array<{
    anchor: ReturnType<typeof anchors>[number];
    url: URL;
  }> = [];
  for (const anchor of anchors(html)) {
    let url: URL;
    try {
      url = new URL(anchor.href.replaceAll('&amp;', '&'), input.inventoryUrl);
    } catch {
      continue;
    }
    if (!acceptedDetailUrl(input.sourceKey, url)) continue;
    accepted.push({ anchor, url });
  }

  for (const [position, { anchor, url }] of accepted.entries()) {
    const floor = accepted[position - 1]?.anchor.end ?? 0;
    const ceiling = anchor.end;
    const detailUrls =
      input.sourceKey === 'CARISYOU' && /^\/car\/\d+\/?$/.test(url.pathname)
        ? [
            new URL(`${url.pathname.replace(/\/$/, '')}/Price`, url.origin).toString(),
            new URL(`${url.pathname.replace(/\/$/, '')}/Spec`, url.origin).toString(),
          ]
        : [url.toString()];
    const hint = yearHint(html, anchor.index, floor, ceiling);
    const nearby = decodeHtml(
      html.slice(Math.max(floor, anchor.index - 700), Math.min(ceiling, anchor.index + 100))
    );
    const currentHint =
      /판매중|시판|신차|출시|사전계약/.test(nearby)
        ? true
        : /단종/.test(nearby)
          ? false
          : null;

    for (const sourceUrl of detailUrls) {
      if (discovered.has(sourceUrl)) continue;
      discovered.set(sourceUrl, {
        sourceKey: input.sourceKey,
        sourceType: policy.sourceType,
        sourceName: policy.sourceName,
        sourceUrl,
        discoveredFromUrl: input.inventoryUrl,
        modelHint: modelHint(anchor.label, html, anchor.index, floor),
        latestModelYearHint: hint,
        currentHint,
      });
    }
  }

  return [...discovered.values()];
}

export function buildRecentFirstBackfillQueue(
  pages: readonly VehicleMasterDiscoveredPage[],
  options: {
    completedUrls?: readonly string[];
    sourceKeys?: readonly VehicleMasterBackfillSourceKey[];
  } = {}
): VehicleMasterBackfillTask[] {
  const completed = new Set(options.completedUrls ?? []);
  const allowed = options.sourceKeys ? new Set(options.sourceKeys) : null;
  const unique = new Map<string, VehicleMasterDiscoveredPage>();

  for (const page of pages) {
    if (completed.has(page.sourceUrl)) continue;
    if (allowed && !allowed.has(page.sourceKey)) continue;
    const key = `${page.sourceKey}|${page.sourceUrl}`;
    if (!unique.has(key)) unique.set(key, page);
  }

  const sorted = [...unique.values()].sort((a, b) => {
    const yearA = a.latestModelYearHint ?? -1;
    const yearB = b.latestModelYearHint ?? -1;
    if (yearA !== yearB) return yearB - yearA;
    if (a.currentHint !== b.currentHint) {
      return a.currentHint === true ? -1 : b.currentHint === true ? 1 : 0;
    }
    const priorityA = vehicleMasterBackfillPolicy(a.sourceKey).priority;
    const priorityB = vehicleMasterBackfillPolicy(b.sourceKey).priority;
    return priorityB - priorityA || a.sourceUrl.localeCompare(b.sourceUrl);
  });

  return sorted.map((page, index) => ({
    ...page,
    taskId: `vmbf_${stableDigest({
      sourceKey: page.sourceKey,
      sourceUrl: page.sourceUrl,
    }).slice(0, 24)}`,
    rank: index + 1,
  }));
}
