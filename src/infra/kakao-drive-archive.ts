import { createHash, randomUUID } from 'node:crypto';
import type { DriveArchiveFile, DriveArchiveRequest, KakaoDriveArchivePort } from '../ports/kakao-archive.js';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const OWNER = 'pyh@teamjpk.com';
type Metadata = { id: string; name: string; mimeType: string; parents?: string[]; trashed?: boolean;
  driveId?: string; owners?: { emailAddress?: string }[]; appProperties?: Record<string, string> };
type Permission = DriveArchiveFile['permissions'][number];
const fields = 'id,name,mimeType,parents,trashed,driveId,owners(emailAddress),appProperties';
const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** No retries, sharing changes or credential acquisition. Transport is injected for offline tests. */
export class KakaoDriveArchive implements KakaoDriveArchivePort {
  private serial: Promise<unknown> = Promise.resolve();
  private uncertain = new Set<string>();
  constructor(private readonly rootId: string, private readonly token: () => Promise<string>,
    private readonly transport: typeof fetch = fetch) {
    if (!/^[\w-]+$/.test(rootId)) throw new Error('KAKAO_DRIVE_ROOT_REQUIRED');
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.transport(path.startsWith('https:') ? path : `${API}${path}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      });
    } catch { throw new Error('DRIVE_RESPONSE_UNKNOWN'); }
    if (response.status >= 500 || response.status === 408) throw new Error('DRIVE_RESPONSE_UNKNOWN');
    if (!response.ok) throw new Error('DRIVE_REQUEST_REJECTED');
    return response;
  }
  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    try { return await response.json() as T; } catch { throw new Error('DRIVE_RESPONSE_UNKNOWN'); }
  }
  private meta(id: string) {
    return this.json<Metadata>(`/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`);
  }
  private async list(q: string): Promise<Metadata[]> {
    const files: Metadata[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ q: `trashed = false and (${q})`, spaces: 'drive',
        fields: `nextPageToken,incompleteSearch,files(${fields})`, pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
      const page = await this.json<{ files?: Metadata[]; nextPageToken?: string; incompleteSearch?: boolean }>(`/files?${params}`);
      if (!Array.isArray(page.files) || page.incompleteSearch) throw new Error('DRIVE_SEARCH_INCOMPLETE');
      files.push(...page.files);
      pageToken = page.nextPageToken;
      if (pageToken && seen.has(pageToken)) throw new Error('DRIVE_SEARCH_INCOMPLETE');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return files;
  }
  private async acl(id: string) {
    const visited = new Set<string>();
    while (id) {
      if (visited.has(id) || visited.size > 100) throw new Error('DRIVE_PRIVATE_ACCESS_REQUIRED');
      visited.add(id);
      const meta = await this.meta(id);
      if (meta.id !== id || meta.trashed || meta.driveId || meta.owners?.length !== 1
        || meta.owners[0]?.emailAddress !== OWNER || (meta.parents?.length ?? 0) > 1)
        throw new Error('DRIVE_PRIVATE_ACCESS_REQUIRED');
      const permissions: Permission[] = [];
      let pageToken: string | undefined;
      const pages = new Set<string>();
      do {
        const params = new URLSearchParams({ fields: 'nextPageToken,permissions(type,role,emailAddress,domain,allowFileDiscovery)',
          pageSize: '100', ...(pageToken ? { pageToken } : {}) });
        const page = await this.json<{ permissions?: Permission[]; nextPageToken?: string }>(`/files/${encodeURIComponent(id)}/permissions?${params}`);
        if (!Array.isArray(page.permissions)) throw new Error('DRIVE_PRIVATE_ACCESS_REQUIRED');
        permissions.push(...page.permissions);
        pageToken = page.nextPageToken;
        if (pageToken && pages.has(pageToken)) throw new Error('DRIVE_PRIVATE_ACCESS_REQUIRED');
        if (pageToken) pages.add(pageToken);
      } while (pageToken);
      if (permissions.length !== 1 || permissions[0]?.type !== 'user' || permissions[0]?.role !== 'owner'
        || permissions[0]?.emailAddress !== OWNER) throw new Error('DRIVE_PRIVATE_ACCESS_REQUIRED');
      id = meta.parents?.[0] ?? '';
    }
    return { permissions: [{ type: 'user' as const, role: 'owner', emailAddress: OWNER }],
      permissionsComplete: true, ancestorPermissionsChecked: true };
  }
  private segments(directory: string) {
    const match = /^원문\/카카오톡\/([A-Za-z0-9_-]+)\/(\d{4}-(?:0[1-9]|1[0-2]))\/([a-f0-9]{64})\/$/.exec(directory);
    if (!match) throw new Error('DRIVE_DIRECTORY_INVALID');
    return match.slice(1);
  }
  private async child(parent: string, name: string) {
    const matches = await this.list(`${quote(parent)} in parents and name = ${quote(name)}`);
    if (matches.length > 1 || matches.some(m => m.mimeType !== FOLDER)) throw new Error('DRIVE_ARCHIVE_CONFLICT');
    return matches[0];
  }
  async inspectDestination(directory: string) {
    const segments = this.segments(directory);
    let parent = this.rootId;
    if ((await this.meta(parent)).mimeType !== FOLDER) throw new Error('DRIVE_DIRECTORY_INVALID');
    let acl = await this.acl(parent);
    for (const name of segments) {
      const child = await this.child(parent, name);
      if (!child) break;
      parent = child.id;
      acl = await this.acl(parent);
    }
    return acl;
  }
  async find(properties: DriveArchiveRequest['appProperties']) {
    this.checkProperties(properties);
    const matches = await this.list(`appProperties has { key='eventId' and value=${quote(properties.eventId)} } and appProperties has { key='sha256' and value=${quote(properties.sha256)} }`);
    // verify also rejects matching files outside the configured root.
    return Promise.all(matches.map(file => this.verify(file.id)));
  }
  private checkProperties(properties: DriveArchiveRequest['appProperties']) {
    if (![properties.eventId, properties.sha256].every(x => /^[a-f0-9]{64}$/.test(x))) throw new Error('DRIVE_PROPERTIES_INVALID');
  }
  upload(input: DriveArchiveRequest): Promise<{ id: string }> {
    const result = this.serial.then(() => this.uploadOnce(input));
    this.serial = result.catch(() => undefined);
    return result;
  }
  private async uploadOnce(input: DriveArchiveRequest) {
    this.checkProperties(input.appProperties);
    const names = this.segments(input.directory);
    if (names[2] !== input.appProperties.eventId || input.name !== input.appProperties.sha256
      || hash(input.bytes) !== input.appProperties.sha256 || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mediaType))
      throw new Error('DRIVE_UPLOAD_INVALID');
    await this.inspectDestination(input.directory);
    const existing = await this.find(input.appProperties);
    if (existing.length > 1) throw new Error('DRIVE_ARCHIVE_CONFLICT');
    if (existing.length === 1) {
      if (existing[0]!.directory !== input.directory) throw new Error('DRIVE_ARCHIVE_CONFLICT');
      return { id: existing[0]!.id };
    }
    let parent = this.rootId;
    for (const name of names) {
      let child = await this.child(parent, name);
      if (!child) {
        const key = `${parent}/${name}`;
        if (this.uncertain.has(key)) throw new Error('DRIVE_RESPONSE_UNKNOWN');
        await this.acl(parent);
        this.uncertain.add(key);
        child = await this.json<Metadata>(`/files?fields=${encodeURIComponent(fields)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
        });
        if (!child.id) throw new Error('DRIVE_RESPONSE_UNKNOWN');
        const resolved = await this.child(parent, name);
        if (resolved?.id !== child.id) throw new Error('DRIVE_ARCHIVE_CONFLICT');
        this.uncertain.delete(key);
      }
      parent = child.id;
      await this.acl(parent);
    }
    const key = `${input.appProperties.eventId}/${input.name}`;
    if (this.uncertain.has(key)) throw new Error('DRIVE_RESPONSE_UNKNOWN');
    const boundary = `kakao_${randomUUID()}`;
    const metadata = JSON.stringify({ name: input.name, parents: [parent], appProperties: input.appProperties });
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.mediaType}\r\n\r\n`),
      Buffer.from(input.bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    this.uncertain.add(key);
    const file = await this.json<{ id?: string }>('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    if (!file.id || !/^[\w-]+$/.test(file.id)) throw new Error('DRIVE_RESPONSE_UNKNOWN');
    // Keep the fence until a later find/verify proves the upload, including on this instance.
    return { id: file.id };
  }
  async verify(id: string): Promise<DriveArchiveFile> {
    const file = await this.meta(id);
    const acl = await this.acl(id);
    if (file.id !== id || file.mimeType === FOLDER || file.parents?.length !== 1) throw new Error('DRIVE_READBACK_FAILED');
    const names: string[] = [];
    let parent = file.parents[0]!;
    for (let depth = 0; parent !== this.rootId && depth < 4; depth++) {
      const folder = await this.meta(parent);
      if (folder.mimeType !== FOLDER || folder.parents?.length !== 1) throw new Error('DRIVE_READBACK_FAILED');
      names.unshift(folder.name); parent = folder.parents[0]!;
    }
    if (parent !== this.rootId || names.length !== 3) throw new Error('DRIVE_READBACK_FAILED');
    const directory = `원문/카카오톡/${names.join('/')}/`;
    this.segments(directory);
    const properties = { eventId: file.appProperties?.eventId ?? '', sha256: file.appProperties?.sha256 ?? '' };
    this.checkProperties(properties);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await (await this.request(`/files/${encodeURIComponent(id)}?alt=media`)).arrayBuffer()); }
    catch { throw new Error('DRIVE_RESPONSE_UNKNOWN'); }
    const sha256 = hash(bytes);
    if (names[2] !== properties.eventId || file.name !== properties.sha256 || sha256 !== properties.sha256)
      throw new Error('DRIVE_READBACK_FAILED');
    return { id, directory, sha256, appProperties: properties, ...acl };
  }
}
