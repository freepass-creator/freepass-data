import { stableDigest } from '../shared/stable-digest.js';
import {
  coverageStrength,
  findCoverageForHint,
  type VehicleMasterCoverageRow,
} from './vehicle-master-coverage.js';
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

function sourceSpecificUrlCandidates(
  html: string,
  sourceKey: VehicleMasterBackfillSourceKey
) {
  const rows: Array<{ href: string; label: string; index: number; end: number }> = [];
  const patterns: RegExp[] = sourceKey === 'CARNOON'
    ? [/\/newcar\/vehicle\/\d+\/?/g]
    : sourceKey === 'CARISYOU'
      ? [/\/car\/\d+(?:\/(?:Price|Spec))?\/?/gi]
      : sourceKey === 'DANAWA'
        ? [/\/newcar\/\?[^"'<>\s]*?(?:Work=estimate|Code=|Model=)[^"'<>\s]*/gi]
        : [];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (!match[0]) continue;
      rows.push({
        href: match[0].replaceAll('&amp;', '&'),
        label: '',
        index: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      });
    }
  }
  return rows;
}

export function discoverAdditionalVehicleMasterInventoryPages(input: {
  sourceKey: VehicleMasterBackfillSourceKey;
  inventoryUrl: string;
  bytes: Buffer;
}): string[] {
  const inventory = new URL(input.inventoryUrl);

  if (
    (input.sourceKey === 'CARNOON' || input.sourceKey === 'DANAWA') &&
    !inventory.pathname.endsWith('/sitemap.xml')
  ) {
    return [new URL('/sitemap.xml', inventory.origin).toString()];
  }

  if (input.sourceKey !== 'CARISYOU') return [];
  const html = input.bytes.toString('utf8');
  const ids = new Set<string>();

  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/\bname=["']srhBrandArry(?:\[\])?["']/i);
    const value = tag.match(/\bvalue=["'](\d+)["']/i);
    if (name && value?.[1]) ids.add(value[1]);
  }

  const queryPattern = /[?&]srhBrandArry=(\d+)/g;
  for (const match of html.matchAll(queryPattern)) {
    if (match[1]) ids.add(match[1]);
  }

  const additional = new Set<string>();
  const inventoryUrlPattern =
    /(?:https?:\/\/[^"'<>\s]+)?\/car\/\?[^"'<>\s]*(?:page|pageNo|start|offset|srhBrandArry)=[^"'<>\s]*/gi;
  for (const match of html.matchAll(inventoryUrlPattern)) {
    if (!match[0]) continue;
    try {
      const url = new URL(match[0].replaceAll('&amp;', '&'), input.inventoryUrl);
      if (url.hostname.endsWith('carisyou.com')) {
        additional.add(url.toString());
      }
    } catch {
      // ignore malformed discovery hints
    }
  }

  const brandPages = [...ids]
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => {
      const url = new URL(input.inventoryUrl);
      url.searchParams.set('srhBrandArry', id);
      return url.toString();
    });
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
  const acceptedUrls = new Set<string>();
  const candidates = [
    ...anchors(html),
    ...sourceSpecificUrlCandidates(html, input.sourceKey),
  ].sort((a, b) => a.index - b.index || a.href.localeCompare(b.href));

  for (const anchor of candidates) {
    let url: URL;
    try {
      url = new URL(anchor.href.replaceAll('&amp;', '&'), input.inventoryUrl);
    } catch {
      continue;
    }
    if (!acceptedDetailUrl(input.sourceKey, url)) continue;
    const key = url.toString();
    if (acceptedUrls.has(key)) continue;
    acceptedUrls.add(key);
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
    coverage?: readonly VehicleMasterCoverageRow[];
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

  const withCoverage = [...unique.values()].map((page) => {
    const coverage = findCoverageForHint(
      options.coverage ?? [],
      page.modelHint,
      page.latestModelYearHint
    );
    return {
      page,
      coverageStatus: coverage?.status ?? 'MISSING' as const,
      coverageStrength: coverage ? coverageStrength(coverage.status) : 0,
    };
  });

  const sorted = withCoverage.sort((a, b) => {
    const yearA = a.page.latestModelYearHint ?? -1;
    const yearB = b.page.latestModelYearHint ?? -1;
    if (yearA !== yearB) return yearB - yearA;
    if (a.coverageStrength !== b.coverageStrength) {
      return a.coverageStrength - b.coverageStrength;
    }
    if (a.page.currentHint !== b.page.currentHint) {
      return a.page.currentHint === true ? -1 : b.page.currentHint === true ? 1 : 0;
    }
    const priorityA = vehicleMasterBackfillPolicy(a.page.sourceKey).priority;
    const priorityB = vehicleMasterBackfillPolicy(b.page.sourceKey).priority;
    return priorityB - priorityA || a.page.sourceUrl.localeCompare(b.page.sourceUrl);
  });

  return sorted.map(({ page, coverageStatus }, index) => ({
    ...page,
    taskId: `vmbf_${stableDigest({
      sourceKey: page.sourceKey,
      sourceUrl: page.sourceUrl,
    }).slice(0, 24)}`,
    rank: index + 1,
    coverageStatus,
  }));
}
